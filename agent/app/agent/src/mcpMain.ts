/**
 * Single MCP seller agent entrypoint (the `--protocol MCP` peer to main.ts).
 *
 * This is the VALUABLE agent AND the SOLE key-holder/signer, serving its
 * seller surface over the **Model Context Protocol** instead of A2A. AWS
 * Bedrock AgentCore hosts MCP natively: it expects a streamable-HTTP MCP
 * server on `0.0.0.0:8000/mcp` and wraps the protocol (session isolation,
 * inbound OAuth/Cognito auth, scale-to-zero) exactly as it does for A2A.
 * There is no separate forwarding service - the agent IS the seller.
 *
 * MCP tools (all backed by signing.ts fixed code - NEVER LLM-callable):
 *
 *     negotiate      → read the FIXED list price → CLAMP to [min,max] → EIP-191 SIGN
 *                      the offer (no LLM). A message signature; no on-chain tx, no nonce.
 *     notify_funded  → verify the funded job carries THIS agent's signed quote →
 *                      produce the deliverable (LLM) → submitResult (SIGN + broadcast
 *                      on-chain) - all **synchronously within this one tool call**,
 *                      then return the on-chain result.
 *     + the read-only chain tools (wallet / balances / ERC-8004 / ERC-8183 /
 *       block / tx / contract-view), so an MCP client can inspect state.
 *
 * ## How delivery works under MCP (synchronous, ≤ ~15 min)
 *
 * A2A acks then finishes the work + on-chain `submit` in a background task
 * kept alive by reporting `HEALTHY_BUSY` to AgentCore's `/ping`. An MCP
 * server has no such hook (its only liveness is the platform's `/mcp/`
 * probe). So under MCP the documented long-running pattern is
 * **synchronous**: `notify_funded` does the whole verify → LLM work → submit
 * **inside the single tool invocation** (AgentCore allows a synchronous
 * request to run up to ~15 minutes), using MCP progress notifications as a
 * heartbeat to keep the connection alive across the steps. The runtime is
 * therefore **stateful** (per-session `StreamableHTTPServerTransport`,
 * routed by `Mcp-Session-Id`) so progress notifications work. Node's async
 * chain/signing calls never block the event loop, so the platform's
 * liveness probe stays responsive during the call.
 *
 * ## Boundaries (do NOT cross - they are the whole point)
 *
 * - ALL on-chain SIGNING is FIXED code in `signing.ts` - NEVER an
 *   MCP/LLM-callable signing tool. There is no raw `sign(...)` tool: only
 *   the bounded `negotiate` (sign a quote) and `notify_funded` (submit a
 *   verified, funded job) sign, and the LLM only produces the deliverable
 *   TEXT inside `notify_funded`.
 * - The price is a FIXED list price from studio.toml (clamped before signing).
 * - The chain tools exposed here are READ-ONLY.
 *
 * You own this file - specialise the work prompt / dispatch, but keep signing
 * bounded to these two ops and keep the read tools read-only.
 * In dual-face mode this file is imported as a library by dualMain.ts; main()
 * runs only when mcpMain itself is the selected entrypoint.
 */

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  loadStudioToml,
  type TomlTable,
} from "@bnbagent/studio-runtime/config";
import { maskUrlSecrets } from "@bnbagent/studio-runtime/audit";
import * as cr from "@bnbagent/studio-runtime/tools";
import {
  ensureAltanaSessionLoaded,
  ensureKeystoreMaterialized,
  ensureTwakMaterialized,
  getWallet,
} from "@bnbagent/studio-runtime/wallet";
import {
  createEnvelopeMiddleware,
  b402SellPath,
  type B402HttpRequest,
  B402Seller,
} from "@bnbagent/studio-runtime/b402";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveStorageMode } from "@bnbagent/studio-runtime/storage";
import express from "express";
import { z } from "zod";
import {
  isCommerceRateLimitError,
  limitCommerceOperation,
  requestLimitContext,
} from "./requestLimits.js";
import {
  DeliveryTimeoutError,
  deliveryTimeoutSeconds,
  minimumDeliveryWindowSeconds,
  withTimeout,
} from "./deliveryPolicy.js";
import * as signing from "./signing.js";
import { precheckOrder, promptFromRequest, StampInputError, StampUnavailableError, stampTicket, stampVerify, stampWork } from "./stamp.js";
import { FileReplayStore } from "./replayStore.js";
import { READ_TOOL_CATALOG, type ReadToolName } from "./readToolCatalog.js";

