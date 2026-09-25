import { BPS, Dec, fixed, parseDec, toInt } from "./decimal.js";
import { canonicalJson, sha256Hex, ticketHash } from "./hash.js";
import { policyHash } from "./policy.js";
import type { ExecuteInput, ExecutionTicket, ReasonCode, TypedDataChecks, Verdict } from "./types.js";
import { ENGINE_VERSION } from "./verdict.js";

/** A decision older than this must be re-made before anything is quoted against it. */
export const DECISION_MAX_AGE_SEC = 120;
/** The quote may spend at most this far from the ticket's notional (rounding in the aggregator). */
const AMOUNT_TOLERANCE_USD = new Dec("0.01");

type Draft = Omit<ExecutionTicket, "verdict" | "reasons" | "hash" | "narration">;

/**
 * The second ticket. A decision ALLOW is not permission to sign; this is. Checks run in the
 * order of docs/ARCHITECTURE.md §7 and stop at the first BLOCK. There is no WARN here:
 * an execution ticket either allows a signature or it does not.
 */
export function prepareExecution(input: ExecuteInput): ExecutionTicket {
  const { decision, quote, policy } = input;
  const user = input.user.toLowerCase();
  const draft: Draft = {
    kind: "execution",
    engineVersion: ENGINE_VERSION,
    asOf: input.asOf,
    decisionHash: decision.hash,
    policyHash: decision.policyHash,
    user,
    symbol: decision.chosen?.symbol ?? null,
    quoteId: quote.quoteId,
    quotedAt: quote.quotedAt,
    quoteAgeSec: Math.floor((Date.parse(input.asOf) - Date.parse(quote.quotedAt)) / 1000),
    executionMode: quote.executionMode,
    vendor: quote.vendor,
    fromToken: quote.fromToken.toLowerCase(),
    toToken: quote.toToken.toLowerCase(),
    amountInUsd: null,
    amountOutTokens: null,
    economicShares: null,
    effectivePriceUsd: null,
    slippageBps: null,
    typedDataHash: null,
    typedDataChecks: null,
    swapSimulation: input.swapSimulation,
    approvalSimulation: input.approvalSimulation,
  };

  const finish = (block: ReasonCode | null): ExecutionTicket => {
    const verdict: Verdict = block ? "BLOCK" : "ALLOW";
    const body = { ...draft, verdict, reasons: [block ?? "OK"] as ReasonCode[], hash: "", narration: "" };
    body.hash = ticketHash(body as unknown as Record<string, unknown>);
    body.narration = narrateExecution(body);
    return body;
  };

  // E1 — the decision is genuine and was made under this policy
  if (ticketHash(decision as unknown as Record<string, unknown>) !== decision.hash || policyHash(policy) !== decision.policyHash) {
    return finish("TICKET_TAMPERED");
  }
  // E1b — only an ALLOW decision can lead to a signature
  if (decision.verdict !== "ALLOW" || !decision.chosen || !decision.notionalUsd || !decision.tokenPriceUsd || !decision.multiplier) {
    return finish("DECISION_NOT_ALLOWED");
  }
  // E2 — fresh decision
  const decisionAge = (Date.parse(input.asOf) - Date.parse(decision.asOf)) / 1000;
  if (!(decisionAge >= 0 && decisionAge <= DECISION_MAX_AGE_SEC)) return finish("DECISION_STALE");

  // E4 — fresh quote (E3, the mode, is recorded above)
  if (!(draft.quoteAgeSec >= 0 && draft.quoteAgeSec <= policy.quoteTtlSec)) return finish("QUOTE_STALE");

  // E5 — same instrument, paid with the expected stablecoin
  if (draft.toToken !== decision.chosen.contractAddress || draft.fromToken !== input.quoteAsset.toLowerCase()) {
    return finish("ISSUER_MISMATCH");
  }

  // amounts
  const amountIn = rawToDec(quote.amountInRaw, quote.fromDecimals);
  const amountOut = rawToDec(quote.amountOutRaw, quote.toDecimals);
  if (!amountIn || !amountOut || amountOut.lte(0)) return finish("AMOUNT_MISMATCH");
  draft.amountInUsd = fixed(amountIn, 2);
  draft.amountOutTokens = fixed(amountOut, 8);
  draft.economicShares = fixed(amountOut.mul(new Dec(decision.multiplier)), 8);
  if (amountIn.minus(new Dec(decision.notionalUsd)).abs().gt(AMOUNT_TOLERANCE_USD)) return finish("AMOUNT_MISMATCH");

  // E6 — price moved or the route is worse than the decision saw
  const effective = amountIn.div(amountOut);
  draft.effectivePriceUsd = fixed(effective, 6);
  const decided = new Dec(decision.tokenPriceUsd);
  draft.slippageBps = toInt(effective.minus(decided).div(decided).mul(BPS));
  if (draft.slippageBps > policy.maxSlippageBps) return finish("SLIPPAGE");

  // E7 — what will be signed matches the ticket
  if (quote.executionMode === "RFQ") {
    const checks = inspectTypedData(input.typedData, {
      token: decision.chosen.contractAddress,
      user,
      amounts: [quote.amountInRaw, quote.amountOutRaw],
      otherIssuers: decision.rejected.map((r) => r.contractAddress),
    });
    draft.typedDataChecks = checks;
    if (checks.hashable) draft.typedDataHash = sha256Hex(canonicalJson(input.typedData));
    if (!checks.hashable || !checks.chainId56 || !checks.tokenFound || !checks.userFound || !checks.amountFound || checks.otherIssuerFound) {
      return finish("TYPED_DATA_MISMATCH");
    }
  } else if (!input.swapSimulation?.ok) {
    return finish("SIMULATION_FAILED");
  }

  // E8 — the approval, if one is needed, simulates cleanly
  if (input.approvalSimulation && !input.approvalSimulation.ok) return finish("SIMULATION_FAILED");

  return finish(null);
}

