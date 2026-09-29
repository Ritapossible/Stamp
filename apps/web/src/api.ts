/** Shapes the page reads. The engine's own types are richer; the page only needs these fields. */
export type Verdict = "ALLOW" | "WARN" | "BLOCK";

export interface Ticket {
  kind: "decision";
  asOf: string;
  intent: { raw: string; query?: string; unit?: string; amount?: string };
  chosen: { symbol: string; ticker: string; issuer: string; contractAddress: string } | null;
  rejected: Array<{ symbol: string; issuer: string; contractAddress: string; reason: string }>;
  session: string | null;
  sessionSource: string | null;
  marketStatus: string | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  multiplier: string | null;
  listMultiplier: string | null;
  tokenPriceUsd: string | null;
  economicPriceUsd: string | null;
  referenceUsd: string | null;
  referenceSource: string | null;
  referenceAsOf: string | null;
  referenceSibling: string | null;
  premiumBps: number | null;
  overpayUsd: string | null;
  notionalUsd: string | null;
  tokenUnits: string | null;
  economicShares: string | null;
  unitReadings: { asTokens: { tokens: string; shares: string; usd: string }; asShares: { tokens: string; shares: string; usd: string } } | null;
  verdict: Verdict;
  reasons: string[];
  notes: string[];
  hash: string;
  narration: string;
}

export interface ExecutionTicket {
  verdict: Verdict;
  reasons: string[];
  hash: string;
  narration: string;
  amountInUsd: string | null;
  amountOutTokens: string | null;
  economicShares: string | null;
  quotedAt: string;
  symbol: string | null;
}

export interface Tx {
  from?: string | null;
  to: string;
  value?: string;
  data: string;
}

export interface ExecView {
  ticket: ExecutionTicket & { executionMode: "RFQ" | "SWAP" };
  typedData: unknown | null;
  tx: Tx | null;
  approvalTx: Tx | null;
  submittedOrderId: string | null;
  txHash: string | null;
  status: string | null;
  settledAt: string | null;
}

export interface ReplayRow {
  set: string;
  name: string;
  intent: string;
  symbol: string | null;
  verdict: Verdict;
  reasons: string[];
  premiumBps: number | null;
  overpayUsd: string | null;
  hash: string;
  ok: boolean;
}

export interface Summary {
  instruments: number;
  byIssuer: { ondo: number; xstock: number; bstock: number };
  tickers: number;
  multiIssuerTickers: number;
  largestMultipliers: Array<{ symbol: string; ticker: string; multiplier: string }>;
}

export interface StandingOrder {
  id: string;
  intent: string;
  user: string;
  state: string;
  lastDecisionHash: string | null;
  executionHash: string | null;
  expiresAt: string | null;
  filledUsd: string | null;
  events: Array<{ at: string; state: string; note: string; ticketHash: string | null }>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
  return json as T;
}

export const api = {
  ticket: (intent: string, issuer: string | null) =>
    call<{ ticket: Ticket; verify: string }>("POST", "/v1/tickets", { intent, policy: { issuer } }),
  replay: () => call<{ ok: boolean; count: number; drifted: number; rows: ReplayRow[] }>("GET", "/v1/replay"),
  summary: () => call<Summary>("GET", "/v1/summary"),
  review: (decisionHash: string, user: string) => call<ExecView & { wallet: string }>("POST", "/v1/execution", { decisionHash, user }),
  submit: (hash: string, signature: string) => call<ExecView>("POST", `/v1/execution/${hash}/submit`, { signature }),
  sent: (hash: string, txHash: string) => call<ExecView>("POST", `/v1/execution/${hash}/sent`, { txHash }),
  execution: (hash: string) => call<ExecView>("GET", `/v1/execution/${hash}`),
  standingSent: (id: string, txHash: string) => call<StandingOrder>("POST", `/v1/standing/${id}/sent`, { txHash }),
  standing: () => call<{ orders: StandingOrder[]; filledTodayUsd: string }>("GET", "/v1/standing"),
  createStanding: (intent: string, user: string) => call<StandingOrder>("POST", "/v1/standing", { intent, user }),
  standingAction: (id: string, action: "recheck" | "review" | "cancel") => call<StandingOrder>("POST", `/v1/standing/${id}/${action}`),
};
