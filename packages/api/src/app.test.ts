import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUniverse, type CaptureFile, fromCapture, SnapshotStore } from "@stamp/sources";
import { describe, expect, it } from "vitest";
import { createApp, type MarketSource } from "./app.js";
import { TicketStore } from "./tickets.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const probe = (f: string) => JSON.parse(readFileSync(`${root}fixtures/probe-2026-09-25/${f}`, "utf8"));
const universe = buildUniverse(probe("list.json").data).rows;
const captured = fromCapture(probe("capture-101145.json") as CaptureFile, universe);
const golden = (name: string) => JSON.parse(readFileSync(`${root}fixtures/golden/${name}.json`, "utf8")).ticket;

const fixedMarket: MarketSource = { forIntent: async () => captured };

function app(opts: { market?: MarketSource; store?: TicketStore; rateLimitPerMin?: number } = {}) {
  return createApp({
    market: opts.market ?? fixedMarket,
    store: opts.store ?? TicketStore.memory(),
    snapshots: () => new SnapshotStore([]),
    fixturesDir: `${root}fixtures`,
    rateLimitPerMin: opts.rateLimitPerMin ?? 0,
  });
}

const post = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /v1/tickets", () => {
  it("decides from market data and matches the golden ticket", async () => {
    const res = await post(app(), "/v1/tickets", { intent: "Buy 1 NFLX" });
    expect(res.status).toBe(200);
    const { ticket, verify } = await res.json();
    expect(ticket.hash).toBe(golden("nflx-bare-one").hash);
    expect(verify).toBe(`/v1/tickets/${ticket.hash}`);
  });

  it("applies a policy override", async () => {
    const { ticket } = await (await post(app(), "/v1/tickets", { intent: "Buy $20 of NFLXx", policy: { issuer: "xstock" } })).json();
    expect(ticket.hash).toBe(golden("nflxx-multiplier-conflict").hash);
  });

  it.each([
    [{}, "bad request"],
    [{ intent: "" }, "bad request"],
    [{ intent: "Buy $20 of NVDA", extra: 1 }, "bad request"],
    [{ intent: "Buy $20 of NVDA", policy: { neverSwitchIssuer: false } }, "bad request"],
    [{ intent: "Buy $20 of NVDA", policy: { maxOrderUsd: "0" } }, "bad policy"],
    [{ intent: "Buy $20 of NVDA", policy: { quoteTtlSec: 60 } }, "bad request"],
  ])("rejects %j", async (body, error) => {
    const res = await post(app(), "/v1/tickets", body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
  });

  it("returns 503 when Binance is unavailable, never a guessed ticket", async () => {
    const down: MarketSource = { forIntent: async () => Promise.reject(new Error("RWA list unavailable: HTTP 451")) };
    const res = await post(app({ market: down }), "/v1/tickets", { intent: "Buy $20 of NVIDIA" });
    expect(res.status).toBe(503);
  });

  it("rate limits per client", async () => {
    const a = app({ rateLimitPerMin: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post(a, "/v1/tickets", { intent: "Buy 1 NFLX" })).status);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe("GET /v1/tickets/:hash and POST /v1/verify", () => {
  it("stores trimmed inputs that still reproduce the ticket, and verifies them", async () => {
    const a = app();
    const { ticket } = await (await post(a, "/v1/tickets", { intent: "Buy $20 of NVIDIA", policy: { issuer: "bstock" } })).json();
    const stored = await (await a.request(`/v1/tickets/${ticket.hash}`)).json();
    expect(stored.ticket.hash).toBe(ticket.hash);
    expect(stored.input.universe.length).toBeLessThan(10);

    const v = await (await post(a, "/v1/verify", stored)).json();
    expect(v).toMatchObject({ hash: ticket.hash, matches: true, verdict: "ALLOW" });
  });

  it("detects a ticket edited after the fact", async () => {
    const a = app();
    const { ticket } = await (await post(a, "/v1/tickets", { intent: "Buy 1 NFLX" })).json();
    const stored = await (await a.request(`/v1/tickets/${ticket.hash}`)).json();
    const forged = { ...stored.ticket, verdict: "ALLOW" };
    const v = await (await post(a, "/v1/verify", { input: stored.input, ticket: forged })).json();
    expect(v.matches).toBe(false);
    expect(v.verdict).toBe("BLOCK");
  });

  it("404s an unknown hash and 400s a malformed verify body", async () => {
    const a = app();
    expect((await a.request("/v1/tickets/deadbeef")).status).toBe(404);
    expect((await post(a, "/v1/verify", { input: { intent: 1 } })).status).toBe(400);
  });

  it("refuses to serve a ticket edited on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stamp-"));
    const path = join(dir, "tickets.jsonl");
    const store = await TicketStore.open(path);
    const { ticket } = await (await post(app({ store }), "/v1/tickets", { intent: "Buy 1 NFLX" })).json();
    await writeFile(path, (await readFile(path, "utf8")).replace('"verdict":"BLOCK"', '"verdict":"ALLOW"'));
    const reopened = await TicketStore.open(path);
    expect((await app({ store: reopened }).request(`/v1/tickets/${ticket.hash}`)).status).toBe(500);
  });
});

describe("GET /v1/replay", () => {
  it("recomputes every recorded ticket", async () => {
    const body = await (await app().request("/v1/replay")).json();
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(100);
  });
});
