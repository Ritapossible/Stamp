/**
 * Domain types for the Stamp engine. Every price, amount and multiplier is a decimal string;
 * the only numbers are integer basis points and the API's integer `type`.
 */

export type Issuer = "ondo" | "xstock" | "bstock";
export type Verdict = "ALLOW" | "WARN" | "BLOCK";
export type Session = "regular" | "extended" | "closed" | "unknown";
export type Unit = "usd" | "shares" | "tokens" | "ambiguous";

export type ReasonCode =
  // decision: BLOCK
  | "UNPARSEABLE_INTENT"
  | "UNKNOWN_TOKEN"
  | "AMBIGUOUS_QUERY"
  | "AMBIGUOUS_ISSUER"
  | "ISSUER_NOT_ALLOWED"
  | "INCOMPLETE_STATUS"
  | "NO_MULTIPLIER"
  | "MULTIPLIER_CONFLICT"
  | "UNIT_AMBIGUOUS"
  | "HALTED_CORPORATE_ACTION"
  | "MARKET_HALTED"
  | "VENUE_CLOSED"
  | "PRICE_IMPLAUSIBLE"
  | "OVER_CAP"
  // decision: WARN
  | "MULTIPLIER_DRIFT"
  | "SESSION_DISAGREEMENT"
  | "SESSION_UNKNOWN"
  | "NO_REFERENCE"
  | "SESSION_RICH"
  // notes (never change the verdict) and rejected-sibling labels
  | "THIN_BOOK"
  | "NEVER_SWITCH"
  | "OK"
  // execution (plan Day 7)
  | "TICKET_TAMPERED"
  | "DECISION_STALE"
  | "QUOTE_STALE"
  | "ISSUER_MISMATCH"
  | "SLIPPAGE"
  | "TYPED_DATA_MISMATCH"
  | "SIMULATION_FAILED";

/** One row of the RWA list endpoint, as returned. */
export interface UniverseRow {
  chainId: string;
  contractAddress: string;
  symbol: string;
  ticker: string;
  type: number;
  multiplier?: string | null;
}

export interface Instrument {
  chainId: "56";
  contractAddress: string;
  symbol: string;
  ticker: string;
  issuer: Issuer;
}

export interface AssetStatus {
  openState: boolean | null;
  marketStatus: string | null;
  reasonCode: string | null;
  reasonMsg: string | null;
}

export interface VenueStatus {
  marketStatus: string | null;
  openState: boolean | null;
}

/** Normalized per-instrument market data. Built by packages/sources adapters. */
export interface MarketView {
  contractAddress: string;
  /** false when the API returned `data: null` (after one retry) or failed. */
  complete: boolean;
  tokenPriceUsd: string | null;
  /** dynamic endpoint `tokenInfo.sharesMultiplier` */
  multiplier: string | null;
  /** list endpoint `multiplier`, used as a cross-check */
  listMultiplier: string | null;
  assetStatus: AssetStatus | null;
  /** this instrument's `stockInfo.price` (the underlying stock, not the token) */
  stockPriceUsd: string | null;
  fetchedAt: string;
}

export interface OfficialClose {
  ticker: string;
  priceUsd: string;
  asOf: string;
}

export interface Policy {
  version: 1;
  /** null means the order itself must name the issuer when several exist. */
  issuer: Issuer | null;
  neverSwitchIssuer: true;
  noiseBandBps: number;
  maxRegularPremiumBps: number;
  maxClosedPremiumBps: number;
  implausibleAbsBps: number;
  maxSlippageBps: number;
  quoteTtlSec: number;
  maxOrderUsd: string;
  maxDayUsd: string;
  blockCorporateActions: true;
}

export interface ParsedIntent {
  raw: string;
  side: "buy";
  unit: Unit;
  amount: string;
  query: string;
}

export interface DecideInput {
  intent: string;
  policy: Policy;
  /** ISO time the decision is made at. Replay passes a recorded time. */
  asOf: string;
  universe: UniverseRow[];
  views: MarketView[];
  venue: VenueStatus | null;
  lastOfficialClose: OfficialClose | null;
  /** USD already FILLED today under this policy. */
  filledTodayUsd: string;
}

export type ReferenceSource = "stockInfo" | "stockInfo-sibling" | "lastOfficialClose" | "missing";

export interface RejectedInstrument {
  symbol: string;
  issuer: Issuer;
  contractAddress: string;
  reason: ReasonCode;
}

export interface DecisionTicket {
  kind: "decision";
  engineVersion: string;
  asOf: string;
  intentId: string;
  intent: ParsedIntent | { raw: string };
  chosen: Instrument | null;
  rejected: RejectedInstrument[];
  session: Session | null;
  sessionSource: "asset" | "venue" | null;
  marketStatus: string | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  multiplier: string | null;
  listMultiplier: string | null;
  tokenPriceUsd: string | null;
  economicPriceUsd: string | null;
  referenceUsd: string | null;
  referenceSource: ReferenceSource | null;
  referenceAsOf: string | null;
  referenceSibling: string | null;
  premiumBps: number | null;
  overpayUsd: string | null;
  notionalUsd: string | null;
  tokenUnits: string | null;
  economicShares: string | null;
  /** Both readings of a bare number, shown when UNIT_AMBIGUOUS. */
  unitReadings: { asTokens: { tokens: string; shares: string; usd: string }; asShares: { tokens: string; shares: string; usd: string } } | null;
  verdict: Verdict;
  reasons: ReasonCode[];
  notes: ReasonCode[];
  formula: "economicPrice = tokenInfo.price / sharesMultiplier";
  inputsHash: string;
  policyHash: string;
  hash: string;
  narration: string;
}
