import type { MarketView, UniverseRow, VenueStatus } from "@stamp/engine";
import { toMarketView, toVenueStatus } from "./adapters.js";
import type { Envelope, RawDynamic, RawVenueStatus } from "./rwa.js";

/** A raw capture file, as written to data/captures/ by scripts/snapshot.ts. */
export interface CaptureFile {
  capturedAt: string;
  /** list rows at capture time (captures written after 2026-09-25 12:30Z carry them) */
  universe?: UniverseRow[];
  venue: Envelope<RawVenueStatus> | null;
  dynamic: Record<string, { symbol: string; body: Envelope<RawDynamic> | null; latencyMs?: number; attempts?: number; error?: string | null }>;
}

export interface MarketInputs {
  asOf: string;
  universe: UniverseRow[];
  views: MarketView[];
  venue: VenueStatus | null;
}

/**
 * Rebuilds exactly what the engine saw at capture time. Replay uses this, so a ticket
 * recomputed on a Wednesday from Saturday's capture hashes identically to Saturday's.
 */
export function fromCapture(capture: CaptureFile, fallbackUniverse: UniverseRow[] = []): MarketInputs {
  const universe = capture.universe ?? fallbackUniverse;
  const bsc = new Map(universe.filter((r) => r.chainId === "56").map((r) => [r.contractAddress.toLowerCase(), r]));
  const views: MarketView[] = [];
  for (const [address, entry] of Object.entries(capture.dynamic)) {
    const row = bsc.get(address.toLowerCase());
    if (!row) continue;
    views.push(toMarketView(row, entry.body?.data ?? null, capture.capturedAt));
  }
  views.sort((a, b) => a.contractAddress.localeCompare(b.contractAddress));
  return { asOf: capture.capturedAt, universe, views, venue: toVenueStatus(capture.venue?.data ?? null) };
}