/** Integer string with `decimals` places → Dec. Rejects anything but a plain non-negative integer. */
export function rawToDec(raw: string, decimals: number): Dec | null {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return new Dec(raw).div(new Dec(10).pow(decimals));
}

/**
 * Structural check of EIP-712 typed data without trusting any field names: every string or
 * integer anywhere in `message` is collected, and the ticket's token, the user, and one of
 * the quoted amounts must all appear; no sibling issuer's token may appear. The exact field
 * layout is recorded from the first real RFQ quote (plan Day 7) and can tighten this later.
 */
export function inspectTypedData(
  typedData: unknown,
  want: { token: string; user: string; amounts: string[]; otherIssuers: string[] },
): TypedDataChecks {
  let hashable = true;
  try {
    canonicalJson(typedData);
  } catch {
    hashable = false;
  }
  const td = (typedData ?? {}) as { domain?: { chainId?: unknown }; message?: unknown };
  const values = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") values.add(v.toLowerCase());
    else if (typeof v === "number" && Number.isSafeInteger(v)) values.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(td.message);
  const chainId = td.domain?.chainId;
  return {
    hashable,
    chainId56: chainId === 56 || chainId === "56" || chainId === "0x38",
    tokenFound: values.has(want.token.toLowerCase()),
    userFound: values.has(want.user.toLowerCase()),
    amountFound: want.amounts.some((a) => values.has(a)),
    otherIssuerFound: want.otherIssuers.find((a) => values.has(a.toLowerCase())) ?? null,
  };
}

function narrateExecution(t: Omit<ExecutionTicket, "narration">): string {
  const r = t.reasons[0];
  const head = `${t.verdict}.`;
  const tail = `Hash ${t.hash.slice(0, 12)}…`;
  switch (r) {
    case "OK":
      return `${head} Ready to sign: $${t.amountInUsd} for ${trim(t.amountOutTokens)} ${t.symbol} tokens = ${trim(t.economicShares)} shares at $${t.effectivePriceUsd} per token (${t.slippageBps} bps from the decision). The quote is ${t.quoteAgeSec} s old. ${tail}`;
    case "TICKET_TAMPERED":
      return `${head} The decision ticket does not match its hash or its policy. Nothing will be signed. ${tail}`;
    case "DECISION_NOT_ALLOWED":
      return `${head} Only an ALLOW decision can be signed. ${tail}`;
    case "DECISION_STALE":
      return `${head} The decision is too old; make a new one. ${tail}`;
    case "QUOTE_STALE":
      return `${head} The quote is ${t.quoteAgeSec} s old; get a new quote. ${tail}`;
    case "ISSUER_MISMATCH":
      return `${head} The quote buys ${t.toToken} with ${t.fromToken}, not the instrument or currency on the decision. ${tail}`;
    case "AMOUNT_MISMATCH":
      return `${head} The quote spends $${t.amountInUsd ?? "?"}, not the amount on the decision. ${tail}`;
    case "SLIPPAGE":
      return `${head} The quote pays $${t.effectivePriceUsd} per token, ${t.slippageBps} bps worse than the decision saw. ${tail}`;
    case "TYPED_DATA_MISMATCH":
      return `${head} The order you would sign does not match the ticket (${describeChecks(t.typedDataChecks)}). ${tail}`;
    case "SIMULATION_FAILED":
      return `${head} The transaction fails in simulation: ${t.approvalSimulation?.error ?? t.swapSimulation?.error ?? "no simulation"}. ${tail}`;
    default:
      return `${head} ${tail}`;
  }
}

function describeChecks(c: TypedDataChecks | null): string {
  if (!c) return "no typed data";
  const bad: string[] = [];
  if (!c.hashable) bad.push("not hashable");
  if (!c.chainId56) bad.push("not BSC");
  if (!c.tokenFound) bad.push("token missing");
  if (!c.userFound) bad.push("your address missing");
  if (!c.amountFound) bad.push("amount missing");
  if (c.otherIssuerFound) bad.push(`contains another issuer's token ${c.otherIssuerFound}`);
  return bad.join(", ");
}

function trim(s: string | null): string {
  if (!s) return "?";
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