const APP_NAME = "agent";
function safeLogText(value: unknown): string {
  const text =
    value instanceof Error
      ? (value.stack ?? `${value.name}: ${value.message}`)
      : String(value ?? "");
  return maskUrlSecrets(text);
}

const log = {
  info: (msg: string) => console.log(`[seller-agent.mcp] ${safeLogText(msg)}`),
  error: (msg: string, e?: unknown) =>
    console.error(
      `[seller-agent.mcp] ERROR ${safeLogText(msg)}`,
      safeLogText(e),
    ),
};

function protocolFailure(scope: string, error: unknown): never {
  log.error(scope, error);
  throw new Error("seller operation failed; retry later");
}

// ── Runtime secrets ───────────────────────────────────────────────────────────
// Keep plaintext secrets OUT of agentcore.json. When BNBAGENT_RUNTIME_SECRET_ID
// is set (deployed runtime), pull a JSON {ENV_NAME: value} blob from AWS
// Secrets Manager into the process env BEFORE anything reads it. No-op
// locally. In a deployed runtime the managed secret bundle is authoritative
// and replaces any stale spec-level value left by an earlier revision.
async function loadRuntimeSecrets(): Promise<void> {
  const secretId = process.env.BNBAGENT_RUNTIME_SECRET_ID;
  if (!secretId) {
    return;
  }
  const resp = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const bundle = JSON.parse(resp.SecretString ?? "{}") as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(bundle)) {
    process.env[key] = String(value);
  }
  const pieverseKey = process.env.PIEVERSE_LLM_API_KEY;
  if (pieverseKey) {
    const fingerprint = createHash("sha256")
      .update(pieverseKey, "utf-8")
      .digest("hex")
      .slice(0, 12);
    log.info(
      `runtime secret PIEVERSE_LLM_API_KEY source=secretsmanager sha256=${fingerprint}…`,
    );
  }
}

/**
 * The project-wide default network (`[network].default`) - tool calls that
 * omit `network` fall back to it, never to a hardcoded name.
 */
function defaultNetwork(): string {
  try {
    const cfg = loadStudioToml();
    return String(
      ((cfg.network ?? {}) as Record<string, unknown>).default ?? "bsc-testnet",
    );
  } catch {
    return "bsc-testnet";
  }
}

/**
 * Deliverable `generator` label: this seller's own name from studio.toml
 * `[project].name` (minus the `-agent` suffix). Best-effort.
 */
function generatorTag(): string {
  let name = "";
  try {
    const cfg = loadStudioToml();
    name = String(((cfg.project ?? {}) as Record<string, unknown>).name ?? "");
  } catch {
    // a metadata label must never break delivery
    return APP_NAME;
  }
  return name.endsWith("-agent")
    ? name.slice(0, -"-agent".length)
    : name || APP_NAME;
}

function hasErc8183Rail(cfg: TomlTable): boolean {
  const payments = asTable(cfg.payments);
  const rail = asTable(payments?.erc8183);
  return rail !== null && rail.enabled !== false;
}

function asTable(value: unknown): TomlTable | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TomlTable)
    : null;
}

function flatHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") out[name] = value;
    else if (value !== undefined) out[name] = value[0] ?? "";
  }
  return out;
}

function flatQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

// ── LLM work hook (lazy: built on first authorized task) ─────────────────────
// Deferred construction keeps negotiate and unpaid payment challenge paths from
// building the model, and keeps this module importable without the provider
// env until a deliverable is actually produced.
export type McpRunWork = (
  prompt: string,
  context: { sessionId: string; abortSignal?: AbortSignal },
) => Promise<string>;

/**
 * The delivery hook. Stamp's work is deterministic: the prompt is an order, the answer is a
 * Stamp decision ticket from the Stamp API (see ./stamp.ts). No LLM runs here. Payment has
 * already settled when this runs, so a bad order or an unreachable Stamp API comes back as a
 * JSON error the buyer can read, not as a bare 500.
 */
export function buildRunWork(): McpRunWork {
  return async (prompt) => {
    try {
      return await stampWork(prompt);
    } catch (e) {
      if (e instanceof StampInputError || e instanceof StampUnavailableError) {
        return JSON.stringify({ error: e.message, kind: e.name });
      }
      throw e;
    }
  };
}

// ── MCP server ────────────────────────────────────────────────────────────────

/** Normalise a job_id (`0x..` / decimal string / number) to int. */
function parseJobId(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return Number(BigInt(String(raw).trim()));
}

