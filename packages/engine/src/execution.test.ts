import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Dec } from "./decimal.js";
import { prepareExecution, rawToDec } from "./execution.js";
import { ticketHash } from "./hash.js";
import { DEFAULT_POLICY } from "./policy.js";
import type { DecisionTicket, ExecuteInput } from "./types.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const golden = (name: string): DecisionTicket => JSON.parse(readFileSync(`${root}fixtures/golden/${name}.json`, "utf8")).ticket;

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const USER = "0x1111111111111111111111111111111111111111";
const decision = golden("nvda-usd-ondo"); // ALLOW, NVDAon, $20.00
const NVDAON = decision.chosen!.contractAddress;
const NVDAB = decision.rejected.find((r) => r.symbol === "NVDAB")!.contractAddress;
const t0 = Date.parse(decision.asOf);
const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();

/** Raw 18-decimal amount of tokens that $20 buys at the decision price moved by `bps`. */
function amountOut(bps: number): string {
  const price = new Dec(decision.tokenPriceUsd!).mul(new Dec(1).plus(new Dec(bps).div(10000)));
  return new Dec(20).div(price).mul(new Dec(10).pow(18)).floor().toFixed(0);
}

/**
 * SYNTHETIC typed data in a plausible RFQ shape. The real field layout comes from the first
 * live quote (plan Day 7); the inspection deliberately does not depend on field names.
 */
function typedData(over: { token?: string; user?: string; out?: string; chainId?: unknown; extra?: unknown } = {}) {
  return {
    domain: { name: "RFQ", version: "1", chainId: over.chainId ?? 56, verifyingContract: "0x2222222222222222222222222222222222222222" },
    primaryType: "Order",
    types: { Order: [{ name: "maker", type: "address" }] },
    message: {
      maker: "0x3333333333333333333333333333333333333333",
      taker: over.user ?? USER,
      makerAsset: over.token ?? NVDAON,
      takerAsset: USDT,
      makerAmount: over.out ?? amountOut(5),
      takerAmount: "20000000000000000000",
      expiry: "1790340000",
      ...(over.extra ? { extra: over.extra } : {}),
    },
  };
}

function input(over: Partial<ExecuteInput> & { bps?: number } = {}): ExecuteInput {
  const out = amountOut(over.bps ?? 5);
  return {
    decision,
    policy: DEFAULT_POLICY,
    asOf: at(30),
    user: USER,
    quoteAsset: USDT,
    quote: {
      quoteId: "q-1",
      quotedAt: at(20),
      executionMode: "RFQ",
      vendor: "vendor-x",
      fromToken: USDT,
      toToken: NVDAON,
      amountInRaw: "20000000000000000000",
      amountOutRaw: out,
      fromDecimals: 18,
      toDecimals: 18,
    },
    typedData: typedData({ out }),
    swapSimulation: null,
    approvalSimulation: null,
    ...over,
  };
}

describe("prepareExecution", () => {
  it("ALLOWs a fresh RFQ quote whose typed data matches the ticket", () => {
    const t = prepareExecution(input());
    expect(t.verdict).toBe("ALLOW");
    expect(t.reasons).toEqual(["OK"]);
    expect(t).toMatchObject({ amountInUsd: "20.00", slippageBps: 5, quoteAgeSec: 10, symbol: "NVDAon", executionMode: "RFQ" });
    expect(t.typedDataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ticketHash(t as unknown as Record<string, unknown>)).toBe(t.hash);
    expect(prepareExecution(input()).hash).toBe(t.hash);
    expect(t.narration).toContain("Ready to sign: $20.00");
  });

  const block = (name: string, over: Partial<ExecuteInput> & { bps?: number }, reason: string) =>
    it(`${name} → BLOCK ${reason}`, () => {
      const t = prepareExecution(input(over));
      expect(t.verdict).toBe("BLOCK");
      expect(t.reasons).toEqual([reason]);
      expect(ticketHash(t as unknown as Record<string, unknown>)).toBe(t.hash);
    });

  block("edited decision", { decision: { ...decision, notionalUsd: "2000.00" } }, "TICKET_TAMPERED");
  block("different policy", { policy: { ...DEFAULT_POLICY, maxSlippageBps: 500 } }, "TICKET_TAMPERED");
  block("decision was BLOCK", { decision: golden("nflx-bare-one") }, "DECISION_NOT_ALLOWED");
  block("decision was WARN", { decision: golden("weekend-rich") }, "DECISION_NOT_ALLOWED");
  block("decision 121 s old", { asOf: at(121), quote: { ...input().quote, quotedAt: at(115) } }, "DECISION_STALE");
  block("quote 26 s old", { asOf: at(46) }, "QUOTE_STALE");
  block("quote from the future", { asOf: at(10) }, "QUOTE_STALE");
  block("quote buys NVDAB", { quote: { ...input().quote, toToken: NVDAB } }, "ISSUER_MISMATCH");
  block("quote pays with another token", { quoteAsset: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" }, "ISSUER_MISMATCH");
  block("quote spends $21", { quote: { ...input().quote, amountInRaw: "21000000000000000000" } }, "AMOUNT_MISMATCH");
  block("non-integer raw amount", { quote: { ...input().quote, amountOutRaw: "1.5" } }, "AMOUNT_MISMATCH");
  block("price 60 bps worse", { bps: 60 }, "SLIPPAGE");
  block("typed data pays someone else", { typedData: typedData({ user: "0x4444444444444444444444444444444444444444" }) }, "TYPED_DATA_MISMATCH");
  block("typed data is for NVDAB", { typedData: typedData({ token: NVDAB }) }, "TYPED_DATA_MISMATCH");
  block("typed data mentions NVDAB too", { typedData: typedData({ extra: NVDAB }) }, "TYPED_DATA_MISMATCH");
  block("typed data on Ethereum", { typedData: typedData({ chainId: 1 }) }, "TYPED_DATA_MISMATCH");
  block("typed data with a float", { typedData: typedData({ extra: 1.5 }) }, "TYPED_DATA_MISMATCH");
  block("no typed data", { typedData: null }, "TYPED_DATA_MISMATCH");
  block("SWAP without a simulation", { quote: { ...input().quote, executionMode: "SWAP" }, typedData: null }, "SIMULATION_FAILED");
  block("approval reverts", { approvalSimulation: { ok: false, error: "execution reverted" } }, "SIMULATION_FAILED");

  it("ALLOWs SWAP mode when the swap simulates", () => {
    const t = prepareExecution(input({ quote: { ...input().quote, executionMode: "SWAP" }, typedData: null, swapSimulation: { ok: true, error: null } }));
    expect(t.verdict).toBe("ALLOW");
    expect(t.typedDataHash).toBeNull();
  });

  it("allows a better-than-decided price (negative slippage)", () => {
    expect(prepareExecution(input({ bps: -30 })).verdict).toBe("ALLOW");
  });

  it("explains a typed-data mismatch in words", () => {
    const t = prepareExecution(input({ typedData: typedData({ extra: NVDAB }) }));
    expect(t.narration).toContain(`another issuer's token ${NVDAB}`);
  });
});

describe("rawToDec", () => {
  it("scales integer strings and rejects anything else", () => {
    expect(rawToDec("20000000000000000000", 18)?.toString()).toBe("20");
    expect(rawToDec("-1", 18)).toBeNull();
    expect(rawToDec("1e18", 18)).toBeNull();
    expect(rawToDec("1", 99)).toBeNull();
  });
});
