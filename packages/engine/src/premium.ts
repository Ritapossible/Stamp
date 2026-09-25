import { BPS, type Dec, fixed, toInt } from "./decimal.js";

/** Binance's formula: economicPrice = tokenInfo.price / sharesMultiplier. */
export function economicPrice(tokenPrice: Dec, multiplier: Dec): Dec {
  return tokenPrice.div(multiplier);
}

/** Integer basis points of the economic price over the reference. */
export function premiumBps(economic: Dec, reference: Dec): number {
  return toInt(economic.minus(reference).div(reference).mul(BPS));
}

/**
 * Dollars paid above the reference for this order: the shares bought (notional / economic)
 * times the per-share excess (economic − reference). Only meaningful when positive.
 */
export function overpayUsd(notional: Dec, economic: Dec, reference: Dec): string | null {
  if (economic.lte(reference)) return null;
  return fixed(notional.mul(economic.minus(reference)).div(economic), 2);
}
