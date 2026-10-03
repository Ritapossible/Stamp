/**
 * Stamp in front of the Binance Agentic Wallet. The agent's wallet only swaps after Stamp says
 * ALLOW, and the fill is checked on BSC afterwards.
 *
 *   npm run agentic -- "Buy $20 of NVIDIA"              # decide → quote → confirm → swap → verify fill
 *   npm run agentic -- "Buy $20 of NVDAB" --issuer bstock
 *   npm run agentic -- "Buy $20 of NVIDIA" --dry-run    # stop after the execution ticket
 *
 * Needs `baw` (npm i -g @binance/agentic-wallet) signed in on THIS machine (`baw auth signin`,
 * confirmed in the Binance App). Run it outside the US: Binance refuses US callers.
 * Nothing is swapped without typing "yes" (or --yes). Every run is appended to
 * data/agentic/runs.jsonl.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DECISION_MAX_AGE_SEC,
  DEFAULT_POLICY,
  type DecisionTicket,
  type ExecutionTicket,
  type FillTicket,
  type Issuer,
  type Policy,
  prepareAgenticExecution,
  verifyFill,
} from "@stamp/engine";
import { type AgenticOrder, AgenticWallet, BSC_USDT, type BscReceipt, bawRunner, erc20Decimals, txReceipt } from "@stamp/sources";

export interface AgenticDeps {
  wallet: AgenticWallet;
  fetchTicket(intent: string, issuer: Issuer | null | undefined): Promise<DecisionTicket>;
  receipt(txHash: string): Promise<BscReceipt | null>;
  decimals(token: string): Promise<number>;
  confirm(question: string): Promise<boolean>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface AgenticRun {
  intent: string;
  stoppedAt: "decision" | "unsupported" | "execution" | "dry-run" | "declined" | "stale" | "order" | "fill";
  decision: DecisionTicket;
  execution: ExecutionTicket | null;
  orderId: string | null;
  order: AgenticOrder | null;
  fill: FillTicket | null;
}

/** Issuers Binance documents for Agentic Wallet stock trading. */
export const AGENTIC_ISSUERS = new Set(["ondo", "bstock"]);

export class NotSignedInError extends Error {
  override name = "NotSignedInError";
  constructor() {
    super("The Agentic Wallet is not signed in on this machine. Run `baw auth signin`, confirm in the Binance App, then try again.");
  }
}

