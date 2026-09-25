import { NAME_TO_TICKER } from "./aliases.js";
import type { Instrument, Issuer, Policy, ReasonCode, RejectedInstrument, UniverseRow } from "./types.js";

export const BSC = "56";

/** Issuer comes from the API `type`, never from the symbol suffix (MUB is Micron, not a bond ETF). */
export const ISSUER_BY_TYPE: Readonly<Record<number, Issuer>> = { 1: "ondo", 2: "xstock", 3: "bstock" };

export const ISSUER_LABEL: Readonly<Record<Issuer, string>> = { ondo: "Ondo", xstock: "xStock", bstock: "bStock" };

export function toInstrument(row: UniverseRow): Instrument | null {
  const issuer = ISSUER_BY_TYPE[row.type];
  if (row.chainId !== BSC || !issuer) return null;
  return { chainId: "56", contractAddress: row.contractAddress.toLowerCase(), symbol: row.symbol, ticker: row.ticker, issuer };
}

export interface Resolution {
  block: ReasonCode | null;
  chosen: Instrument | null;
  chosenRow: UniverseRow | null;
  /** every supported same-ticker instrument, including the chosen one */
  family: Instrument[];
  rejected: RejectedInstrument[];
  ticker: string | null;
  namedIssuer: Issuer | null;
}

const reject = (i: Instrument, reason: ReasonCode): RejectedInstrument => ({
  symbol: i.symbol,
  issuer: i.issuer,
  contractAddress: i.contractAddress,
  reason,
});

export function resolve(query: string, universe: UniverseRow[], policy: Policy): Resolution {
  const q = query.trim().toUpperCase();
  const bsc = universe.filter((r) => r.chainId === BSC);
  const empty: Resolution = { block: "UNKNOWN_TOKEN", chosen: null, chosenRow: null, family: [], rejected: [], ticker: null, namedIssuer: null };

  const symbolHit = bsc.find((r) => r.symbol.toUpperCase() === q) ?? null;
  const tickerFromName = NAME_TO_TICKER[q] ?? q;
  const tickerHits = bsc.filter((r) => r.ticker.toUpperCase() === tickerFromName);

  // A symbol that is also some other instrument's ticker is two different stocks.
  if (symbolHit && tickerHits.length > 0 && tickerHits.some((r) => r.ticker !== symbolHit.ticker)) {
    return { ...empty, block: "AMBIGUOUS_QUERY" };
  }

  const ticker = symbolHit ? symbolHit.ticker : tickerHits[0]?.ticker ?? null;
  if (!ticker) return empty;

  const familyRows = bsc.filter((r) => r.ticker === ticker && ISSUER_BY_TYPE[r.type] !== undefined);
  const family = familyRows.map((r) => toInstrument(r)!);
  if (family.length === 0) return { ...empty, ticker };

  const named = symbolHit ? toInstrument(symbolHit) : null;
  if (symbolHit && !named) return { ...empty, ticker };

  const base = { family, ticker, namedIssuer: named?.issuer ?? null };

  if (named) {
    if (policy.issuer !== null && named.issuer !== policy.issuer) {
      // The order names a product the policy does not allow. Never swap it for another issuer's.
      return {
        ...base,
        block: "ISSUER_NOT_ALLOWED",
        chosen: null,
        chosenRow: null,
        rejected: family.map((i) => reject(i, i.issuer === named.issuer ? "ISSUER_NOT_ALLOWED" : "NEVER_SWITCH")),
      };
    }
    return {
      ...base,
      block: null,
      chosen: named,
      chosenRow: symbolHit,
      rejected: family.filter((i) => i.contractAddress !== named.contractAddress).map((i) => reject(i, "NEVER_SWITCH")),
    };
  }

  if (policy.issuer === null) {
    if (family.length > 1) return { ...base, block: "AMBIGUOUS_ISSUER", chosen: null, chosenRow: null, rejected: family.map((i) => reject(i, "AMBIGUOUS_ISSUER")) };
    return { ...base, block: null, chosen: family[0]!, chosenRow: familyRows[0]!, rejected: [] };
  }

  const idx = family.findIndex((i) => i.issuer === policy.issuer);
  if (idx < 0) {
    return { ...base, block: "ISSUER_NOT_ALLOWED", chosen: null, chosenRow: null, rejected: family.map((i) => reject(i, "NEVER_SWITCH")) };
  }
  const chosen = family[idx]!;
  return {
    ...base,
    block: null,
    chosen,
    chosenRow: familyRows[idx]!,
    rejected: family.filter((_, j) => j !== idx).map((i) => reject(i, "NEVER_SWITCH")),
  };
}
