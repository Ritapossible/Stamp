/**
 * Stamp's work for this agent. It asks the Stamp API for a decision ticket and passes it
 * through. No check is reimplemented here: the verdict comes from the engine behind
 * STAMP_API_URL, and the hash on the answer can be recomputed by anyone (GET /v1/tickets/:hash,
 * then POST /v1/verify).
 *
 * No LLM runs anywhere in this path. The paid /x402 route and the MCP tools both call
 * `stampTicket`, so a paid answer and a free answer for the same order are the same ticket.
 */

export const STAMP_API_URL = (process.env.STAMP_API_URL ?? "https://stamp-iizn.onrender.com").replace(/\/$/, "");
const TIMEOUT_MS = 45_000; // the free Render host can take ~30 s to wake

export type Issuer = "ondo" | "xstock" | "bstock";

export interface TicketRequest {
  intent: string;
  /** Which issuer's token to buy. null means the order must name it (NVDAon, NVDAx, NVDAB). */
  issuer?: Issuer | null;
}

/** What an agent needs to act on, plus the full ticket for anyone who wants every field. */
export interface StampAnswer {
  verdict: "ALLOW" | "WARN" | "BLOCK";
  reasons: string[];
  notes: string[];
  narration: string;
  hash: string;
  verifyUrl: string;
  chosen: { symbol: string; issuer: string; contractAddress: string } | null;
  ticket: Record<string, unknown>;
}

const ISSUERS = new Set(["ondo", "xstock", "bstock"]);

/**
 * The /x402 route hands us one prompt string. Accept either JSON
 * (`{"intent":"Buy $20 of NVIDIA","issuer":"ondo"}`) or the order itself as plain text.
 */
export function parseWorkPrompt(prompt: string): TicketRequest {
  const text = prompt.trim();
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StampInputError("prompt looks like JSON but does not parse");
    }
    const o = parsed as Record<string, unknown>;
    if (typeof o.intent !== "string") throw new StampInputError('JSON prompt needs "intent", e.g. {"intent":"Buy $20 of NVIDIA"}');
    return validate({ intent: o.intent, issuer: ("issuer" in o ? o.issuer : undefined) as Issuer | null | undefined });
  }
  return validate({ intent: text });
}

function validate(req: TicketRequest): TicketRequest {
  const intent = req.intent.trim();
  if (intent.length === 0 || intent.length > 200) throw new StampInputError("intent must be 1-200 characters");
  if (req.issuer !== undefined && req.issuer !== null && !ISSUERS.has(req.issuer)) {
    throw new StampInputError('issuer must be "ondo", "xstock", "bstock" or null');
  }
  return { intent, ...(req.issuer !== undefined ? { issuer: req.issuer } : {}) };
}

export class StampInputError extends Error {
  override name = "StampInputError";
}

export class StampUnavailableError extends Error {
  override name = "StampUnavailableError";
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${STAMP_API_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StampUnavailableError(`Stamp API unreachable: ${String((err as Error).message)}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 400 || res.status === 404) throw new StampInputError(String(json.error ?? `HTTP ${res.status}`));
  if (!res.ok) throw new StampUnavailableError(String(json.error ?? `HTTP ${res.status}`));
  return json;
}

/** One decision ticket from live Binance data. BLOCK and WARN are answers, not errors. */
export async function stampTicket(req: TicketRequest): Promise<StampAnswer> {
  const { intent, issuer } = validate(req);
  const body = { intent, ...(issuer !== undefined ? { policy: { issuer } } : {}) };
  const out = await call("POST", "/v1/tickets", body);
  const t = out.ticket as Record<string, unknown>;
  const chosen = t.chosen as { symbol: string; issuer: string; contractAddress: string } | null;
  return {
    verdict: t.verdict as StampAnswer["verdict"],
    reasons: t.reasons as string[],
    notes: t.notes as string[],
    narration: t.narration as string,
    hash: t.hash as string,
    verifyUrl: `${STAMP_API_URL}/proof/?hash=${String(t.hash)}`,
    chosen: chosen ? { symbol: chosen.symbol, issuer: chosen.issuer, contractAddress: chosen.contractAddress } : null,
    ticket: t,
  };
}

/** Recompute a ticket this Stamp server stored, from its recorded inputs. */
export async function stampVerify(hash: string): Promise<{ hash: string; matches: boolean | null; verdict: string; reasons: string[] }> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new StampInputError("hash must be 64 lowercase hex characters");
  const stored = await call("GET", `/v1/tickets/${hash}`);
  const v = await call("POST", "/v1/verify", { input: stored.input, ticket: stored.ticket });
  return { hash: v.hash as string, matches: v.matches as boolean | null, verdict: v.verdict as string, reasons: v.reasons as string[] };
}

/** The paid route's work: prompt in, ticket JSON out. */
export async function stampWork(prompt: string): Promise<string> {
  return JSON.stringify(await stampTicket(parseWorkPrompt(prompt)));
}
