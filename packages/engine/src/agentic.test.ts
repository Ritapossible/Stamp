import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Dec } from "./decimal.js";
import { prepareAgenticExecution, verifyFill } from "./execution.js";
import { ticketHash } from "./hash.js";
import { DEFAULT_POLICY } from "./policy.js";
import type { AgenticQuoteView, DecisionTicket, FillInput, ReceiptLog } from "./types.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const golden = (name: string): DecisionTicket => JSON.parse(readFileSync(`${root}fixtures/golden/${name}.json`, "utf8")).ticket;

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const USER = "0x1111111111111111111111111111111111111111";
const POOL = "0x9999999999999999999999999999999999999999";
const decision = golden("nvda-usd-ondo"); // ALLOW, NVDAon, $20.00
const NVDAON = decision.chosen!.contractAddress;
const NVDAB = decision.rejected.find((r) => r.symbol === "NVDAB")!.contractAddress;
const t0 = Date.parse(decision.asOf);
const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
const priceAt = (bps: number) => new Dec(decision.tokenPriceUsd!).mul(new Dec(1).plus(new Dec(bps).div(10000)));
const tokensFor = (usd: string, bps: number) => new Dec(usd).div(priceAt(bps));

function quote(over: Partial<AgenticQuoteView> & { bps?: number } = {}): AgenticQuoteView {
  return {
    quotedAt: at(20),
    fromCoinSymbol: "USDT",
    fromCoinAmount: "20",
    toCoinSymbol: "NVDAon",
    toCoinAmount: tokensFor("20", over.bps ?? 5).toFixed(18),
    ...over,
  };
}
const exec = (q: AgenticQuoteView, over: { asOf?: string; decision?: DecisionTicket } = {}) =>
  prepareAgenticExecution({ decision: over.decision ?? decision, policy: DEFAULT_POLICY, asOf: over.asOf ?? at(30), user: USER, quote: q, quoteAsset: USDT });

describe("prepareAgenticExecution: the Agentic Wallet quote against the decision", () => {
  it("allows a fresh quote for the ticket's token, dollars and price", () => {
    const t = exec(quote());
    expect(t.verdict).toBe("ALLOW");
    expect(t.executionMode).toBe("AGENTIC");
    expect(t.toToken).toBe(NVDAON);
    expect(t.slippageBps).toBe(5);
    expect(t.narration).toMatch(/Agentic Wallet.*checks the fill on BSC/);
    expect(ticketHash(t as unknown as Record<string, unknown>)).toBe(t.hash);
  });
  it("blocks a quote for another issuer's symbol, or not paid in USDT", () => {
    expect(exec(quote({ toCoinSymbol: "NVDAB" })).reasons).toEqual(["ISSUER_MISMATCH"]);
    expect(exec(quote({ fromCoinSymbol: "BNB" })).reasons).toEqual(["ISSUER_MISMATCH"]);
  });
  it("blocks the wrong dollars, a worse price, a stale quote, a stale or non-ALLOW decision", () => {
    expect(exec(quote({ fromCoinAmount: "25" })).reasons).toEqual(["AMOUNT_MISMATCH"]);
    expect(exec(quote({ bps: 80 })).reasons).toEqual(["SLIPPAGE"]);
    expect(exec(quote({ quotedAt: at(0) }), { asOf: at(40) }).reasons).toEqual(["QUOTE_STALE"]);
    expect(exec(quote({ quotedAt: at(200) }), { asOf: at(210) }).reasons).toEqual(["DECISION_STALE"]);
    expect(exec(quote(), { decision: golden("nflx-bare-one") }).reasons).toEqual(["DECISION_NOT_ALLOWED"]);
  });
  it("blocks a decision that was edited after hashing", () => {
    expect(exec(quote(), { decision: { ...decision, notionalUsd: "2000.00" } }).reasons).toEqual(["TICKET_TAMPERED"]);
  });
});

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transfer = (token: string, from: string, to: string, amount: Dec): ReceiptLog => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${BigInt(amount.mul(new Dec(10).pow(18)).floor().toFixed(0)).toString(16)}`,
});

function fill(over: Partial<FillInput> & { bps?: number; logs?: ReceiptLog[] } = {}): FillInput {
  const got = tokensFor("20", over.bps ?? 12);
  return {
    decision,
    policy: DEFAULT_POLICY,
    asOf: at(60),
    user: USER,
    orderStatus: "FINISHED",
    txHash: `0x${"ab".repeat(32)}`,
    receiptStatus: "success",
    logs: [transfer(USDT, USER, POOL, new Dec(20)), transfer(NVDAON, POOL, USER, got)],
    tokenDecimals: 18,
    quoteAsset: USDT,
    quoteDecimals: 18,
    ...over,
  };
}

describe("verifyFill: the BSC receipt against the decision", () => {
  it("verifies the ticket's token arriving at about the ticket's price", () => {
    const f = verifyFill(fill());
    expect(f.verified).toBe(true);
    expect(f.spentUsd).toBe("20.00");
    expect(f.slippageBps).toBe(12);
    expect(f.narration).toMatch(/^FILLED and verified/);
    expect(ticketHash(f as unknown as Record<string, unknown>)).toBe(f.hash);
  });
  it("flags a sibling issuer's token, however cheap", () => {
    const f = verifyFill(fill({ logs: [transfer(USDT, USER, POOL, new Dec(20)), transfer(NVDAB, POOL, USER, new Dec("0.1"))] }));
    expect(f.reasons).toEqual(["FILL_WRONG_TOKEN"]);
    expect(f.siblingReceived).toBe(NVDAB);
  });
  it("flags nothing received, a failed order, and a fill past the slippage limit", () => {
    expect(verifyFill(fill({ logs: [transfer(USDT, USER, POOL, new Dec(20))] })).reasons).toEqual(["FILL_NOT_RECEIVED"]);
    expect(verifyFill(fill({ orderStatus: "FAILED", txHash: null, receiptStatus: null })).reasons).toEqual(["FILL_FAILED"]);
    expect(verifyFill(fill({ receiptStatus: "reverted" })).reasons).toEqual(["FILL_FAILED"]);
    expect(verifyFill(fill({ bps: 90 })).reasons).toEqual(["FILL_SLIPPAGE"]);
  });
  it("ignores transfers that are not to or from this wallet", () => {
    const other = "0x2222222222222222222222222222222222222222";
    const logs = [...fill().logs, transfer(NVDAB, POOL, other, new Dec(5))];
    expect(verifyFill(fill({ logs })).verified).toBe(true);
  });
});
