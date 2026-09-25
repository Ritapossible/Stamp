import { Dec, fixed, ONE, parseDec } from "./decimal.js";
import { canonicalJson, sha256Hex, ticketHash } from "./hash.js";
import { parseIntent } from "./intent.js";
import { resolve } from "./issuer.js";
import { narrate } from "./narrate.js";
import { policyHash } from "./policy.js";
import { economicPrice, overpayUsd, premiumBps } from "./premium.js";
import { resolveReference } from "./reference.js";
import { resolveSession } from "./session.js";
import { bothReadings, toAmounts } from "./unit.js";
import type { DecideInput, DecisionTicket, MarketView, ReasonCode, Verdict } from "./types.js";

export const ENGINE_VERSION = "0.1.0";

const CORPORATE_ACTIONS = [
  "cash_dividend",
  "stock_dividend",
  "stock_split",
  "merger",
  "acquisition",
  "spinoff",
  "corporate action",
  "earnings",
  "maintenance",
];
const ASSET_PAUSE_CODES = new Set(["ASSET_PAUSED", "ASSET_LIMITED"]);
const MARKET_HALT_CODES = new Set(["MARKET_PAUSED", "MARKET_MAINTENANCE", "UNSUPPORTED"]);
const TRADABLE_CODES = new Set(["TRADING", "MARKET_CLOSED"]);
const KNOWN_CODES = new Set([...ASSET_PAUSE_CODES, ...MARKET_HALT_CODES, ...TRADABLE_CODES]);

/** Multipliers that differ by this factor or more are a split-scale disagreement. */
const CONFLICT_RATIO = new Dec(2);
const EQUAL_TOLERANCE = new Dec("1e-9");

type Draft = Omit<DecisionTicket, "verdict" | "reasons" | "notes" | "hash" | "narration">;

/**
 * The only place a verdict is made. Checks run in the order of docs/ARCHITECTURE.md §6.
 * The first BLOCK stops evaluation; WARNs accumulate; notes never change the verdict.
 */
