import { parseDec } from "./decimal.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import type { Policy } from "./types.js";

/** The demo policy. Mirrors POLICY.md; change both together. */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  issuer: "ondo",
  neverSwitchIssuer: true,
  noiseBandBps: 10,
  maxRegularPremiumBps: 30,
  maxClosedPremiumBps: 80,
  implausibleAbsBps: 500,
  maxSlippageBps: 50,
  quoteTtlSec: 25,
  maxOrderUsd: "20",
  maxDayUsd: "50",
  blockCorporateActions: true,
};

const ISSUERS = new Set(["ondo", "xstock", "bstock"]);

/** Returns a list of problems; empty means valid. Guards policies arriving over HTTP. */
export function validatePolicy(p: Policy): string[] {
  const errors: string[] = [];
  if (p.version !== 1) errors.push("version must be 1");
  if (p.issuer !== null && !ISSUERS.has(p.issuer)) errors.push("issuer must be ondo, xstock, bstock or null");
  if (p.neverSwitchIssuer !== true) errors.push("neverSwitchIssuer must be true");
  if (p.blockCorporateActions !== true) errors.push("blockCorporateActions must be true");
  const bps: Array<keyof Policy> = ["noiseBandBps", "maxRegularPremiumBps", "maxClosedPremiumBps", "implausibleAbsBps", "maxSlippageBps", "quoteTtlSec"];
  for (const k of bps) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) errors.push(`${k} must be a non-negative integer`);
  }
  if (p.quoteTtlSec > 30) errors.push("quoteTtlSec must be <= 30 (Binance quotes expire in ~30 s)");
  for (const k of ["maxOrderUsd", "maxDayUsd"] as const) {
    const d = parseDec(p[k]);
    if (!d || d.lte(0)) errors.push(`${k} must be a positive decimal string`);
  }
  return errors;
}

export function policyHash(p: Policy): string {
  return sha256Hex(canonicalJson(p));
}
