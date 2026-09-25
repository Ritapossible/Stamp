/**
 * Snapshotter — records reference prices and raw off-hours payloads.
 *
 * One tick:
 *   1. GET the RWA universe list and the venue market status.
 *   2. For every BSC Ondo / xStock / bStock version of the watched tickers, GET dynamic
 *      (it carries tokenInfo, stockInfo and statusInfo in one response).
 *   3. Append one line per ticker to <out>/snapshots/YYYY-MM-DD.jsonl (always).
 *   4. Outside the regular session (and around the close), write the raw payloads to
 *      <out>/captures/YYYY-MM-DD/HHMMSS.json for weekend replay fixtures.
 *
 * Every value is stored as the API returned it (strings stay strings). Nothing is judged
 * here: reference.ts later picks the last row whose venueMarketStatus was "regular".
 *
 * Usage:
 *   npx tsx scripts/snapshot.ts [--out data] [--raw auto|always|never] [--loop 600]
 *
 * Temporary home: moves onto packages/sources (rwa.ts, snapshots.ts) on plan Day 3.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const WATCHLIST = [
  "NVDA", "NFLX", "AAPL", "TSLA", "MSFT", "GOOGL", "AMZN", "META", "MU", "AVGO",
  "KLAC", "CRWD", "NOW", "CVNA", "SPY", "QQQ", "ORCL", "AMD", "COIN", "PLTR",
] as const;

const BSC = "56";
const ISSUER_BY_TYPE: Record<number, "ondo" | "xstock" | "bstock"> = { 1: "ondo", 2: "xstock", 3: "bstock" };
const BASE_V1 = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa";
const BASE_V2 = "https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa";
const HEADERS = { "User-Agent": "binance-web3/1.1 (Skill)", "Accept-Encoding": "identity" };
const TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

interface Envelope<T> { code: string; success: boolean; data: T | null; message: string | null }
interface ListRow { chainId: string; contractAddress: string; symbol: string; ticker: string; type: number; multiplier?: string }
interface StatusInfo {
  openState: boolean | null; marketStatus: string | null; reasonCode: string | null;
  reasonMsg: string | null; nextOpenTime: number | null; nextCloseTime: number | null;
}
interface Dynamic {
  symbol: string; ticker: string; type: number;
  tokenInfo?: { price?: string | null; sharesMultiplier?: string | null };
  stockInfo?: { price?: string | null } | null;
  statusInfo?: StatusInfo | null;
}
interface VenueStatus { marketStatus: string | null; openState: boolean | null; nextOpen: string | null; nextClose: string | null }

interface Fetched<T> { ok: boolean; status: number | null; latencyMs: number; attempts: number; body: Envelope<T> | null; error: string | null }

async function getJson<T>(url: string): Promise<Fetched<T>> {
  const started = performance.now();
  let attempts = 0;
  let last: Fetched<T> = { ok: false, status: null, latencyMs: 0, attempts: 0, body: null, error: "not attempted" };
  // One retry, on transport failure or on `data: null` (seen live for xStocks on 2026-09-25).
  while (attempts < 2) {
    attempts++;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = (await res.json()) as Envelope<T>;
      last = { ok: res.ok && body.success === true && body.data !== null, status: res.status, latencyMs: 0, attempts, body, error: null };
      if (!res.ok) last.error = `HTTP ${res.status}`;
      else if (body.data === null) last.error = "data: null";
    } catch (err) {
      last = { ok: false, status: null, latencyMs: 0, attempts, body: null, error: String(err) };
    }
    if (last.ok) break;
    if (attempts < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  last.latencyMs = Math.round(performance.now() - started);
  return last;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Raw capture policy for `--raw auto`: off-hours every ~30 min, and every tick around the close. */
export function shouldCaptureRaw(mode: string, venueMarketStatus: string | null, now: Date): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  const minutesUtc = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nearClose = minutesUtc >= 19 * 60 + 50 && minutesUtc <= 20 * 60 + 20; // 19:50–20:20 UTC (EDT close)
  const halfHourSlot = now.getUTCMinutes() % 30 < 10;
  return nearClose || (venueMarketStatus !== "regular" && halfHourSlot);
}

