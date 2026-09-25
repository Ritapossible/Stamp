import { Decimal as DecimalJs } from "decimal.js";

/** Isolated Decimal constructor: 40 significant digits, banker's rounding. */
export const Dec = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });
export type Dec = InstanceType<typeof Dec>;

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Parses an API or user decimal string. Returns null for null, "", NaN, exponents, etc. */
export function parseDec(value: string | null | undefined): Dec | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!PLAIN_DECIMAL.test(s)) return null;
  return new Dec(s);
}

/** Fixed-point string with exactly `dp` places (deterministic, no exponent). */
export function fixed(d: Dec, dp: number): string {
  return d.toFixed(dp, Dec.ROUND_HALF_EVEN);
}

/** Integer, half-even; throws if it would not be a safe integer. */
export function toInt(d: Dec): number {
  const n = d.toDecimalPlaces(0, Dec.ROUND_HALF_EVEN).toNumber();
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${d.toString()}`);
  return n;
}

export const ZERO = new Dec(0);
export const ONE = new Dec(1);
export const BPS = new Dec(10000);
