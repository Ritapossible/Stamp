/**
 * Golden cases. "live" cases are built unmodified from the real capture of 2026-09-25 10:11Z
 * (fixtures/probe-2026-09-25). "synthetic" cases start from that capture and change the
 * fields named in `change`, to reach paths the live market did not show that morning.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Dec } from "../src/decimal.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { DecideInput, MarketView, Policy, ReasonCode, UniverseRow, Verdict } from "../src/types.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const probe = (f: string) => JSON.parse(readFileSync(`${root}fixtures/probe-2026-09-25/${f}`, "utf8"));

const TICKERS = new Set(["NVDA", "NFLX", "MU", "KLAC", "OPENAI"]);
const list = probe("list.json").data as UniverseRow[];
const capture = probe("capture-101145.json");
export const CAPTURED_AT: string = capture.capturedAt;

const universe: UniverseRow[] = list
  .filter((r) => r.chainId === "56" && TICKERS.has(r.ticker))
  .map((r) => ({ chainId: r.chainId, contractAddress: r.contractAddress, symbol: r.symbol, ticker: r.ticker, type: r.type, multiplier: r.multiplier ?? null }));

const listMultiplier = new Map(universe.map((r) => [r.contractAddress.toLowerCase(), r.multiplier ?? null]));

function liveViews(): MarketView[] {
  const views: MarketView[] = [];
  for (const [address, entry] of Object.entries<any>(capture.dynamic)) {
    const d = entry.body?.data ?? null;
    if (!listMultiplier.has(address.toLowerCase())) continue;
    views.push({
      contractAddress: address.toLowerCase(),
      complete: d !== null,
      tokenPriceUsd: d?.tokenInfo?.price ?? null,
      multiplier: d?.tokenInfo?.sharesMultiplier ?? null,
      listMultiplier: listMultiplier.get(address.toLowerCase()) ?? null,
      assetStatus: d?.statusInfo
        ? {
            openState: d.statusInfo.openState,
            marketStatus: d.statusInfo.marketStatus,
            reasonCode: d.statusInfo.reasonCode,
            reasonMsg: d.statusInfo.reasonMsg,
          }
        : null,
      stockPriceUsd: d?.stockInfo?.price ?? null,
      fetchedAt: CAPTURED_AT,
    });
  }
  return views.sort((a, b) => a.contractAddress.localeCompare(b.contractAddress));
}

const venue = { marketStatus: capture.venue.data.marketStatus as string, openState: capture.venue.data.openState as boolean };

const addr = (symbol: string) => universe.find((r) => r.symbol === symbol)!.contractAddress.toLowerCase();

function base(intent: string, policy: Partial<Policy> = {}): DecideInput {
  return {
    intent,
    policy: { ...DEFAULT_POLICY, ...policy },
    asOf: CAPTURED_AT,
    universe,
    views: liveViews(),
    venue,
    lastOfficialClose: null,
    filledTodayUsd: "0",
  };
}

function patchView(input: DecideInput, symbol: string, patch: (v: MarketView) => MarketView): DecideInput {
  const a = addr(symbol);
  return { ...input, views: input.views.map((v) => (v.contractAddress === a ? patch(v) : v)) };
}

/** A Saturday with the listing shut, NVDAon priced `bps` over a Friday close of 226.00. */
function weekend(bps: number, withClose = true): DecideInput {
  const asOf = "2026-09-26T15:00:00.000Z";
  const close = new Dec("226.00");
  const input: DecideInput = {
    ...base("Buy $20 of NVIDIA"),
    asOf,
    venue: { marketStatus: "closed", openState: true },
    lastOfficialClose: withClose ? { ticker: "NVDA", priceUsd: "226.00", asOf: "2026-09-25T19:59:00.000Z" } : null,
  };
  input.views = input.views.map((v) => ({ ...v, fetchedAt: asOf, stockPriceUsd: null }));
  return patchView(input, "NVDAon", (v) => ({
    ...v,
    tokenPriceUsd: close.mul(new Dec(1).plus(new Dec(bps).div(10000))).mul(new Dec(v.multiplier!)).toFixed(18),
    assetStatus: { ...v.assetStatus!, marketStatus: "closed" },
  }));
}

export interface GoldenCase {
  name: string;
  kind: "live" | "synthetic";
  change?: string;
  input: DecideInput;
  verdict: Verdict;
  reasons: ReasonCode[];
  notes?: ReasonCode[];
  chosen?: string | null;
  rejected?: Array<[string, ReasonCode]>;
}

