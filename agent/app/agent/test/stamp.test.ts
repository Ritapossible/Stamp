import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReplayStore } from "../src/replayStore";
import { parseWorkPrompt, precheckOrder, promptFromRequest, StampInputError, stampTicket, stampWork } from "../src/stamp";

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


describe("promptFromRequest: the same text the paid work will see", () => {
  it("reads ?prompt=, then a JSON body's prompt, then the raw body", () => {
    expect(promptFromRequest({ query: { prompt: "Buy 1 NFLX" }, body: '{"prompt":"other"}' })).toBe("Buy 1 NFLX");
    expect(promptFromRequest({ query: {}, body: '{"prompt":"Buy $20 of NVIDIA"}' })).toBe("Buy $20 of NVIDIA");
    expect(promptFromRequest({ query: {}, body: "Buy $20 of NVIDIA" })).toBe("Buy $20 of NVIDIA");
    expect(promptFromRequest({ query: {}, body: '{"intent":"no prompt key"}' })).toBe("");
    expect(promptFromRequest({ query: {}, body: "" })).toBe("");
  });
});

describe("precheckOrder: refused for free, before any payment", () => {
  afterEach(() => vi.unstubAllGlobals());
  const intentApi = (answer: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(answer), { status }));

  it("passes an order Stamp can read", async () => {
    const f = intentApi({ ok: true, intent: {} });
    vi.stubGlobal("fetch", f);
    expect(await precheckOrder('{"intent":"Buy $20 of NVIDIA","issuer":"ondo"}')).toEqual({ ok: true });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ intent: "Buy $20 of NVIDIA" });
  });
  it("refuses empty, malformed, and unreadable orders with 400", async () => {
    vi.stubGlobal("fetch", intentApi({ ok: false, problem: "no instrument named" }));
    for (const p of ["", "{bad json", '{"intent":"Buy 1 NFLX","issuer":"robinhood"}', "hello there"]) {
      const r = await precheckOrder(p);
      expect(r).toMatchObject({ ok: false, status: 400 });
      expect((r as { error: string }).error).toMatch(/not charged/);
    }
  });
  it("refuses with 503 when Stamp's API is down, so nobody pays for no answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await precheckOrder("Buy $20 of NVIDIA")).toMatchObject({ ok: false, status: 503 });
    vi.stubGlobal("fetch", intentApi({ error: "boom" }, 502));
    expect(await precheckOrder("Buy $20 of NVIDIA")).toMatchObject({ ok: false, status: 503 });
  });
});

describe("FileReplayStore: payment records survive a restart", () => {
  const path = () => join(mkdtempSync(join(tmpdir(), "replay-")), "store.json");

  it("sets, reads, deletes, and keeps state across a new instance", async () => {
    const p = path();
    const a = new FileReplayStore(p);
    expect(await a.update("k1", () => ({ op: "set", value: { state: "inflight", ts: 1, token: "t" }, result: "reserved" }))).toBe("reserved");
    await a.update("k1", () => ({ op: "set", value: { state: "consumed", ts: 2 }, result: null }));
    await a.update("k2", () => ({ op: "set", value: { state: "inflight", ts: 3 }, result: null }));
    await a.update("k2", () => ({ op: "delete", result: null }));
    const b = new FileReplayStore(p); // "after a restart"
    expect(await b.get("k1")).toEqual({ state: "consumed", ts: 2 });
    expect(await b.get("k2")).toBeUndefined();
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ k1: { state: "consumed", ts: 2 } });
  });

  it("serialises concurrent updates: exactly one reservation wins", async () => {
    const s = new FileReplayStore(path());
    const reserve = () => s.update("same", (cur) => (cur ? { op: "noop", result: false } : { op: "set", value: { state: "inflight", ts: Date.now() }, result: true }));
    const results = await Promise.all(Array.from({ length: 20 }, reserve));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not change state when the write fails, and keeps working after", async () => {
    const s = new FileReplayStore(path());
    await expect(s.update("x", () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    expect(await s.update("x", () => ({ op: "set", value: { state: "rejected", ts: 1 }, result: "ok" }))).toBe("ok");
  });
});
