import { parseDec } from "./decimal.js";
import type { Instrument, Issuer, MarketView, OfficialClose, ReferenceSource } from "./types.js";

export interface ReferenceResult {
  priceUsd: string | null;
  source: ReferenceSource;
  asOf: string | null;
  sibling: string | null;
}

const SIBLING_MAX_AGE_MS = 60_000;
const SIBLING_ORDER: Issuer[] = ["ondo", "xstock", "bstock"];

/**
 * The reference is the underlying stock's price, never a token price. In order:
 * this instrument's stockInfo.price → a same-ticker sibling's stockInfo.price (fresh) →
 * the snapshot store's last official close → missing.
 */
export function resolveReference(
  chosen: Instrument,
  family: Instrument[],
  views: Map<string, MarketView>,
  lastOfficialClose: OfficialClose | null,
  asOf: string,
): ReferenceResult {
  const own = views.get(chosen.contractAddress);
  if (own?.complete && parseDec(own.stockPriceUsd)?.gt(0)) {
    return { priceUsd: own.stockPriceUsd, source: "stockInfo", asOf: own.fetchedAt, sibling: null };
  }

  const now = Date.parse(asOf);
  const siblings = family
    .filter((i) => i.contractAddress !== chosen.contractAddress)
    .sort((a, b) => SIBLING_ORDER.indexOf(a.issuer) - SIBLING_ORDER.indexOf(b.issuer));
  for (const s of siblings) {
    const v = views.get(s.contractAddress);
    if (!v?.complete || !parseDec(v.stockPriceUsd)?.gt(0)) continue;
    const age = now - Date.parse(v.fetchedAt);
    if (age < -SIBLING_MAX_AGE_MS || age > SIBLING_MAX_AGE_MS) continue;
    return { priceUsd: v.stockPriceUsd, source: "stockInfo-sibling", asOf: v.fetchedAt, sibling: s.symbol };
  }

  if (
    lastOfficialClose &&
    lastOfficialClose.ticker === chosen.ticker &&
    parseDec(lastOfficialClose.priceUsd)?.gt(0) &&
    Date.parse(lastOfficialClose.asOf) <= now
  ) {
    return { priceUsd: lastOfficialClose.priceUsd, source: "lastOfficialClose", asOf: lastOfficialClose.asOf, sibling: null };
  }

  return { priceUsd: null, source: "missing", asOf: null, sibling: null };
}
