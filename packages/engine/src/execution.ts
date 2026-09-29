import { BPS, Dec, fixed, parseDec, toInt } from "./decimal.js";
import { canonicalJson, sha256Hex, ticketHash } from "./hash.js";
import { policyHash } from "./policy.js";
import type { AgenticExecuteInput, ExecuteInput, ExecutionTicket, FillInput, FillTicket, ReasonCode, TypedDataChecks, Verdict } from "./types.js";
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
    swapTxHash: null,
    approvalRequired: input.approvalRequired === true,
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

  // E1 - the decision is genuine and was made under this policy
  if (ticketHash(decision as unknown as Record<string, unknown>) !== decision.hash || policyHash(policy) !== decision.policyHash) {
    return finish("TICKET_TAMPERED");
  }
  // E1b - only an ALLOW decision can lead to a signature
  if (decision.verdict !== "ALLOW" || !decision.chosen || !decision.notionalUsd || !decision.tokenPriceUsd || !decision.multiplier) {
    return finish("DECISION_NOT_ALLOWED");
  }
  // E2 - fresh decision
  const decisionAge = (Date.parse(input.asOf) - Date.parse(decision.asOf)) / 1000;
  if (!(decisionAge >= 0 && decisionAge <= DECISION_MAX_AGE_SEC)) return finish("DECISION_STALE");

  // E4 - fresh quote (E3, the mode, is recorded above)
  if (!(draft.quoteAgeSec >= 0 && draft.quoteAgeSec <= policy.quoteTtlSec)) return finish("QUOTE_STALE");

  // E5 - same instrument, paid with the expected stablecoin
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

  // E6 - price moved or the route is worse than the decision saw
  const effective = amountIn.div(amountOut);
  draft.effectivePriceUsd = fixed(effective, 6);
  const decided = new Dec(decision.tokenPriceUsd);
  draft.slippageBps = toInt(effective.minus(decided).div(decided).mul(BPS));
  if (draft.slippageBps > policy.maxSlippageBps) return finish("SLIPPAGE");

  // E7 - what will be signed matches the ticket
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
  } else {
    // SWAP: the wallet sends a normal transaction. It must come from the user, carry no BNB
    // (USDT pays), simulate cleanly, and the simulated balances must show the user receiving
    // the ticket's token and no sibling issuer's.
    const tx = input.swapTx;
    if (!tx || typeof tx.to !== "string" || typeof tx.data !== "string") return finish("TX_MISMATCH");
    draft.swapTxHash = sha256Hex(canonicalJson({ from: tx.from ?? null, to: tx.to, value: tx.value, data: tx.data }));
    if ((tx.from && tx.from.toLowerCase() !== user) || !/^(0|0x0*)$/.test(String(tx.value ?? "0"))) return finish("TX_MISMATCH");
    if (input.approvalRequired) return finish("APPROVAL_REQUIRED");
    if (!input.swapSimulation?.ok) return finish("SIMULATION_FAILED");
    const changes = input.swapSimulation.balanceChanges;
    if (changes && changes.length > 0) {
      const mine = changes.filter((c) => c.owner.toLowerCase() === user);
      const gotToken = mine.some((c) => c.contractAddress.toLowerCase() === decision.chosen!.contractAddress && /^\+?[1-9]\d*$/.test(c.change));
      const sibling = new Set(decision.rejected.map((r) => r.contractAddress));
      const gotSibling = mine.some((c) => sibling.has(c.contractAddress.toLowerCase()));
      if (!gotToken || gotSibling) return finish("SIMULATION_MISMATCH");
    }
  }

  // E8 - the approval, if one is needed, simulates cleanly
  if (input.approvalSimulation && !input.approvalSimulation.ok) return finish("SIMULATION_FAILED");

  return finish(null);
}

/**
 * The execution ticket for a Binance Agentic Wallet swap (`baw market-order swap`). The wallet
 * builds and signs the transaction itself, under the limits the person set in the Binance App,
 * so there is no typed data or transaction for Stamp to inspect. What Stamp can check before
 * the swap is the quote; what it checks after is the fill (`verifyFill`). The quote does not
 * bind the swap, which is why the fill check exists.
 */
