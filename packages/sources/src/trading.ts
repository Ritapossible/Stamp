/**
 * Binance Web3 Trading API client (key required; live execution path only).
 * Docs: https://web3.binance.com/en/dev-docs/products/trading-api/integration-flow.md
 *
 * Auth: X-OC-APIKEY, X-OC-TIMESTAMP (ISO-8601 ms), X-OC-SIGN =
 *   Base64(HMAC-SHA256(timestamp + METHOD + path-with-/build-and-query + body, secret))
 *
 * Response field names beyond those in the docs (quoteId, executionMode, vendorName,
 * rfq.typedDataToSign, rfq.orderId, data.tx) are NOT known yet. The parsers below look for
 * them explicitly and fail loudly when absent; plan Day 6 records the first real payloads
 * and pins the names. Nothing here guesses an amount.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { QuoteView, SimulationResult } from "@stamp/engine";
import { approveCalldata, erc20Allowance } from "./bsc.js";
import type { OrderStatus, PreparedOrder, QuoteRequest, StockWallet } from "./wallet.js";

export const TRADING_BASE = "https://web3.binance.com/build";
const BSC = "56";
const NATIVE_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function signRequest(secret: string, timestamp: string, method: string, pathWithQuery: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${method.toUpperCase()}${pathWithQuery}${body}`).digest("base64");
}

export interface TradingApiOptions {
  apiKey: string;
  secret: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  onCall?: (c: { method: string; path: string; status: number | null; latencyMs: number; error: string | null }) => void;
}

export class TradingApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class TradingApiClient {
  private readonly base: string;
  private readonly basePath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: TradingApiOptions) {
    this.base = opts.baseUrl ?? TRADING_BASE;
    this.basePath = new URL(this.base).pathname.replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  get<T = unknown>(path: string, query: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    return this.call<T>("GET", qs ? `${path}?${qs}` : path, "");
  }

  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.call<T>("POST", path, JSON.stringify(body));
  }

  private async call<T>(method: string, pathWithQuery: string, body: string): Promise<T> {
    const timestamp = this.now().toISOString();
    const signedPath = `${this.basePath}${pathWithQuery}`;
    const headers: Record<string, string> = {
      "X-OC-APIKEY": this.opts.apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signRequest(this.opts.secret, timestamp, method, signedPath, body),
    };
    if (body) headers["Content-Type"] = "application/json";
    const started = performance.now();
    let status: number | null = null;
    try {
      const res = await this.fetchFn(`${this.base}${pathWithQuery}`, {
        method,
        headers,
        body: body || null,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      status = res.status;
      const json = (await res.json().catch(() => null)) as { code?: string | number; msg?: string; message?: string; data?: unknown } | null;
      const ok = res.ok && json !== null && (json.code === undefined || String(json.code) === "0" || String(json.code) === "000000");
      this.opts.onCall?.({ method, path: pathWithQuery, status, latencyMs: Math.round(performance.now() - started), error: ok ? null : String(json?.msg ?? json?.message ?? json?.code ?? `HTTP ${status}`) });
      if (!ok) throw new TradingApiError(`${method} ${pathWithQuery}: ${json?.msg ?? json?.message ?? `HTTP ${status}`} (code ${json?.code})`, status, json);
      return json as T;
    } catch (err) {
      if (err instanceof TradingApiError) throw err;
      this.opts.onCall?.({ method, path: pathWithQuery, status, latencyMs: Math.round(performance.now() - started), error: String(err) });
      throw new TradingApiError(String(err), status, null);
    }
  }
}

type Json = Record<string, unknown>;

function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) cur = cur && typeof cur === "object" ? (cur as Json)[k] : undefined;
  return cur;
}

function firstData(res: unknown): Json {
  const d = pick(res, "data");
  const item = Array.isArray(d) ? d[0] : d;
  if (!item || typeof item !== "object") throw new TradingApiError("response has no data", null, res);
  return item as Json;
}

function requireString(v: unknown, what: string, res: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new TradingApiError(`response has no ${what}`, null, res);
  return v;
}

/**
 * Live wallet over the Trading API. It never signs: `prepare` returns the typed data for the
 * human's wallet, and `submit` forwards that signature. Output amounts are read only from
 * explicitly named fields; an unknown response shape is an error, not a guess.
 */
