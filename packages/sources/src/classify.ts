import { ISSUER_BY_TYPE, type UniverseRow } from "@stamp/engine";
import type { RawListRow } from "./rwa.js";

export interface Universe {
  rows: UniverseRow[];
  /** rows dropped because a required field was missing or the wrong type */
  malformed: number;
  /** every distinct `type` seen on BSC, for the DEVEX log (docs only name 1) */
  bscTypes: number[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalizes the list endpoint. Keeps every chain (the engine filters to 56) so symbol
 * collisions across chains stay visible, but only BSC rows must carry an EVM address.
 * The issuer is never derived here from the symbol; the engine maps `type`.
 */
export function buildUniverse(raw: RawListRow[]): Universe {
  const rows: UniverseRow[] = [];
  let malformed = 0;
  const types = new Set<number>();
  for (const r of raw) {
    const valid =
      r &&
      typeof r.chainId === "string" &&
      typeof r.contractAddress === "string" &&
      typeof r.symbol === "string" &&
      typeof r.ticker === "string" &&
      Number.isSafeInteger(r.type) &&
      (r.chainId !== "56" || ADDRESS.test(r.contractAddress));
    if (!valid) {
      malformed++;
      continue;
    }
    if (r.chainId === "56") types.add(r.type);
    rows.push({
      chainId: r.chainId,
      contractAddress: r.chainId === "56" ? r.contractAddress.toLowerCase() : r.contractAddress,
      symbol: r.symbol,
      ticker: r.ticker,
      type: r.type,
      multiplier: typeof r.multiplier === "string" ? r.multiplier : null,
    });
  }
  return { rows, malformed, bscTypes: [...types].sort((a, b) => a - b) };
}

/** BSC rows for one ticker that the engine can price (types it maps to an issuer). */
export function familyRows(universe: UniverseRow[], ticker: string): UniverseRow[] {
  return universe.filter((r) => r.chainId === "56" && r.ticker === ticker && ISSUER_BY_TYPE[r.type] !== undefined);
}
