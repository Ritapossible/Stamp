import type { AssetStatus, MarketView, UniverseRow, VenueStatus } from "@stamp/engine";
import type { RawDynamic, RawStatusInfo, RawVenueStatus } from "./rwa.js";

/**
 * Raw dynamic payload → MarketView. One adapter serves all three issuers because Binance
 * returns one shape; what differs is which fields are filled (docs/API-NOTES.md):
 *   Ondo   — statusInfo.marketStatus and stockInfo.price present
 *   bStock — statusInfo.marketStatus null, stockInfo.price null
 *   xStock — statusInfo.marketStatus null; list multiplier stale; data: null seen
 * The adapter copies values through; it never fills a gap. The engine decides what a gap means.
 */
export function toMarketView(row: UniverseRow, dynamic: RawDynamic | null, fetchedAt: string): MarketView {
  const d = dynamic;
  return {
    contractAddress: row.contractAddress.toLowerCase(),
    complete: d !== null && typeof d === "object",
    tokenPriceUsd: str(d?.tokenInfo?.price),
    multiplier: str(d?.tokenInfo?.sharesMultiplier),
    listMultiplier: row.multiplier ?? null,
    assetStatus: toAssetStatus(d?.statusInfo ?? null),
    stockPriceUsd: str(d?.stockInfo?.price),
    fetchedAt,
  };
}

/** statusInfo must at least carry openState and reasonCode keys to count as a status. */
export function toAssetStatus(s: RawStatusInfo | null | undefined): AssetStatus | null {
  if (!s || typeof s !== "object" || !("openState" in s) || !("reasonCode" in s)) return null;
  return {
    openState: typeof s.openState === "boolean" ? s.openState : null,
    marketStatus: str(s.marketStatus),
    reasonCode: str(s.reasonCode),
    reasonMsg: str(s.reasonMsg),
  };
}

export function toVenueStatus(v: RawVenueStatus | null | undefined): VenueStatus | null {
  if (!v || typeof v !== "object") return null;
  return { marketStatus: str(v.marketStatus), openState: typeof v.openState === "boolean" ? v.openState : null };
}

/** Accept only strings; a number here would already have lost precision in JSON.parse. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