export class TradingApiWallet implements StockWallet {
  readonly name = "binance-trading-api";

  private readonly rawQuotes = new Map<string, unknown>();

  constructor(
    private readonly client: TradingApiClient,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly allowance: (token: string, owner: string, spender: string) => Promise<bigint> = erc20Allowance,
  ) {}

  async quote(req: QuoteRequest): Promise<QuoteView> {
    const res = await this.client.get("/api/v1/dex/aggregator/quote", {
      binanceChainId: BSC,
      fromTokenAddress: req.fromToken,
      toTokenAddress: req.toToken,
      amount: req.amountInRaw,
      userWalletAddress: req.user,
    });
    const d = firstData(res);
    const mode = d.executionMode === "RFQ" ? "RFQ" : d.executionMode === "SWAP" ? "SWAP" : null;
    if (!mode) throw new TradingApiError(`unknown executionMode ${String(d.executionMode)}`, null, res);
    const out = d.toTokenAmount ?? pick(d, "toToken", "amount") ?? d.amountOut;
    if (typeof d.quoteId === "string") this.rawQuotes.set(d.quoteId, res);
    return {
      quoteId: requireString(d.quoteId, "quoteId", res),
      quotedAt: this.now(),
      executionMode: mode,
      vendor: typeof d.vendorName === "string" ? d.vendorName : null,
      fromToken: req.fromToken.toLowerCase(),
      toToken: req.toToken.toLowerCase(),
      amountInRaw: req.amountInRaw,
      amountOutRaw: requireString(out, "output amount (toTokenAmount)", res),
      fromDecimals: 18,
      toDecimals: 18,
    };
  }

  async prepare(quote: QuoteView, user: string, slippageBps: number): Promise<PreparedOrder> {
    const res = await this.client.get("/api/v1/dex/aggregator/swap", {
      quoteId: quote.quoteId,
      binanceChainId: BSC,
      fromTokenAddress: quote.fromToken,
      toTokenAddress: quote.toToken,
      amount: quote.amountInRaw,
      userWalletAddress: user,
      slippagePercent: String(slippageBps / 100),
    });
    const d = firstData(res);
    const raw: Record<string, unknown> = { quote: this.rawQuotes.get(quote.quoteId) ?? null, swap: res };
    if (quote.executionMode === "RFQ") {
      const typedData = pick(d, "rfq", "typedDataToSign");
      if (!typedData) throw new TradingApiError("RFQ response has no rfq.typedDataToSign", null, res);
      return { mode: "RFQ", typedData, tx: null, orderId: requireString(pick(d, "rfq", "orderId"), "rfq.orderId", res), approvalTx: null, approvalRequired: false, raw };
    }
    const tx = (d.tx ?? null) as { to?: string } | null;
    if (!tx || typeof tx.to !== "string") throw new TradingApiError("SWAP response has no tx", null, res);

    // Who pulls the USDT: Binance's approve-transaction endpoint names it (dexContractAddress);
    // fall back to the router the swap calls. Approve exactly this order's amount, never unlimited.
    let spender = tx.to;
    try {
      const ap = await this.client.get("/api/v1/dex/aggregator/approve-transaction", {
        binanceChainId: BSC,
        tokenContractAddress: quote.fromToken,
        approveAmount: quote.amountInRaw,
      });
      raw.approve = ap;
      const named = pick(firstData(ap), "dexContractAddress");
      if (typeof named === "string" && /^0x[0-9a-fA-F]{40}$/.test(named)) spender = named;
    } catch (err) {
      raw.approveError = err instanceof Error ? err.message : String(err);
    }
    const allowance = await this.allowance(quote.fromToken, user, spender);
    const approvalRequired = allowance < BigInt(quote.amountInRaw);
    const approvalTx = approvalRequired ? { from: user, to: quote.fromToken, value: "0", data: approveCalldata(spender, quote.amountInRaw) } : null;
    return { mode: "SWAP", typedData: null, tx, orderId: null, approvalTx, approvalRequired, raw };
  }

