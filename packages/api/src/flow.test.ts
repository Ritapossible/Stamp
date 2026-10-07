import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildUniverse, type CaptureFile, FakeWallet, fromCapture, SnapshotStore } from "@stamp/sources";
import { describe, expect, it } from "vitest";
import { createApp, type MarketSource } from "./app.js";
import { ExecutionService } from "./execution.js";
import { MAX_ACTIVE, StandingService } from "./standing.js";
import { TicketStore } from "./tickets.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const probe = (f: string) => JSON.parse(readFileSync(`${root}fixtures/probe-2026-09-25/${f}`, "utf8"));
const captured = fromCapture(probe("capture-101145.json") as CaptureFile, buildUniverse(probe("list.json").data).rows);
const market: MarketSource = { forIntent: async () => captured };
const USER = "0x1111111111111111111111111111111111111111";
const SIG = "0x" + "ab".repeat(65);

async function setup(withWallet = true, balances?: Record<string, string>) {
  let clock = Date.parse(captured.asOf) + 5_000;
  const now = () => new Date(clock).toISOString();
  const store = TicketStore.memory();
  const wallet = new FakeWallet((t) => store.latestTokenPrice(t)!, now);
  if (balances) wallet.balances = async () => ({ balances });
  const execution = withWallet ? new ExecutionService({ wallet, store, now }) : null;
  const standing = await StandingService.open({ market, store, snapshots: () => new SnapshotStore([]), execution, path: null, now });
  const app = createApp({ market, store, snapshots: () => new SnapshotStore([]), fixturesDir: `${root}fixtures`, rateLimitPerMin: 0, execution, standing });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, standing, advance: (sec: number) => (clock += sec * 1000) };
}

describe("one-off execution", () => {
  it("answers 501 when no wallet is configured, instead of pretending", async () => {
    const { call } = await setup(false);
    const { body: t } = await call("POST", "/v1/tickets", { intent: "Buy $20 of NVIDIA" });
    const r = await call("POST", "/v1/execution", { decisionHash: t.ticket.hash, user: USER });
    expect(r.status).toBe(501);
    expect(r.body.error).toMatch(/execution unavailable/);
  });

  it("ALLOW decision → review → sign → submit → FILLED", async () => {
    const { call } = await setup();
    const { body: t } = await call("POST", "/v1/tickets", { intent: "Buy $20 of NVIDIA" });
    expect(t.ticket.verdict).toBe("ALLOW");

    const review = await call("POST", "/v1/execution", { decisionHash: t.ticket.hash, user: USER });
    expect(review.status).toBe(200);
    expect(review.body.wallet).toBe("fake");
    expect(review.body.ticket).toMatchObject({ verdict: "ALLOW", decisionHash: t.ticket.hash, vendor: "fake", amountInUsd: "20.00" });
    expect(review.body.typedData.message.taker).toBe(USER);

    const hash = review.body.ticket.hash;
    const sub = await call("POST", `/v1/execution/${hash}/submit`, { signature: SIG });
    expect(sub.body.status).toBe("PENDING");
    expect((await call("GET", `/v1/execution/${hash}`)).body.status).toBe("FILLED");
    expect((await call("POST", `/v1/execution/${hash}/submit`, { signature: SIG })).status).toBe(409);
  });

  it("stops before any approval or signature when the Wallet API says the wallet can't pay", async () => {
    const { call } = await setup(true, { "0x55d398326f99059ff775485246999027b3197955": "7.25", "": "0.01" });
    const { body: t } = await call("POST", "/v1/tickets", { intent: "Buy $20 of NVIDIA" });
    const review = await call("POST", "/v1/execution", { decisionHash: t.ticket.hash, user: USER });
    expect(review.body.ticket).toMatchObject({ verdict: "BLOCK", reasons: ["INSUFFICIENT_BALANCE"], balanceQuoteAsset: "7.25" });
    expect(review.body.typedData).toBeNull();
    expect(review.body.tx).toBeNull();
  });

  it("refuses to quote a BLOCK decision", async () => {
    const { call } = await setup();
    const { body: t } = await call("POST", "/v1/tickets", { intent: "Buy 1 NFLX" });
    const r = await call("POST", "/v1/execution", { decisionHash: t.ticket.hash, user: USER });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/BLOCK \(UNIT_AMBIGUOUS\)/);
  });

  it("refuses a signature after the quote expired", async () => {
    const { call, advance } = await setup();
    const { body: t } = await call("POST", "/v1/tickets", { intent: "Buy $20 of NVIDIA" });
    const review = await call("POST", "/v1/execution", { decisionHash: t.ticket.hash, user: USER });
    advance(31);
    const r = await call("POST", `/v1/execution/${review.body.ticket.hash}/submit`, { signature: SIG });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/review again/);
  });

  it("stops an ALLOW under Binance's $5 minimum before asking Binance for a quote", async () => {
    const { call } = await setup();
    const { body: t } = await call("POST", "/v1/tickets", { intent: "Buy $0.01 of NVIDIA" });
    expect(t.ticket.verdict).toBe("ALLOW");
    const review = await call("POST", "/v1/execution", { decisionHash: t.ticket.hash, user: USER });
    expect(review.status).toBe(409);
    expect(review.body.error).toMatch(/minimum order is \$5; this order is \$0\.01/);
  });

  it("validates inputs", async () => {
    const { call } = await setup();
    expect((await call("POST", "/v1/execution", { decisionHash: "x", user: USER })).status).toBe(400);
    expect((await call("POST", "/v1/execution", { decisionHash: "a".repeat(64), user: USER })).status).toBe(404);
    expect((await call("POST", "/v1/execution", { decisionHash: "a".repeat(64), user: "bob" })).status).toBe(400);
  });
});

