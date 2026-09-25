import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY, type DecisionTicket, prepareExecution } from "@stamp/engine";
import { describe, expect, it } from "vitest";
import { signRequest, TradingApiClient, TradingApiError, TradingApiWallet } from "./trading.js";
import { BSC_USDT, FakeWallet } from "./wallet.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const decision: DecisionTicket = JSON.parse(readFileSync(`${root}fixtures/golden/nvda-usd-ondo.json`, "utf8")).ticket;
const USER = "0x1111111111111111111111111111111111111111";

describe("signRequest (reference values computed independently with Python hmac)", () => {
  it("GET: timestamp + METHOD + /build path + query, empty body", () => {
    expect(signRequest("test-secret", "2026-08-04T00:00:00.000Z", "get", "/build/api/v1/dex/aggregator/quote?binanceChainId=56&amount=20000000000000000000", "")).toBe(
      "M/3Dwom0PASUPXPWDfOM51jxyKlrB4vmjjDetGZZ3GQ=",
    );
  });
  it("POST includes the raw body", () => {
    expect(signRequest("test-secret", "2026-08-04T00:00:01.000Z", "POST", "/build/api/v1/dex/aggregator/order/submit", '{"vendor":"v","quoteId":"o1"}')).toBe(
      "N8xnWi8e6cGuBPnAOX71YGRp/Y33RScmk3QxWhgLZYw=",
    );
  });
});

function fakeFetch(reply: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 300, status, json: async () => reply } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

describe("TradingApiClient", () => {
  it("signs the /build path including the query and sends the three headers", async () => {
    const f = fakeFetch({ code: "0", data: [{ quoteId: "q", executionMode: "RFQ", toTokenAmount: "1" }] });
    const client = new TradingApiClient({ apiKey: "k", secret: "test-secret", fetchFn: f.fn, now: () => new Date("2026-08-04T00:00:00.000Z") });
    await client.get("/api/v1/dex/aggregator/quote", { binanceChainId: "56", amount: "20000000000000000000" });
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://web3.binance.com/build/api/v1/dex/aggregator/quote?binanceChainId=56&amount=20000000000000000000");
    expect(init.headers).toMatchObject({ "X-OC-APIKEY": "k", "X-OC-TIMESTAMP": "2026-08-04T00:00:00.000Z", "X-OC-SIGN": "M/3Dwom0PASUPXPWDfOM51jxyKlrB4vmjjDetGZZ3GQ=" });
  });

  it("turns an API error code into an error, never data", async () => {
    const f = fakeFetch({ code: "40102", msg: "Invalid signature" });
    const client = new TradingApiClient({ apiKey: "k", secret: "s", fetchFn: f.fn });
    await expect(client.get("/x", {})).rejects.toThrow(/Invalid signature \(code 40102\)/);
  });
});

describe("TradingApiWallet parsing", () => {
  const wallet = (reply: unknown) => new TradingApiWallet(new TradingApiClient({ apiKey: "k", secret: "s", fetchFn: fakeFetch(reply).fn }), () => "2026-09-25T10:12:00.000Z");
  const req = { fromToken: BSC_USDT, toToken: decision.chosen!.contractAddress, amountInRaw: "20000000000000000000", user: USER };

  it("reads the documented fields", async () => {
    const q = await wallet({ code: "0", data: [{ quoteId: "q1", executionMode: "RFQ", vendorName: "v", toTokenAmount: "88000000000000000" }] }).quote(req);
    expect(q).toMatchObject({ quoteId: "q1", executionMode: "RFQ", vendor: "v", amountOutRaw: "88000000000000000" });
  });

  it("fails loudly on an unknown shape instead of guessing an amount", async () => {
    await expect(wallet({ code: "0", data: [{ quoteId: "q1", executionMode: "RFQ" }] }).quote(req)).rejects.toBeInstanceOf(TradingApiError);
    await expect(wallet({ code: "0", data: [{ quoteId: "q1", executionMode: "LIMIT", toTokenAmount: "1" }] }).quote(req)).rejects.toThrow(/executionMode/);
  });

  it("requires rfq.typedDataToSign and rfq.orderId for RFQ", async () => {
    const quote = { quoteId: "q1", quotedAt: "t", executionMode: "RFQ" as const, vendor: "v", fromToken: BSC_USDT, toToken: req.toToken, amountInRaw: "1", amountOutRaw: "1", fromDecimals: 18, toDecimals: 18 };
    await expect(wallet({ code: "0", data: { rfq: { orderId: "o" } } }).prepare(quote, USER, 50)).rejects.toThrow(/typedDataToSign/);
    const p = await wallet({ code: "0", data: { rfq: { orderId: "o", typedDataToSign: { domain: {} } } } }).prepare(quote, USER, 50);
    expect(p).toMatchObject({ mode: "RFQ", orderId: "o" });
  });
});

describe("FakeWallet → prepareExecution", () => {
  it("produces an execution ALLOW for a fresh ALLOW decision", async () => {
    const quotedAt = new Date(Date.parse(decision.asOf) + 10_000).toISOString();
    const w = new FakeWallet(() => decision.tokenPriceUsd!, () => quotedAt);
    const quote = await w.quote({ fromToken: BSC_USDT, toToken: decision.chosen!.contractAddress, amountInRaw: "20000000000000000000", user: USER });
    const prepared = await w.prepare(quote, USER);
    const t = prepareExecution({
      decision,
      policy: DEFAULT_POLICY,
      asOf: quotedAt,
      user: USER,
      quoteAsset: BSC_USDT,
      quote,
      typedData: prepared.typedData,
      swapSimulation: null,
      approvalSimulation: null,
    });
    expect(t.verdict).toBe("ALLOW");
    expect(t.vendor).toBe("fake");
    const { orderId } = await w.submit({ quote, orderId: prepared.orderId!, signature: "0xsig" });
    expect(await w.status(orderId)).toBe("FILLED");
  });
});