export function prepareAgenticExecution(input: AgenticExecuteInput & { quoteAsset: string }): ExecutionTicket {
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
    quoteId: "",
    quotedAt: quote.quotedAt,
    quoteAgeSec: Math.floor((Date.parse(input.asOf) - Date.parse(quote.quotedAt)) / 1000),
    executionMode: "AGENTIC",
    vendor: "binance-agentic-wallet",
    fromToken: input.quoteAsset.toLowerCase(),
    toToken: decision.chosen?.contractAddress ?? "",
    amountInUsd: null,
    amountOutTokens: null,
    economicShares: null,
    effectivePriceUsd: null,
    slippageBps: null,
    typedDataHash: null,
    typedDataChecks: null,
    swapTxHash: null,
    approvalRequired: false,
    swapSimulation: null,
    approvalSimulation: null,
  };
  const finish = (block: ReasonCode | null): ExecutionTicket => {
    const verdict: Verdict = block ? "BLOCK" : "ALLOW";
    const body = { ...draft, verdict, reasons: [block ?? "OK"] as ReasonCode[], hash: "", narration: "" };
    body.hash = ticketHash(body as unknown as Record<string, unknown>);
    body.narration = narrateExecution(body);
    return body;
  };

  // E1, E1b, E2 - as for any execution
  if (ticketHash(decision as unknown as Record<string, unknown>) !== decision.hash || policyHash(policy) !== decision.policyHash) {
    return finish("TICKET_TAMPERED");
  }
  if (decision.verdict !== "ALLOW" || !decision.chosen || !decision.notionalUsd || !decision.tokenPriceUsd || !decision.multiplier) {
    return finish("DECISION_NOT_ALLOWED");
  }
  const decisionAge = (Date.parse(input.asOf) - Date.parse(decision.asOf)) / 1000;
  if (!(decisionAge >= 0 && decisionAge <= DECISION_MAX_AGE_SEC)) return finish("DECISION_STALE");
  // E4
  if (!(draft.quoteAgeSec >= 0 && draft.quoteAgeSec <= policy.quoteTtlSec)) return finish("QUOTE_STALE");
  // E5 - the quote only names symbols; they must be the ticket's token and USDT
  if (quote.toCoinSymbol !== decision.chosen.symbol || quote.fromCoinSymbol.toUpperCase() !== "USDT") return finish("ISSUER_MISMATCH");
  // E5b, E6
  const amountIn = parseDec(quote.fromCoinAmount);
  const amountOut = parseDec(quote.toCoinAmount);
  if (!amountIn || !amountOut || amountOut.lte(0)) return finish("AMOUNT_MISMATCH");
  draft.amountInUsd = fixed(amountIn, 2);
  draft.amountOutTokens = fixed(amountOut, 8);
  draft.economicShares = fixed(amountOut.mul(new Dec(decision.multiplier)), 8);
  if (amountIn.minus(new Dec(decision.notionalUsd)).abs().gt(AMOUNT_TOLERANCE_USD)) return finish("AMOUNT_MISMATCH");
  const effective = amountIn.div(amountOut);
  draft.effectivePriceUsd = fixed(effective, 6);
  const decided = new Dec(decision.tokenPriceUsd);
  draft.slippageBps = toInt(effective.minus(decided).div(decided).mul(BPS));
  if (draft.slippageBps > policy.maxSlippageBps) return finish("SLIPPAGE");
  return finish(null);
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (t: string | undefined) => (t && /^0x[0-9a-fA-F]{64}$/.test(t) ? `0x${t.slice(26).toLowerCase()}` : null);

/**
 * The fill ticket: read the swap's BSC receipt and check that the wallet received the ticket's
 * token, received no sibling issuer's token, spent about the ticket's dollars, and paid a price
 * within the policy's slippage of the decision. It cannot undo a trade; it tells the truth
 * about one, with a hash.
 */