export async function tick(outDir: string, rawMode: string, now = new Date()): Promise<{ failures: number; lines: number }> {
  const capturedAt = now.toISOString();
  const day = capturedAt.slice(0, 10);

  const [list, venue] = await Promise.all([
    getJson<ListRow[]>(`${BASE_V1}/stock/detail/list/ai`),
    getJson<VenueStatus>(`${BASE_V1}/market/status/ai`),
  ]);
  if (!list.ok || !list.body?.data) throw new Error(`list failed: ${list.error} (status ${list.status})`);

  const watch = new Set<string>(WATCHLIST);
  const instruments = list.body.data.filter(
    (r) => r.chainId === BSC && watch.has(r.ticker) && ISSUER_BY_TYPE[r.type] !== undefined,
  );

  const dynamics = await mapLimit(instruments, CONCURRENCY, async (row) => ({
    row,
    res: await getJson<Dynamic>(`${BASE_V2}/dynamic/ai?chainId=${BSC}&contractAddress=${row.contractAddress}`),
  }));

  const venueData = venue.body?.data ?? null;
  const lines: string[] = [];
  let failures = venue.ok ? 0 : 1;

  for (const ticker of WATCHLIST) {
    const mine = dynamics.filter((d) => d.row.ticker === ticker);
    if (mine.length === 0) continue;
    // Order: ondo, xstock, bstock — the first non-null stockInfo.price is the ticker's print.
    mine.sort((a, b) => a.row.type - b.row.type);
    const tokens = mine.map(({ row, res }) => {
      if (!res.ok) failures++;
      const d = res.body?.data ?? null;
      return {
        symbol: row.symbol,
        issuer: ISSUER_BY_TYPE[row.type],
        contractAddress: row.contractAddress,
        listMultiplier: row.multiplier ?? null,
        ok: res.ok,
        error: res.error,
        latencyMs: res.latencyMs,
        attempts: res.attempts,
        tokenPrice: d?.tokenInfo?.price ?? null,
        sharesMultiplier: d?.tokenInfo?.sharesMultiplier ?? null,
        stockPrice: d?.stockInfo?.price ?? null,
        openState: d?.statusInfo?.openState ?? null,
        marketStatus: d?.statusInfo?.marketStatus ?? null,
        reasonCode: d?.statusInfo?.reasonCode ?? null,
        reasonMsg: d?.statusInfo?.reasonMsg ?? null,
      };
    });
    const withPrint = tokens.find((t) => t.stockPrice !== null) ?? null;
    lines.push(
      JSON.stringify({
        capturedAt,
        ticker,
        venueMarketStatus: venueData?.marketStatus ?? null,
        venueOpenState: venueData?.openState ?? null,
        stockPrice: withPrint?.stockPrice ?? null,
        stockPriceFrom: withPrint?.symbol ?? null,
        tokens,
      }),
    );
  }

  await mkdir(join(outDir, "snapshots"), { recursive: true });
  await appendFile(join(outDir, "snapshots", `${day}.jsonl`), lines.map((l) => `${l}\n`).join(""));

  if (shouldCaptureRaw(rawMode, venueData?.marketStatus ?? null, now)) {
    const dir = join(outDir, "captures", day);
    await mkdir(dir, { recursive: true });
    const stamp = capturedAt.slice(11, 19).replaceAll(":", "");
    await writeFile(
      join(dir, `${stamp}.json`),
      `${JSON.stringify({
        capturedAt,
        venue: venue.body,
        venueLatencyMs: venue.latencyMs,
        dynamic: Object.fromEntries(
          dynamics.map(({ row, res }) => [row.contractAddress, { symbol: row.symbol, latencyMs: res.latencyMs, attempts: res.attempts, error: res.error, body: res.body }]),
        ),
      })}\n`,
    );
  }

  console.log(
    `${capturedAt} venue=${venueData?.marketStatus ?? "?"} tickers=${lines.length} instruments=${instruments.length} failures=${failures} list=${list.latencyMs}ms`,
  );
  return { failures, lines: lines.length };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: "data" },
      raw: { type: "string", default: "auto" },
      loop: { type: "string" },
    },
  });
  const out = values.out!;
  const raw = values.raw!;
  if (!["auto", "always", "never"].includes(raw)) throw new Error(`--raw must be auto|always|never`);

  if (values.loop === undefined) {
    await tick(out, raw);
    return;
  }
  const everyMs = Number.parseInt(values.loop, 10) * 1000;
  if (!Number.isFinite(everyMs) || everyMs < 60_000) throw new Error("--loop takes seconds, minimum 60");
  for (;;) {
    try {
      await tick(out, raw);
    } catch (err) {
      console.error(`${new Date().toISOString()} tick failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
