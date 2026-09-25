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
import { buildUniverse, RwaClient } from "@stamp/sources";

export const WATCHLIST = [
  "NVDA", "NFLX", "AAPL", "TSLA", "MSFT", "GOOGL", "AMZN", "META", "MU", "AVGO",
  "KLAC", "CRWD", "NOW", "CVNA", "SPY", "QQQ", "ORCL", "AMD", "COIN", "PLTR",
] as const;

const BSC = "56";
const ISSUER_BY_TYPE: Record<number, "ondo" | "xstock" | "bstock"> = { 1: "ondo", 2: "xstock", 3: "bstock" };
const CONCURRENCY = 6;

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

export async function tick(outDir: string, rawMode: string, now = new Date(), client = new RwaClient()): Promise<{ failures: number; lines: number }> {
  const capturedAt = now.toISOString();
  const day = capturedAt.slice(0, 10);

  const [list, venue] = await Promise.all([client.list(), client.venueStatus()]);
  if (!list.ok || !list.data) throw new Error(`list failed: ${list.error} (status ${list.httpStatus})`);

  const watch = new Set<string>(WATCHLIST);
  const instruments = buildUniverse(list.data).rows.filter(
    (r) => r.chainId === BSC && watch.has(r.ticker) && ISSUER_BY_TYPE[r.type] !== undefined,
  );

  const dynamics = await mapLimit(instruments, CONCURRENCY, async (row) => ({ row, res: await client.dynamic(row.contractAddress) }));

  const venueData = venue.data;
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
        // The list rows these instruments were classified from, so a capture replays on its own.
        universe: instruments,
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
  if (!["auto", "always", "never"].includes(raw)) throw new Error("--raw must be auto|always|never");

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