export function verifyFill(input: FillInput): FillTicket {
  const { decision, policy } = input;
  const user = input.user.toLowerCase();
  const draft: Omit<FillTicket, "verified" | "reasons" | "hash" | "narration"> = {
    kind: "fill",
    engineVersion: ENGINE_VERSION,
    asOf: input.asOf,
    decisionHash: decision.hash,
    user,
    symbol: decision.chosen?.symbol ?? null,
    txHash: input.txHash ? input.txHash.toLowerCase() : null,
    receivedTokens: null,
    economicShares: null,
    spentUsd: null,
    effectivePriceUsd: null,
    slippageBps: null,
    siblingReceived: null,
  };
  const finish = (bad: ReasonCode | null): FillTicket => {
    const body = { ...draft, verified: bad === null, reasons: [bad ?? "OK"] as ReasonCode[], hash: "", narration: "" };
    body.hash = ticketHash(body as unknown as Record<string, unknown>);
    body.narration = narrateFill(body);
    return body;
  };

  if (input.orderStatus !== "FINISHED" || !input.txHash || input.receiptStatus !== "success") return finish("FILL_FAILED");
  if (!decision.chosen || !decision.tokenPriceUsd || !decision.multiplier) return finish("FILL_NOT_RECEIVED");

  const token = decision.chosen.contractAddress.toLowerCase();
  const usdt = input.quoteAsset.toLowerCase();
  const siblings = new Set(decision.rejected.map((r) => r.contractAddress.toLowerCase()));
  let receivedRaw = 0n;
  let spentRaw = 0n;
  for (const log of input.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || !/^0x[0-9a-fA-F]+$/.test(log.data)) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const address = log.address.toLowerCase();
    const amount = BigInt(log.data);
    if (to === user && siblings.has(address)) draft.siblingReceived = address;
    if (to === user && address === token) receivedRaw += amount;
    if (from === user && address === usdt) spentRaw += amount;
  }
  if (draft.siblingReceived) return finish("FILL_WRONG_TOKEN");
  const received = rawToDec(receivedRaw.toString(), input.tokenDecimals);
  const spent = rawToDec(spentRaw.toString(), input.quoteDecimals);
  if (!received || received.lte(0)) return finish("FILL_NOT_RECEIVED");
  draft.receivedTokens = fixed(received, 8);
  draft.economicShares = fixed(received.mul(new Dec(decision.multiplier)), 8);
  if (!spent || spent.lte(0)) return finish("FILL_NOT_RECEIVED");
  draft.spentUsd = fixed(spent, 2);
  const effective = spent.div(received);
  draft.effectivePriceUsd = fixed(effective, 6);
  const decided = new Dec(decision.tokenPriceUsd);
  draft.slippageBps = toInt(effective.minus(decided).div(decided).mul(BPS));
  if (draft.slippageBps > policy.maxSlippageBps) return finish("FILL_SLIPPAGE");
  return finish(null);
}

function narrateFill(t: Omit<FillTicket, "narration">): string {
  const tail = `Hash ${t.hash.slice(0, 12)}…`;
  switch (t.reasons[0]) {
    case "OK":
      return `FILLED and verified on BSC: $${t.spentUsd} bought ${trim(t.receivedTokens)} ${t.symbol} tokens = ${trim(t.economicShares)} shares at $${t.effectivePriceUsd} per token (${t.slippageBps} bps from the decision). ${tail}`;
    case "FILL_FAILED":
      return `NOT FILLED. The order did not finish on chain; nothing was bought. ${tail}`;
    case "FILL_WRONG_TOKEN":
      return `MISMATCH. The wallet received ${t.siblingReceived}, another issuer's token, not ${t.symbol}. ${tail}`;
    case "FILL_NOT_RECEIVED":
      return `MISMATCH. The transaction succeeded but no ${t.symbol} (or no USDT spend) reached or left the wallet as expected. ${tail}`;
    case "FILL_SLIPPAGE":
      return `FILLED, but at $${t.effectivePriceUsd} per token, ${t.slippageBps} bps worse than the decision allowed. ${tail}`;
    default:
      return tail;
  }
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
      if (t.executionMode === "AGENTIC") {
        return `${head} Ready to swap in the Agentic Wallet: $${t.amountInUsd} for about ${trim(t.amountOutTokens)} ${t.symbol} tokens = ${trim(t.economicShares)} shares at $${t.effectivePriceUsd} per token (${t.slippageBps} bps from the decision). The swap is not bound to this quote; Stamp checks the fill on BSC afterwards. ${tail}`;
      }
      return `${head} Ready to ${t.executionMode === "SWAP" ? "send" : "sign"}: $${t.amountInUsd} for ${trim(t.amountOutTokens)} ${t.symbol} tokens = ${trim(t.economicShares)} shares at $${t.effectivePriceUsd} per token (${t.slippageBps} bps from the decision). The quote is ${t.quoteAgeSec} s old. ${tail}`;
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
    case "APPROVAL_REQUIRED":
      return `${head} Approve USDT for the swap router first (one transaction in your wallet), then review again. ${tail}`;
    case "TX_MISMATCH":
      return `${head} The swap transaction is not from your address or tries to send BNB. Nothing will be sent. ${tail}`;
    case "SIMULATION_MISMATCH":
      return `${head} In simulation you would not receive ${t.symbol}. Nothing will be sent. ${tail}`;
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
