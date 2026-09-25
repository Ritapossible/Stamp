import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OfficialClose } from "@stamp/engine";

/** One line of data/snapshots/YYYY-MM-DD.jsonl, as written by scripts/snapshot.ts. */
export interface SnapshotRow {
  capturedAt: string;
  ticker: string;
  venueMarketStatus: string | null;
  venueOpenState?: boolean | null;
  stockPrice: string | null;
  stockPriceFrom: string | null;
  tokens?: unknown[];
}

export function parseSnapshotLines(text: string): { rows: SnapshotRow[]; bad: number } {
  const rows: SnapshotRow[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SnapshotRow;
      if (typeof r.capturedAt !== "string" || typeof r.ticker !== "string") throw new Error("shape");
      rows.push(r);
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

/**
 * Reference store for when stockInfo.price is null (bStocks; possibly everyone on weekends).
 * `lastOfficialClose` is the last stock price recorded while the venue said `regular`, or the
 * `paused` print that immediately follows one: at the 16:00 close Binance pauses "for session
 * transition" and that print is the closing price (on 2026-09-25 it was 41 bps away from the
 * 19:50 regular print). With a 10-minute cadence it is not the auction tape; tickets label
 * the source and its time.
 */
export class SnapshotStore {
  private readonly byTicker = new Map<string, SnapshotRow[]>();

  constructor(rows: SnapshotRow[]) {
    const all = new Map<string, SnapshotRow[]>();
    for (const r of rows) {
      const list = all.get(r.ticker) ?? [];
      list.push(r);
      all.set(r.ticker, list);
    }
    for (const [ticker, list] of all) {
      list.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
      const kept: SnapshotRow[] = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i]!;
        if (typeof r.stockPrice !== "string") continue;
        const afterRegular = i > 0 && list[i - 1]!.venueMarketStatus === "regular";
        if (r.venueMarketStatus === "regular" || (r.venueMarketStatus === "paused" && afterRegular)) kept.push(r);
      }
      if (kept.length > 0) this.byTicker.set(ticker, kept);
    }
  }

  static async fromDir(dir: string): Promise<SnapshotStore> {
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return new SnapshotStore([]);
    }
    const rows: SnapshotRow[] = [];
    for (const f of files) rows.push(...parseSnapshotLines(await readFile(join(dir, f), "utf8")).rows);
    return new SnapshotStore(rows);
  }

  lastOfficialClose(ticker: string, asOf: string): OfficialClose | null {
    const list = this.byTicker.get(ticker);
    if (!list) return null;
    const limit = Date.parse(asOf);
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]!;
      if (Date.parse(r.capturedAt) <= limit) return { ticker, priceUsd: r.stockPrice!, asOf: r.capturedAt };
    }
    return null;
  }

  get size(): number {
    let n = 0;
    for (const l of this.byTicker.values()) n += l.length;
    return n;
  }
}