export async function runAgenticBuy(intent: string, opts: { issuer?: Issuer | null | undefined; dryRun?: boolean }, deps: AgenticDeps): Promise<AgenticRun> {
  const policy: Policy = { ...DEFAULT_POLICY, ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}) } as Policy;
  const run: AgenticRun = { intent, stoppedAt: "decision", decision: await deps.fetchTicket(intent, opts.issuer), execution: null, orderId: null, order: null, fill: null };
  deps.log(`decision   ${run.decision.narration}`);
  // A WARN or BLOCK never reaches the wallet: no baw call is made at all.
  if (run.decision.verdict !== "ALLOW" || !run.decision.chosen || !run.decision.notionalUsd) return run;
  // Binance's Agentic Wallet stock-trading guide covers bStock and Ondo tokens only
  // (developers.binance.com/en/docs/products/agentic-wallet/use-cases/trading/stock-trading).
  if (!AGENTIC_ISSUERS.has(run.decision.chosen.issuer)) {
    run.stoppedAt = "unsupported";
    deps.log(`stopped    The Agentic Wallet trades bStock and Ondo tokens; ${run.decision.chosen.symbol} is ${run.decision.chosen.issuer}. Nothing was sent to baw. Use the web page with Binance Wallet for this one.`);
    return run;
  }

  if (!(await deps.wallet.connected())) throw new NotSignedInError();
  const user = await deps.wallet.bscAddress();
  const order = {
    usd: run.decision.notionalUsd,
    fromToken: BSC_USDT,
    toToken: run.decision.chosen.contractAddress,
    slippagePct: String(policy.maxSlippageBps / 100),
  };
  const check = async () => prepareAgenticExecution({ decision: run.decision, policy, asOf: deps.now().toISOString(), user, quote: await deps.wallet.quote(order), quoteAsset: BSC_USDT });

  run.stoppedAt = "execution";
  run.execution = await check();
  deps.log(`execution  ${run.execution.narration}`);
  if (run.execution.verdict !== "ALLOW") return run;
  if (opts.dryRun) {
    run.stoppedAt = "dry-run";
    return run;
  }
  if (!(await deps.confirm(`Swap $${order.usd} USDT for ${run.decision.chosen.symbol} (${order.toToken}) in the Agentic Wallet ${user}?`))) {
    run.stoppedAt = "declined";
    return run;
  }
  // The person may have taken a while: quote and check again right before the swap.
  run.execution = await check();
  if (run.execution.verdict !== "ALLOW") {
    run.stoppedAt = run.execution.reasons[0] === "DECISION_STALE" ? "stale" : "execution";
    deps.log(`execution  ${run.execution.narration}${run.stoppedAt === "stale" ? ` (decisions last ${DECISION_MAX_AGE_SEC} s; run it again)` : ""}`);
    return run;
  }

  run.stoppedAt = "order";
  run.orderId = await deps.wallet.swap(order);
  deps.log(`submitted  order ${run.orderId} - not a fill until it finishes on chain`);
  for (let i = 0; i < 40; i++) {
    run.order = await deps.wallet.order(run.orderId);
    if (run.order.status !== "PENDING") break;
    await deps.sleep(3000);
  }
  if (!run.order || run.order.status === "PENDING") {
    deps.log(`order      still PENDING after ~2 min; check with: baw market-order list --orderId ${run.orderId} --json`);
    return run;
  }

  let receipt: BscReceipt | null = null;
  if (run.order.status === "FINISHED" && run.order.txHash) {
    for (let i = 0; i < 20 && !receipt; i++) {
      receipt = await deps.receipt(run.order.txHash);
      if (!receipt) await deps.sleep(3000);
    }
  }
  run.stoppedAt = "fill";
  run.fill = verifyFill({
    decision: run.decision,
    policy,
    asOf: deps.now().toISOString(),
    user,
    orderStatus: run.order.status,
    txHash: run.order.txHash,
    receiptStatus: receipt?.status ?? null,
    logs: receipt?.logs ?? [],
    tokenDecimals: await deps.decimals(run.decision.chosen.contractAddress),
    quoteAsset: BSC_USDT,
    quoteDecimals: await deps.decimals(BSC_USDT),
  });
  deps.log(`fill       ${run.fill.narration}${run.order.txHash ? `\n           https://bscscan.com/tx/${run.order.txHash}` : ""}`);
  return run;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      issuer: { type: "string" },
      api: { type: "string", default: process.env.STAMP_API_URL ?? "https://stamp-iizn.onrender.com" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  const intent = positionals.join(" ").trim();
  if (!intent) {
    console.error('usage: npm run agentic -- "Buy $20 of NVIDIA" [--issuer ondo|xstock|bstock|none] [--dry-run] [--yes]');
    process.exit(64);
  }
  const issuer = values.issuer === undefined ? undefined : values.issuer === "none" ? null : (values.issuer as Issuer);
  const api = values.api!.replace(/\/$/, "");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const deps: AgenticDeps = {
    wallet: new AgenticWallet(bawRunner()),
    fetchTicket: async (text, iss) => {
      const res = await fetch(`${api}/v1/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: text, ...(iss !== undefined ? { policy: { issuer: iss } } : {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res.json()) as { ticket?: DecisionTicket; error?: string };
      if (!res.ok || !json.ticket) throw new Error(`Stamp API ${res.status}: ${json.error ?? "no ticket"}`);
      return json.ticket;
    },
    receipt: (tx) => txReceipt(tx),
    decimals: (token) => erc20Decimals(token),
    confirm: async (q) => values.yes || (await rl.question(`${q}\nType "yes" to swap: `)).trim().toLowerCase() === "yes",
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  };
  let run: AgenticRun;
  try {
    run = await runAgenticBuy(intent, { issuer, dryRun: values["dry-run"] }, deps);
  } finally {
    rl.close();
  }
  await mkdir("data/agentic", { recursive: true });
  await appendFile("data/agentic/runs.jsonl", `${JSON.stringify({ at: new Date().toISOString(), api, ...run })}\n`);
  console.log(`\nstopped at: ${run.stoppedAt} · recorded in data/agentic/runs.jsonl`);
  process.exit(run.fill?.verified || run.stoppedAt === "dry-run" ? 0 : run.stoppedAt === "fill" ? 1 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
