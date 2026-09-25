import { Dec, fixed } from "./decimal.js";
import type { Unit } from "./types.js";

export interface Amounts {
  notionalUsd: string;
  tokenUnits: string;
  economicShares: string;
}

const USD_DP = 2;
const QTY_DP = 8;

/**
 * token units     = notional / tokenPrice
 * economic shares = token units × multiplier
 * Converts any explicit unit to all three. `ambiguous` must be resolved by the caller.
 */
export function toAmounts(unit: Exclude<Unit, "ambiguous">, amount: Dec, tokenPrice: Dec, multiplier: Dec): Amounts {
  let tokens: Dec;
  if (unit === "usd") tokens = amount.div(tokenPrice);
  else if (unit === "shares") tokens = amount.div(multiplier);
  else tokens = amount;
  const notional = unit === "usd" ? amount : tokens.mul(tokenPrice);
  return {
    notionalUsd: fixed(notional, USD_DP),
    tokenUnits: fixed(tokens, QTY_DP),
    economicShares: fixed(tokens.mul(multiplier), QTY_DP),
  };
}

/** Both readings of a bare number ("buy 1 NFLX"): as tokens and as shares. */
export function bothReadings(amount: Dec, tokenPrice: Dec, multiplier: Dec) {
  const t = toAmounts("tokens", amount, tokenPrice, multiplier);
  const s = toAmounts("shares", amount, tokenPrice, multiplier);
  return {
    asTokens: { tokens: t.tokenUnits, shares: t.economicShares, usd: t.notionalUsd },
    asShares: { tokens: s.tokenUnits, shares: s.economicShares, usd: s.notionalUsd },
  };
}