export function decide(input: DecideInput): DecisionTicket {
  const warns: ReasonCode[] = [];
  const notes: ReasonCode[] = [];
  const views = new Map<string, MarketView>(input.views.map((v) => [v.contractAddress.toLowerCase(), v]));

  const draft: Draft = {
    kind: "decision",
    engineVersion: ENGINE_VERSION,
    asOf: input.asOf,
    intentId: sha256Hex(`${input.intent}\n${input.asOf}`).slice(0, 16),
    intent: { raw: input.intent },
    chosen: null,
    rejected: [],
    session: null,
    sessionSource: null,
    marketStatus: null,
    reasonCode: null,
    reasonMsg: null,
    multiplier: null,
    listMultiplier: null,
    tokenPriceUsd: null,
    economicPriceUsd: null,
    referenceUsd: null,
    referenceSource: null,
    referenceAsOf: null,
    referenceSibling: null,
    premiumBps: null,
    overpayUsd: null,
    notionalUsd: null,
    tokenUnits: null,
    economicShares: null,
    unitReadings: null,
    formula: "economicPrice = tokenInfo.price / sharesMultiplier",
    inputsHash: "",
    policyHash: policyHash(input.policy),
  };

  const finish = (block: ReasonCode | null): DecisionTicket => {
    const verdict: Verdict = block ? "BLOCK" : warns.length > 0 ? "WARN" : "ALLOW";
    const reasons: ReasonCode[] = block ? [...warns, block] : warns.length > 0 ? warns : ["OK"];
    const body = { ...draft, verdict, reasons, notes, hash: "", narration: "" };
    body.hash = ticketHash(body as unknown as Record<string, unknown>);
    body.narration = narrate(body);
    return body;
  };

  // 1. intent
  const parsed = parseIntent(input.intent);
  if (!parsed.ok) return finish("UNPARSEABLE_INTENT");
  const intent = parsed.intent;
  draft.intent = intent;

  // 2. resolve issuer on BSC
  const res = resolve(intent.query, input.universe, input.policy);
  draft.chosen = res.chosen;
  draft.rejected = res.rejected;
  draft.inputsHash = inputsHash(input, res.family.map((i) => i.contractAddress), views);
  if (res.block || !res.chosen) return finish(res.block ?? "UNKNOWN_TOKEN");
  const chosen = res.chosen;

  // 3. complete data
  const view = views.get(chosen.contractAddress);
  const status = view?.assetStatus ?? null;
  draft.marketStatus = status?.marketStatus ?? null;
  draft.reasonCode = status?.reasonCode ?? null;
  draft.reasonMsg = status?.reasonMsg ?? null;
  draft.tokenPriceUsd = view?.tokenPriceUsd ?? null;
  const tokenPrice = parseDec(view?.tokenPriceUsd);
  if (!view || !view.complete || !status || !tokenPrice || tokenPrice.lte(0)) return finish("INCOMPLETE_STATUS");
  if (status.reasonCode === null || !KNOWN_CODES.has(status.reasonCode)) return finish("INCOMPLETE_STATUS");

  // 4. multiplier present
  draft.multiplier = view.multiplier;
  const m = parseDec(view.multiplier);
  if (!m || m.lte(0)) return finish("NO_MULTIPLIER");

  // 5. multiplier cross-check (list vs dynamic)
  draft.listMultiplier = view.listMultiplier ?? res.chosenRow?.multiplier ?? null;
  const listM = parseDec(draft.listMultiplier);
  if (listM && listM.gt(0)) {
    const ratio = Dec.max(m.div(listM), listM.div(m));
    if (ratio.gte(CONFLICT_RATIO)) return finish("MULTIPLIER_CONFLICT");
    if (m.minus(listM).abs().div(listM).gt(EQUAL_TOLERANCE)) {
      // xStock list multipliers are known to lag (always "1"); informational there.
      (chosen.issuer === "xstock" ? notes : warns).push("MULTIPLIER_DRIFT");
    }
  }

  // 6. units
  const amount = new Dec(intent.amount);
  if (intent.unit === "ambiguous" && !m.eq(ONE)) {
    draft.unitReadings = bothReadings(amount, tokenPrice, m);
    return finish("UNIT_AMBIGUOUS");
  }
  const amounts = toAmounts(intent.unit === "ambiguous" ? "tokens" : intent.unit, amount, tokenPrice, m);
  draft.notionalUsd = amounts.notionalUsd;
  draft.tokenUnits = amounts.tokenUnits;
  draft.economicShares = amounts.economicShares;

  // 7. halts
  const msg = (status.reasonMsg ?? "").toLowerCase();
  if (ASSET_PAUSE_CODES.has(status.reasonCode)) {
    return finish(CORPORATE_ACTIONS.some((c) => msg.includes(c)) ? "HALTED_CORPORATE_ACTION" : "MARKET_HALTED");
  }
  if (MARKET_HALT_CODES.has(status.reasonCode) || status.marketStatus === "pause" || input.venue?.marketStatus === "pause") {
    return finish("MARKET_HALTED");
  }
  if (status.openState === false) return finish("VENUE_CLOSED");

  // 8. session
  const session = resolveSession(status, input.venue, input.asOf);
  draft.session = session.session;
  draft.sessionSource = session.source;
  draft.marketStatus = session.marketStatus;
  if (session.warn) warns.push(session.warn);

  // 9. reference
  const ref = resolveReference(chosen, res.family, views, input.lastOfficialClose, input.asOf);
  draft.referenceUsd = ref.priceUsd;
  draft.referenceSource = ref.source;
  draft.referenceAsOf = ref.asOf;
  draft.referenceSibling = ref.sibling;
  const economic = economicPrice(tokenPrice, m);
  draft.economicPriceUsd = fixed(economic, 6);
  const reference = parseDec(ref.priceUsd);
  if (!reference) {
    warns.push("NO_REFERENCE");
  } else {
    // 10–13. premium
    const bps = premiumBps(economic, reference);
    draft.premiumBps = bps;
    draft.overpayUsd = overpayUsd(new Dec(amounts.notionalUsd), economic, reference);
    const p = input.policy;
    if (Math.abs(bps) > p.implausibleAbsBps) return finish("PRICE_IMPLAUSIBLE");
    const cap = session.session === "regular" ? p.maxRegularPremiumBps : p.maxClosedPremiumBps;
    if (bps > cap) warns.push("SESSION_RICH");
    if (bps < -p.noiseBandBps) notes.push("THIN_BOOK");
  }

  // 14. caps
  const notional = new Dec(amounts.notionalUsd);
  const filled = parseDec(input.filledTodayUsd) ?? new Dec(0);
  if (notional.gt(new Dec(input.policy.maxOrderUsd)) || filled.plus(notional).gt(new Dec(input.policy.maxDayUsd))) {
    return finish("OVER_CAP");
  }

  return finish(null);
}

/** Hash of exactly the inputs this decision could see, so a verifier can recompute it. */
function inputsHash(input: DecideInput, family: string[], views: Map<string, MarketView>): string {
  const fam = new Set(family);
  return sha256Hex(
    canonicalJson({
      asOf: input.asOf,
      intent: input.intent,
      universe: input.universe
        .filter((r) => fam.has(r.contractAddress.toLowerCase()))
        .map((r) => ({ ...r, contractAddress: r.contractAddress.toLowerCase(), multiplier: r.multiplier ?? null })),
      views: family.map((a) => views.get(a) ?? null),
      venue: input.venue,
      lastOfficialClose: input.lastOfficialClose,
      filledTodayUsd: input.filledTodayUsd,
    }),
  );
}