  /**
   * The docs page names the body field `evmTx`; the live API answers "evmParams is required for
   * EVM chains" (2026-09-29). Both are sent. Only an explicit SUCCESS counts as a pass.
   */
  async simulate(tx: unknown, user: string): Promise<SimulationResult> {
    const t = (tx ?? {}) as { from?: string; to?: string; value?: string | number; data?: string };
    const evm = { from: t.from ?? user, to: t.to, value: String(t.value ?? "0"), data: t.data ?? "0x" };
    try {
      const res = await this.client.post("/api/v1/dex/pre-transaction/simulate", { binanceChainId: BSC, evmParams: evm, evmTx: evm });
      const d = pick(res, "data");
      const status = String(pick(d, "status") ?? "").toUpperCase();
      const changes = pick(d, "balanceChanges");
      const balanceChanges = Array.isArray(changes)
        ? changes
            .filter((c) => c && typeof c === "object")
            .map((c) => ({ contractAddress: String((c as Json).contractAddress ?? ""), owner: String((c as Json).owner ?? ""), change: String((c as Json).change ?? "") }))
        : null;
      if (status === "SUCCESS" || status === "SUCCEED" || status === "SUCCEEDED") return { ok: true, error: null, balanceChanges };
      return { ok: false, error: String(pick(d, "failReason") ?? (status ? `status ${status}` : "no status in simulate response")), balanceChanges };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async submit(i: { quote: QuoteView; orderId: string; signature: string }): Promise<{ orderId: string }> {
    const res = await this.client.post("/api/v1/dex/aggregator/order/submit", {
      userSignature: i.signature,
      vendor: i.quote.vendor,
      quoteId: i.orderId,
      requestId: randomUUID(),
    });
    const d = pick(res, "data");
    return { orderId: typeof pick(d, "orderId") === "string" ? (pick(d, "orderId") as string) : i.orderId };
  }

  /**
   * Wallet API: POST /api/v1/dex/balance/token-balances-by-address, up to 20 (chain, token)
   * pairs; "" asks for native BNB. Reads data[].tokenAssets[].balance (a decimal string).
   */
  async balances(user: string, tokens: string[]): Promise<{ balances: Record<string, string>; raw: unknown }> {
    const res = await this.client.post("/api/v1/dex/balance/token-balances-by-address", {
      address: user,
      tokenContractAddresses: tokens.map((t) => ({ binanceChainId: BSC, tokenContractAddress: t })),
    });
    const out: Record<string, string> = {};
    const groups = pick(res, "data");
    for (const g of Array.isArray(groups) ? groups : []) {
      const assets = pick(g, "tokenAssets");
      for (const a of Array.isArray(assets) ? assets : []) {
        const chain = String(pick(a, "binanceChainId") ?? "");
        const token = pick(a, "tokenContractAddress");
        const balance = pick(a, "balance");
        if (chain === BSC && typeof token === "string" && typeof balance === "string" && /^\d+(\.\d+)?$/.test(balance)) {
          // Asked for native BNB with "" (as documented), the API answers with the 0xeee… placeholder.
          out[token.toLowerCase() === NATIVE_PLACEHOLDER ? "" : token.toLowerCase()] = balance;
        }
      }
    }
    return { balances: out, raw: res };
  }

  async txStatus(txHash: string): Promise<OrderStatus> {
    const res = await this.client.get("/api/v1/dex/post-transaction/transaction-detail-by-txhash", { binanceChainId: BSC, txHash });
    const d = pick(res, "data");
    const item = Array.isArray(d) ? d[0] : d;
    const s = String(pick(item, "txStatus") ?? "").toLowerCase();
    return s === "success" ? "FILLED" : s === "fail" || s === "failed" ? "FAILED" : "PENDING";
  }

  async status(orderId: string): Promise<OrderStatus> {
    const res = await this.client.get(`/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`, {});
    const s = String(pick(res, "data", "status") ?? pick(res, "data", "orderStatus") ?? "").toUpperCase();
    return s === "FILLED" ? "FILLED" : s === "FAILED" ? "FAILED" : "PENDING";
  }
}