export const CASES: GoldenCase[] = [
  // — issuer —
  {
    name: "nvda-usd-ondo",
    kind: "live",
    input: base("Buy $20 of NVIDIA"),
    verdict: "ALLOW",
    reasons: ["OK"],
    chosen: "NVDAon",
    rejected: [["NVDAx", "NEVER_SWITCH"], ["NVDAB", "NEVER_SWITCH"]],
  },
  {
    name: "nvda-no-policy-issuer",
    kind: "live",
    input: base("Buy $20 of NVIDIA", { issuer: null }),
    verdict: "BLOCK",
    reasons: ["AMBIGUOUS_ISSUER"],
    chosen: null,
    rejected: [["NVDAon", "AMBIGUOUS_ISSUER"], ["NVDAx", "AMBIGUOUS_ISSUER"], ["NVDAB", "AMBIGUOUS_ISSUER"]],
  },
  {
    name: "nvdab-named-policy-ondo",
    kind: "live",
    input: base("Buy $20 of NVDAB"),
    verdict: "BLOCK",
    reasons: ["ISSUER_NOT_ALLOWED"],
    chosen: null,
    rejected: [["NVDAon", "NEVER_SWITCH"], ["NVDAx", "NEVER_SWITCH"], ["NVDAB", "ISSUER_NOT_ALLOWED"]],
  },
  { name: "nvda-bstock-sibling-reference", kind: "live", input: base("Buy $20 of NVIDIA", { issuer: "bstock" }), verdict: "ALLOW", reasons: ["OK"], chosen: "NVDAB" },
  { name: "nvda-xstock-discount", kind: "live", input: base("Buy $20 of NVIDIA", { issuer: "xstock" }), verdict: "ALLOW", reasons: ["OK"], notes: ["MULTIPLIER_DRIFT", "THIN_BOOK"], chosen: "NVDAx" },
  { name: "unknown-token", kind: "live", input: base("Buy $20 of Dogecoin"), verdict: "BLOCK", reasons: ["UNKNOWN_TOKEN"], chosen: null },
  { name: "unsupported-type-preipo", kind: "live", input: base("Buy $20 of xOPAI"), verdict: "BLOCK", reasons: ["UNKNOWN_TOKEN"], chosen: null },
  { name: "sell-unsupported", kind: "live", input: base("Sell 5 NVDA"), verdict: "BLOCK", reasons: ["UNPARSEABLE_INTENT"], chosen: null },
  {
    name: "symbol-equals-other-ticker",
    kind: "synthetic",
    change: "adds a made-up Ondo row with ticker MUB (a bond ETF) next to Micron's bStock symbol MUB",
    input: {
      ...base("Buy $20 of MUB"),
      universe: [...universe, { chainId: "56", contractAddress: "0x000000000000000000000000000000000000beef", symbol: "MUBon", ticker: "MUB", type: 1, multiplier: "1" }],
    },
    verdict: "BLOCK",
    reasons: ["AMBIGUOUS_QUERY"],
    chosen: null,
  },

  // — share count —
  { name: "nflx-bare-one", kind: "live", input: base("Buy 1 NFLX"), verdict: "BLOCK", reasons: ["UNIT_AMBIGUOUS"], chosen: "NFLXon" },
  { name: "nflx-one-share-over-cap", kind: "live", input: base("Buy 1 share of Netflix"), verdict: "BLOCK", reasons: ["OVER_CAP"], chosen: "NFLXon" },
  { name: "nflx-usd", kind: "live", input: base("Buy $20 of Netflix"), verdict: "ALLOW", reasons: ["OK"], chosen: "NFLXon" },
  { name: "klac-bare-one", kind: "live", input: base("buy 1 KLAC"), verdict: "BLOCK", reasons: ["UNIT_AMBIGUOUS"], chosen: "KLACon" },
  { name: "nflxx-multiplier-conflict", kind: "live", input: base("Buy $20 of NFLXx", { issuer: "xstock" }), verdict: "BLOCK", reasons: ["MULTIPLIER_CONFLICT"], chosen: "NFLXx" },
  {
    name: "no-multiplier",
    kind: "synthetic",
    change: "NVDAon sharesMultiplier set to null",
    input: patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, multiplier: null })),
    verdict: "BLOCK",
    reasons: ["NO_MULTIPLIER"],
    chosen: "NVDAon",
  },

  // — data and halts —
  {
    name: "xstock-data-null",
    kind: "synthetic",
    change: "NVDAx returned data: null (observed live at 09:58Z the same morning)",
    input: patchView(base("Buy $20 of NVIDIA", { issuer: "xstock" }), "NVDAx", (v) => ({ ...v, complete: false, tokenPriceUsd: null, multiplier: null, assetStatus: null, stockPriceUsd: null })),
    verdict: "BLOCK",
    reasons: ["INCOMPLETE_STATUS"],
    chosen: "NVDAx",
  },
  {
    name: "halt-stock-split",
    kind: "synthetic",
    change: "NVDAon statusInfo reasonCode ASSET_PAUSED, reasonMsg stock_split",
    input: patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, assetStatus: { ...v.assetStatus!, reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split" } })),
    verdict: "BLOCK",
    reasons: ["HALTED_CORPORATE_ACTION"],
    chosen: "NVDAon",
  },
  {
    name: "limited-earnings",
    kind: "synthetic",
    change: "NVDAon statusInfo reasonCode ASSET_LIMITED, reasonMsg earnings",
    input: patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, assetStatus: { ...v.assetStatus!, reasonCode: "ASSET_LIMITED", reasonMsg: "earnings" } })),
    verdict: "BLOCK",
    reasons: ["HALTED_CORPORATE_ACTION"],
    chosen: "NVDAon",
  },
  {
    name: "market-paused",
    kind: "synthetic",
    change: "NVDAon statusInfo reasonCode MARKET_PAUSED",
    input: patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, assetStatus: { ...v.assetStatus!, reasonCode: "MARKET_PAUSED" } })),
    verdict: "BLOCK",
    reasons: ["MARKET_HALTED"],
    chosen: "NVDAon",
  },
  {
    name: "venue-closed",
    kind: "synthetic",
    change: "NVDAon statusInfo openState false, reasonCode MARKET_CLOSED",
    input: patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, assetStatus: { ...v.assetStatus!, openState: false, reasonCode: "MARKET_CLOSED" } })),
    verdict: "BLOCK",
    reasons: ["VENUE_CLOSED"],
    chosen: "NVDAon",
  },
  {
    name: "unknown-reason-code",
    kind: "synthetic",
    change: "NVDAon statusInfo reasonCode null",
    input: patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, assetStatus: { ...v.assetStatus!, reasonCode: null } })),
    verdict: "BLOCK",
    reasons: ["INCOMPLETE_STATUS"],
    chosen: "NVDAon",
  },

  // — price —
  { name: "mux-implausible", kind: "live", input: base("Buy $20 of Micron", { issuer: "xstock" }), verdict: "BLOCK", reasons: ["PRICE_IMPLAUSIBLE"], notes: ["MULTIPLIER_DRIFT"], chosen: "MUx" },
  { name: "weekend-rich", kind: "synthetic", change: "Saturday, listing closed, NVDAon +190 bps over a 226.00 Friday close", input: weekend(190), verdict: "WARN", reasons: ["SESSION_RICH"], chosen: "NVDAon" },
  { name: "weekend-noise", kind: "synthetic", change: "Saturday, NVDAon +5 bps", input: weekend(5), verdict: "ALLOW", reasons: ["OK"], chosen: "NVDAon" },
  { name: "weekend-discount", kind: "synthetic", change: "Saturday, NVDAon −40 bps", input: weekend(-40), verdict: "ALLOW", reasons: ["OK"], notes: ["THIN_BOOK"], chosen: "NVDAon" },
  { name: "weekend-implausible", kind: "synthetic", change: "Saturday, NVDAon −800 bps", input: weekend(-800), verdict: "BLOCK", reasons: ["PRICE_IMPLAUSIBLE"], chosen: "NVDAon" },
  { name: "weekend-no-reference", kind: "synthetic", change: "Saturday, no stockInfo price and no snapshot", input: weekend(190, false), verdict: "WARN", reasons: ["NO_REFERENCE"], chosen: "NVDAon" },
  {
    name: "session-disagreement",
    kind: "synthetic",
    change: "Tuesday 11:00 New York, but Binance says closed",
    input: (() => {
      const i = patchView(base("Buy $20 of NVIDIA"), "NVDAon", (v) => ({ ...v, assetStatus: { ...v.assetStatus!, marketStatus: "closed" } }));
      return { ...i, asOf: "2026-09-29T15:00:00.000Z", views: i.views.map((v) => ({ ...v, fetchedAt: "2026-09-29T15:00:00.000Z" })) };
    })(),
    verdict: "WARN",
    reasons: ["SESSION_DISAGREEMENT"],
    chosen: "NVDAon",
  },
  { name: "daily-cap", kind: "live", input: { ...base("Buy $20 of NVIDIA"), filledTodayUsd: "40" }, verdict: "BLOCK", reasons: ["OVER_CAP"], chosen: "NVDAon" },
];
