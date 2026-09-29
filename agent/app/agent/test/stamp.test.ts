import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkPrompt, StampInputError, stampTicket, stampWork } from "../src/stamp";

describe("parseWorkPrompt", () => {
  it("takes the order as plain text", () => {
    expect(parseWorkPrompt("  Buy $20 of NVIDIA ")).toEqual({ intent: "Buy $20 of NVIDIA" });
  });
  it("takes JSON with an issuer", () => {
    expect(parseWorkPrompt('{"intent":"Buy $20 of NVDAx","issuer":"xstock"}')).toEqual({ intent: "Buy $20 of NVDAx", issuer: "xstock" });
    expect(parseWorkPrompt('{"intent":"Buy $20 of NVDAx","issuer":null}')).toEqual({ intent: "Buy $20 of NVDAx", issuer: null });
  });
  it("rejects what the API would reject, before calling it", () => {
    expect(() => parseWorkPrompt("{nope")).toThrow(StampInputError);
    expect(() => parseWorkPrompt('{"issuer":"ondo"}')).toThrow(StampInputError);
    expect(() => parseWorkPrompt('{"intent":"Buy 1 NFLX","issuer":"robinhood"}')).toThrow(StampInputError);
    expect(() => parseWorkPrompt("x".repeat(201))).toThrow(StampInputError);
  });
});

describe("stampTicket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the ticket through and sends the issuer as a policy patch", async () => {
    const ticket = { verdict: "BLOCK", reasons: ["UNIT_AMBIGUOUS"], notes: [], narration: "BLOCK. …", hash: "a".repeat(64), chosen: { symbol: "NFLXon", issuer: "ondo", contractAddress: "0x70", ticker: "NFLX" } };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ticket }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const out = await stampTicket({ intent: "Buy 1 NFLX", issuer: "ondo" });
    expect(out.verdict).toBe("BLOCK");
    expect(out.reasons).toEqual(["UNIT_AMBIGUOUS"]);
    expect(out.verifyUrl).toMatch(/\/proof\/\?hash=a{64}$/);
    expect(out.ticket).toEqual(ticket);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/tickets$/);
    expect(JSON.parse(String(init.body))).toEqual({ intent: "Buy 1 NFLX", policy: { issuer: "ondo" } });
  });

  it("returns the work result as JSON text for the /x402 route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: { verdict: "ALLOW", reasons: ["OK"], notes: [], narration: "", hash: "b".repeat(64), chosen: null } }))));
    expect(JSON.parse(await stampWork("Buy $20 of NVIDIA")).verdict).toBe("ALLOW");
  });
});