describe("standing order", () => {
  it("READY → review → AWAITING_SIGNATURE → submit → FILLED, and the daily cap stops the third fill", async () => {
    const { call, standing } = await setup();

    for (let i = 1; i <= 2; i++) {
      const created = await call("POST", "/v1/standing", { intent: "Buy $20 of NVIDIA", user: USER });
      expect(created.body.state).toBe("READY");
      const id = created.body.id;
      expect((await call("POST", `/v1/standing/${id}/review`, { user: USER })).body.state).toBe("AWAITING_SIGNATURE");
      expect((await call("POST", `/v1/standing/${id}/submit`, { signature: SIG, user: USER })).body.state).toBe("SUBMITTED");
      await standing.tick();
      expect(standing.get(id)!.state).toBe("FILLED");
      expect(standing.filledTodayUsd()).toBe(`${20 * i}.00`);
    }

    const third = await call("POST", "/v1/standing", { intent: "Buy $20 of NVIDIA", user: USER });
    expect(third.body.state).toBe("PARKED");
    expect(third.body.events.at(-1).note).toBe("BLOCK OVER_CAP");
  });

  it("parks a BLOCK intent and allows only one active order", async () => {
    const { call } = await setup();
    const a = await call("POST", "/v1/standing", { intent: "Buy 1 NFLX", user: USER });
    expect(a.body.state).toBe("PARKED");
    expect((await call("POST", "/v1/standing", { intent: "Buy $20 of NVIDIA", user: USER })).status).toBe(409);
    expect((await call("POST", `/v1/standing/${a.body.id}/review`, { user: USER })).status).toBe(409);
    expect((await call("POST", `/v1/standing/${a.body.id}/cancel`, { user: USER })).body.state).toBe("CANCELLED");
    expect((await call("GET", `/v1/standing?user=${USER}`)).body.orders).toHaveLength(1);
  });

  it("keeps each wallet's orders, cap and actions to that wallet", async () => {
    const { call } = await setup();
    const OTHER = "0x2222222222222222222222222222222222222222";
    const a = await call("POST", "/v1/standing", { intent: "Buy 1 NFLX", user: USER });
    // another visitor can park their own order, and doesn't see or touch the first one
    expect((await call("POST", "/v1/standing", { intent: "Buy 1 NFLX", user: OTHER })).status).toBe(200);
    expect((await call("GET", `/v1/standing?user=${OTHER}`)).body.orders.map((o: { user: string }) => o.user)).toEqual([OTHER]);
    expect((await call("POST", `/v1/standing/${a.body.id}/cancel`, { user: OTHER })).status).toBe(403);
    expect((await call("POST", `/v1/standing/${a.body.id}/cancel`)).status).toBe(400);
    expect((await call("GET", "/v1/standing")).status).toBe(400);
  });

  it("caps how many active orders the server holds", async () => {
    const { call } = await setup();
    const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
    for (let i = 1; i <= MAX_ACTIVE; i++) expect((await call("POST", "/v1/standing", { intent: "Buy 1 NFLX", user: addr(i) })).status).toBe(200);
    expect((await call("POST", "/v1/standing", { intent: "Buy 1 NFLX", user: addr(MAX_ACTIVE + 1) })).status).toBe(503);
  });

  it("parks again when the human does not sign before the quote expires", async () => {
    const { call, standing, advance } = await setup();
    const { body } = await call("POST", "/v1/standing", { intent: "Buy $20 of NVIDIA", user: USER });
    await call("POST", `/v1/standing/${body.id}/review`, { user: USER });
    advance(26);
    await standing.tick(); // one step per tick: the expired quote parks the order
    expect(standing.get(body.id)!.state).toBe("PARKED");
    await standing.tick(); // the next tick re-decides it
    expect(standing.get(body.id)!.state).toBe("READY");
    expect(standing.get(body.id)!.events.map((e) => e.state)).toEqual(["PARKED", "READY", "AWAITING_SIGNATURE", "PARKED", "READY"]);
  });
});
