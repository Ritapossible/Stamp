/**
 * Client for Binance's public RWA endpoints (no key). Every call:
 *   - sends the two headers the skill docs require,
 *   - times out after `timeoutMs`,
 *   - retries once on transport failure, non-2xx, or `data: null` (seen live for xStocks),
 *   - reports latency and attempts through `onCall`, for the DEVEX raw log.
 * It never interprets a missing value; callers see `ok: false` and decide.
 */

export const RWA_V1 = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa";
export const RWA_V2 = "https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa";
export const RWA_HEADERS = { "User-Agent": "binance-web3/1.1 (Skill)", "Accept-Encoding": "identity" } as const;

export interface Envelope<T> {
  code: string;
  success: boolean;
  data: T | null;
  message: string | null;
}

export interface RawListRow {
  chainId: string;
  contractAddress: string;
  symbol: string;
  ticker: string;
  type: number;
  assetType?: number;
  multiplier?: string;
  lastUpdateTime?: number;
  d?: number;
}

export interface RawStatusInfo {
  openState: boolean | null;
  marketStatus: string | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpenTime?: number | null;
  nextCloseTime?: number | null;
}

export interface RawDynamic {
  symbol: string;
  ticker: string;
  type: number;
  tokenInfo?: { price?: string | null; sharesMultiplier?: string | null; volume24h?: string | null } | null;
  stockInfo?: { price?: string | null } | null;
  statusInfo?: RawStatusInfo | null;
  limitInfo?: Record<string, string> | null;
}

export interface RawVenueStatus {
  marketStatus: string | null;
  openState: boolean | null;
  reasonCode?: string | null;
  reasonMsg?: string | null;
  nextOpen?: string | null;
  nextClose?: string | null;
}

export interface RawMeta {
  tokenId: string;
  name: string;
  symbol: string;
  ticker: string;
  [k: string]: unknown;
}

export interface Fetched<T> {
  ok: boolean;
  data: T | null;
  body: Envelope<T> | null;
  httpStatus: number | null;
  latencyMs: number;
  attempts: number;
  error: string | null;
  url: string;
}

export interface CallRecord {
  url: string;
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  attempts: number;
  error: string | null;
  at: string;
}

export interface RwaClientOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  onCall?: (c: CallRecord) => void;
  now?: () => number;
}

export class RwaClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly onCall: ((c: CallRecord) => void) | undefined;
  private readonly now: () => number;

  constructor(opts: RwaClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.onCall = opts.onCall;
    this.now = opts.now ?? (() => performance.now());
  }

  list(): Promise<Fetched<RawListRow[]>> {
    return this.get(`${RWA_V1}/stock/detail/list/ai`);
  }

  venueStatus(): Promise<Fetched<RawVenueStatus>> {
    return this.get(`${RWA_V1}/market/status/ai`);
  }

  dynamic(contractAddress: string, chainId = "56"): Promise<Fetched<RawDynamic>> {
    return this.get(`${RWA_V2}/dynamic/ai?chainId=${chainId}&contractAddress=${contractAddress}`);
  }

  assetStatus(contractAddress: string, chainId = "56"): Promise<Fetched<RawStatusInfo>> {
    return this.get(`${RWA_V1}/asset/market/status/ai?chainId=${chainId}&contractAddress=${contractAddress}`);
  }

  meta(contractAddress: string, chainId = "56"): Promise<Fetched<RawMeta>> {
    return this.get(`${RWA_V1}/meta/ai?chainId=${chainId}&contractAddress=${contractAddress}`);
  }

  private async get<T>(url: string): Promise<Fetched<T>> {
    const started = this.now();
    let result: Fetched<T> = { ok: false, data: null, body: null, httpStatus: null, latencyMs: 0, attempts: 0, error: "not attempted", url };
    for (let attempt = 1; attempt <= 2; attempt++) {
      result = await this.once<T>(url, attempt);
      if (result.ok) break;
      if (attempt === 1 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
    }
    result.latencyMs = Math.round(this.now() - started);
    this.onCall?.({
      url,
      ok: result.ok,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      error: result.error,
      at: new Date().toISOString(),
    });
    return result;
  }

  private async once<T>(url: string, attempt: number): Promise<Fetched<T>> {
    const base = { url, attempts: attempt, latencyMs: 0 };
    try {
      const res = await this.fetchFn(url, { headers: RWA_HEADERS, signal: AbortSignal.timeout(this.timeoutMs) });
      let body: Envelope<T> | null = null;
      try {
        body = (await res.json()) as Envelope<T>;
      } catch {
        return { ...base, ok: false, data: null, body: null, httpStatus: res.status, error: "response is not JSON" };
      }
      if (!res.ok) return { ...base, ok: false, data: null, body, httpStatus: res.status, error: `HTTP ${res.status}` };
      if (body?.success !== true) return { ...base, ok: false, data: null, body, httpStatus: res.status, error: `success=${String(body?.success)} code=${body?.code}` };
      if (body.data === null || body.data === undefined) return { ...base, ok: false, data: null, body, httpStatus: res.status, error: "data: null" };
      return { ...base, ok: true, data: body.data, body, httpStatus: res.status, error: null };
    } catch (err) {
      return { ...base, ok: false, data: null, body: null, httpStatus: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }
}