// Commerce tools are NOT read-only (they sign / move on-chain state via fixed
// signing.ts code). There is no raw signing tool - only these two bounded ops.
const COMMERCE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true };
const READONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

/** MCP tool result: the JSON payload as text content (+ the log mirror). */
function toolResult(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** The narrow `extra` surface the progress heartbeat needs. */
interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
    };
  }) => Promise<void>;
}

/** Heartbeat: report step progress when the client sent a progressToken. */
async function reportProgress(
  extra: ProgressExtra,
  progress: number,
  total: number,
): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    return;
  }
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken: token, progress, total },
  });
}

/** Build the seller MCP server, gating commerce tools on the ERC-8183 rail. */
export function buildMcpServer(
  opts: { commerceSkills?: boolean; runWork?: McpRunWork } = {},
): McpServer {
  const server = new McpServer({ name: "stamp", version: "0.1.0" });
  const runWork = opts.runWork ?? buildRunWork();

  // ── Commerce tools (signing is FIXED code in signing.ts) ──────────────────
  if (opts.commerceSkills !== false) {
    server.registerTool(
    "negotiate",
    {
      description:
        "Return a wallet-signed ERC-8183 price quote for a task. " +
        "Rule-based: the price is FIXED by studio.toml (canonical per-asset " +
        "price_usd, or a legacy single price CLAMPED to [min,max]) BEFORE " +
        "EIP-191 signing - a hostile request can never sign out of bounds. " +
        "No LLM. Anchor the returned envelope on-chain (createJob + fund), then " +
        "call `notify_funded` with the job_id. `terms` MUST include both " +
        '"deliverables" and "quality_standards" (the on-chain evaluator requires ' +
        "them); a request missing either is rejected unsigned.",
      inputSchema: {
        task_description: z.string(),
        terms: z.record(z.unknown()).optional(),
      },
      annotations: COMMERCE_ANNOTATIONS,
    },
    // Error contract (unified with the A2A executor): an unexpected fault
    // becomes an MCP `isError` result with a generic public message; its full
    // detail is logged server-side. Classified quota exhaustion is returned
    // as a normal retry result and never as a fake quote.
    async ({ task_description, terms }) => {
      try {
        await limitCommerceOperation("negotiate");
        const request = { task_description, terms: terms ?? {} };
        return toolResult(await signing.signQuote(request));
      } catch (e) {
        if (isCommerceRateLimitError(e)) {
          return toolResult({
            status: "retry",
            reason: "seller rate limit exceeded",
          });
        }
        return protocolFailure("negotiate failed", e);
      }
    },
    );

    server.registerTool(
    "notify_funded",
    {
      description:
        "Verify a funded job, produce the deliverable, and submit it on-chain - " +
        'synchronously. The buyer\'s "I funded job X - deliver it" call. Runs the ' +
        "whole flow inside this one tool invocation (AgentCore permits ~15 min; " +
        "progress notifications keep the connection warm). Returns the on-chain " +
        "result; the buyer can also read it back from the chain (SUBMITTED / " +
        'get_deliverable_url). Verify-failure status is split: "rejected" is ' +
        "TERMINAL - this agent did not sign it, the terms were tampered, it is " +
        'underfunded or expired - re-calling will not help. "retry" is TRANSIENT ' +
        "(e.g. a chain read failed); the deal may be fine, so the buyer SHOULD " +
        "re-call.",
      inputSchema: { job_id: z.union([z.number().int(), z.string()]) },
      annotations: COMMERCE_ANNOTATIONS,
    },
    async ({ job_id }, extra) => {
      try {
        await limitCommerceOperation("notify_funded");
      } catch (e) {
        if (isCommerceRateLimitError(e)) {
          return toolResult({
            status: "retry",
            reason: "seller rate limit exceeded",
          });
        }
        return protocolFailure("notify_funded limiter failed", e);
      }
      let jid: number;
      try {
        jid = parseJobId(job_id);
      } catch {
        return toolResult({
          status: "rejected",
          error: `invalid job_id: ${JSON.stringify(job_id)}`,
        });
      }

      const deadlineMs = Date.now() + deliveryTimeoutSeconds() * 1000;

      // 1/4 - verify the funded job carries THIS agent's signed quote
      // (eth_calls). Honour the `permanent` flag: a permanent failure is
      // terminal ("rejected"); a transient one (chain read hiccup) is
      // "retry" so the buyer re-calls.
      await reportProgress(extra, 1, 4);
      let verdict: { ok: boolean; reason: string; permanent: boolean };
      try {
        verdict = await withTimeout(
          signing.verifySignedJob(jid, minimumDeliveryWindowSeconds()),
          Math.max(0.001, (deadlineMs - Date.now()) / 1000),
        );
      } catch (e) {
        // a failed verify is transient; tell the buyer to retry
        log.error(`verify of job ${jid} failed`, e);
        return toolResult({
          status: "retry",
          job_id: jid,
          reason: "chain verification temporarily unavailable",
        });
      }
      if (!verdict.ok) {
        return toolResult({
          status: verdict.permanent ? "rejected" : "retry",
          job_id: jid,
          reason: verdict.permanent
            ? verdict.reason
            : "chain verification temporarily unavailable",
        });
      }

      // Bound only the cancellable work phase. Once submit starts, its
      // broadcast outcome can be ambiguous: the request still has a total
      // deadline, but a submit timeout is UNKNOWN and must be reconciled on
      // chain rather than reported as safe to retry.
      const controller = new AbortController();
      let submitStarted = false;
      let res: { submitTx: string; deliverableUrl: string | null };
      try {
        const work = await withTimeout(
          (async () => {
            // 2/4 - produce the deliverable (THE ONLY LLM CALL).
            await reportProgress(extra, 2, 4);
            const spec = await signing.jobSpec(jid);
            const task =
              spec !== null
                ? JSON.stringify({ task: spec.task, terms: spec.terms })
                : `job ${jid}`;
            const prompt =
              "You accepted and were paid for the following job. Produce the deliverable " +
              `now. Be complete and self-contained.\n\nJOB CONTEXT:\n${task}`;
            return runWork(prompt, {
              sessionId: String(jid),
              abortSignal: controller.signal,
            });
          })(),
          Math.max(0.001, (deadlineMs - Date.now()) / 1000),
          controller,
        );

        // 3/4 - sign + broadcast submit (re-verifies FUNDED inside). Await
        // the definitive result within the remaining request window. The
        // opaque SDK operation cannot be cancelled after broadcast.
        await reportProgress(extra, 3, 4);
        const remainingSeconds = (deadlineMs - Date.now()) / 1000;
        if (remainingSeconds <= 0) {
          throw new DeliveryTimeoutError("delivery deadline reached");
        }
        submitStarted = true;
        res = await withTimeout(
          signing.submitResult(jid, work, {
            job_id: jid,
            generator: generatorTag(),
            built_with: "https://github.com/bnb-chain/bnbagent-studio",
          }),
          remainingSeconds,
        );
      } catch (e) {
        if (e instanceof DeliveryTimeoutError) {
          if (submitStarted) {
            return toolResult({
              status: "unknown",
              job_id: jid,
              reason:
                "submit outcome is unknown; poll the job on-chain and do not retry until reconciled",
            });
          }
          return toolResult({
            status: "retry",
            job_id: jid,
            reason: `delivery timed out after ${deliveryTimeoutSeconds()}s`,
          });
        }
        if (
          e instanceof Error &&
          e.name === "SubmitPermanentlyUnsupportedError"
        ) {
          // Deterministic for this wallet kind - submit can never succeed.
          return toolResult({
            status: "rejected",
            job_id: jid,
            skip: true,
            reason: "seller wallet does not support result submission",
          });
        }
        return protocolFailure(`delivery of job ${jid} failed`, e);
      }

      // 4/4 - done
      await reportProgress(extra, 4, 4);
      return toolResult({
        status: "submitted",
        job_id: jid,
        tx_hash: res.submitTx,
        deliverable_url: res.deliverableUrl,
      });
    },
    );
  }

  // ── Stamp tools (read-only: they decide, they never sign or trade) ────────
  server.registerTool(
    "stamp_ticket",
    {
      description:
        "Check a tokenized-stock buy order on BSC before anything is signed. Returns a Stamp " +
        "decision ticket: ALLOW, WARN or BLOCK, with reason codes, a plain-English narration and a " +
        "sha256 hash anyone can recompute. Checks, in order: the issuer is never switched (NVDAon, " +
        "NVDAx and NVDAB are different products), the share count behind one token (NFLXon = 10 " +
        "shares; a bare 'Buy 1 NFLX' is BLOCK UNIT_AMBIGUOUS), halts, and the off-hours premium over " +
        "the last official close. Only act on ALLOW. Examples: 'Buy $20 of NVIDIA', " +
        "'Buy 2 shares of Netflix'. issuer: 'ondo' (default), 'xstock', 'bstock', or null to make " +
        "the order name the token.",
      inputSchema: {
        intent: z.string().min(1).max(200),
        issuer: z.enum(["ondo", "xstock", "bstock"]).nullable().optional(),
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ intent, issuer }) => {
      try {
        return toolResult({ ...(await stampTicket({ intent, ...(issuer !== undefined ? { issuer } : {}) })) });
      } catch (e) {
        if (e instanceof StampInputError || e instanceof StampUnavailableError) {
          return { ...toolResult({ error: e.message, kind: e.name }), isError: true };
        }
        return protocolFailure("stamp_ticket failed", e);
      }
    },
  );

  server.registerTool(
    "stamp_verify",
    {
      description:
        "Recompute a Stamp ticket from the exact inputs it was decided from, and say whether the " +
        "hash still matches. Use it on any ticket hash another agent or person hands you.",
      inputSchema: { hash: z.string().regex(/^[0-9a-f]{64}$/) },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ hash }) => {
      try {
        return toolResult({ ...(await stampVerify(hash)) });
      } catch (e) {
        if (e instanceof StampInputError || e instanceof StampUnavailableError) {
          return { ...toolResult({ error: e.message, kind: e.name }), isError: true };
        }
        return protocolFailure("stamp_verify failed", e);
      }
    },
  );

  // ── Read-only chain tools ──────────────────────────────────────────────────
  const roConfig = <Name extends ReadToolName>(name: Name) => ({
    description: READ_TOOL_CATALOG[name].description,
    inputSchema: READ_TOOL_CATALOG[name].inputSchema,
    annotations: READONLY_ANNOTATIONS,
  });
  type ReadArgs<Name extends ReadToolName> = z.infer<
    z.ZodObject<(typeof READ_TOOL_CATALOG)[Name]["inputSchema"]>
  >;

  server.registerTool(
    "wallet_info",
    roConfig("wallet_info"),
    async () => toolResult(await cr.walletInfo()),
  );
  server.registerTool(
    "wallet_list",
    roConfig("wallet_list"),
    async () => toolResult(await cr.walletList()),
  );
  server.registerTool(
    "wallet_address",
    roConfig("wallet_address"),
    async () => toolResult({ address: await cr.walletAddress() }),
  );
  server.registerTool(
    "balance_native",
    roConfig("balance_native"),
    async (a: ReadArgs<"balance_native">) =>
      toolResult(
        await cr.balanceNative(a.address ?? null, a.network ?? defaultNetwork()),
      ),
  );
  server.registerTool(
    "balance_u",
    roConfig("balance_u"),
    async (a: ReadArgs<"balance_u">) =>
      toolResult(
        await cr.balanceU(a.address ?? null, a.network ?? defaultNetwork()),
      ),
  );
  server.registerTool(
    "pieverse_usage",
    roConfig("pieverse_usage"),
    async (a: ReadArgs<"pieverse_usage">) =>
      toolResult(await cr.pieverseUsage(a.days ?? 7)),
  );
  server.registerTool(
    "agent_info",
    roConfig("agent_info"),
    async (a: ReadArgs<"agent_info">) =>
      toolResult(await cr.agentInfo(a.agent_id, a.network ?? defaultNetwork())),
  );
  server.registerTool(
    "agent_by_address",
    roConfig("agent_by_address"),
    async (a: ReadArgs<"agent_by_address">) =>
      toolResult(
        await cr.agentByAddress(a.address, a.network ?? defaultNetwork()),
      ),
  );
  server.registerTool(
    "job_status",
    roConfig("job_status"),
    async (a: ReadArgs<"job_status">) =>
      toolResult(await cr.jobStatus(a.job_id, a.network ?? defaultNetwork())),
  );
  server.registerTool(
    "job_list",
    roConfig("job_list"),
    async (a: ReadArgs<"job_list">) =>
      toolResult(
        await cr.jobList({
          limit: a.limit,
          mine: a.mine,
          network: a.network ?? defaultNetwork(),
        }),
      ),
  );
  server.registerTool(
    "job_count",
    roConfig("job_count"),
    async (a: ReadArgs<"job_count">) =>
      toolResult(await cr.jobCount(a.network ?? defaultNetwork())),
  );
  server.registerTool(
    "tx_status",
    roConfig("tx_status"),
    async (a: ReadArgs<"tx_status">) =>
      toolResult(await cr.txStatus(a.tx_hash, a.network ?? defaultNetwork())),
  );
  server.registerTool(
    "block_info",
    roConfig("block_info"),
    async (a: ReadArgs<"block_info">) =>
      toolResult(
        await cr.blockInfo(a.block ?? "latest", a.network ?? defaultNetwork()),
      ),
  );
  server.registerTool(
    "contract_call_view",
    roConfig("contract_call_view"),
    async (a: ReadArgs<"contract_call_view">) =>
      toolResult(
        await cr.contractCallView(
          a.address,
          a.function_signature,
          (a.args ?? null) as unknown[] | null,
          a.output_types ?? null,
          a.network ?? defaultNetwork(),
        ),
      ),
  );
  server.registerTool(
    "network_info",
    roConfig("network_info"),
    async (a: ReadArgs<"network_info">) =>
      toolResult(await cr.networkInfo(a.network ?? defaultNetwork())),
  );

  return server;
}

// ── serving ───────────────────────────────────────────────────────────────────

/**
 * Serve the MCP server as **stateful** streamable-HTTP on `/mcp` (the
 * AgentCore MCP contract: 0.0.0.0:8000/mcp; `AGENT_PORT` is the local
 * override). Stateful - one transport per `Mcp-Session-Id` - so progress
 * notifications during the multi-step `notify_funded` delivery reach the
 * caller; AgentCore routes the session to one microVM via the same header.
 */
async function main(): Promise<void> {
  await loadRuntimeSecrets();

  // Wallet material is NEVER bundled into the deploy artifact. `bag deploy`
  // injects it via Secrets Manager and these calls (run once at cold start,
  // before any signing) materialize it on disk. Each is a no-op for the
  // other wallet kind and locally, where the wallet already lives on disk.
  ensureKeystoreMaterialized();
  ensureTwakMaterialized();
  await ensureAltanaSessionLoaded();

  const cfg = loadStudioToml();
  const rails = { erc8183: hasErc8183Rail(cfg) };
  if (rails.erc8183) resolveStorageMode(cfg);
  const sellPath = b402SellPath(cfg);
  const host = process.env.AGENT_BIND_HOST || "0.0.0.0";
  const port = Number(process.env.AGENT_PORT || "8000");
  const runWork = buildRunWork();
  // Durable replay guard: a restart must not forget which payments were already used.
  // B402_REPLAY_FILE lets a host put it on its persistent disk.
  const replayStore = new FileReplayStore(process.env.B402_REPLAY_FILE ?? ".stamp-data/b402-replay.json");
  const seller = await B402Seller.create({
    replayStore,
    cfg,
    runWork: ({ prompt }) => runWork(prompt, { sessionId: "b402" }),
    walletAddress: getWallet().address,
    resourceUrl: `${
      process.env.AGENTCORE_RUNTIME_URL ?? `http://localhost:${port}`
    }${sellPath}`,
  });

  const app = express();
  app.use(requestLimitContext);

  if (seller.state !== "disabled") {
    app.all(
      sellPath,
      express.text({ type: "*/*", limit: "1mb" }),
      async (req, res) => {
        const request: B402HttpRequest = {
          method: req.method,
          path: req.path,
          query: flatQuery(req.query),
          headers: flatHeaders(req.headers),
          body:
            typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body ?? ""),
        };
        try {
          await limitCommerceOperation("sell");
        } catch (error) {
          res.status(isCommerceRateLimitError(error) ? 429 : 503)
            .json({ error: "seller request limit reached" });
          return;
        }
        // Refuse, for free, anything the paid work couldn't answer: B402 settles before the work.
        const check = await precheckOrder(promptFromRequest(request));
        if (!check.ok) {
          res.status(check.status).json({ error: check.error, charged: false });
          return;
        }
        const out = await seller.handle(request);
        res.status(out.status).set(out.headers).send(out.body);
      },
    );
  }

  app.use(express.json({ limit: "8mb" }));
  app.use(createEnvelopeMiddleware({ port }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;
    if (transport === undefined) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session" },
          id: null,
        });
        return;
      }
      // New session: stateful transport keyed by Mcp-Session-Id.
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = t;
        },
      });
      t.onclose = () => {
        if (t.sessionId !== undefined) {
          delete transports[t.sessionId];
        }
      };
      await buildMcpServer({
        commerceSkills: rails.erc8183,
        runWork,
      }).connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, host, () => {
    log.info(`MCP serving on ${host}:${port}/mcp`);
  });
}

// Run only as an entrypoint, never on import (tests import buildMcpServer).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    log.error("fatal", e);
    process.exit(1);
  });
}
