import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildUniverse, type CaptureFile, FakeWallet, fromCapture, SnapshotStore } from "@stamp/sources";
import { describe, expect, it } from "vitest";
import { createApp, type MarketSource } from "./app.js";
import { ExecutionService } from "./execution.js";
import { StandingService } from "./standing.js";
import { TicketStore } from "./tickets.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const probe = (f: string) => JSON.parse(readFileSync(`${root}fixtures/probe-2026-09-25/${f}`, "utf8"));
const captured = fromCapture(probe("capture-101145.json") as CaptureFile, buildUniverse(probe("list.json").data).rows);
const market: MarketSource = { forIntent: async () => captured };
const USER = "0x1111111111111111111111111111111111111111";
const SIG = "0x" + "ab".repeat(65);

async function setup(withWallet = true) {
  let clock = Date.parse(captured.asOf) + 5_000;
  const now = () => new Date(clock).toISOString();
  const store = TicketStore.memory();
  const wallet = new FakeWallet((t) => store.latestTokenPrice(t)!, now);
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
      expect((await call("POST", `/v1/standing/${id}/review`)).body.state).toBe("AWAITING_SIGNATURE");
      expect((await call("POST", `/v1/standing/${id}/submit`, { signature: SIG })).body.state).toBe("SUBMITTED");
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
    expect((await call("POST", `/v1/standing/${a.body.id}/review`)).status).toBe(409);
    expect((await call("POST", `/v1/standing/${a.body.id}/cancel`)).body.state).toBe("CANCELLED");
    expect((await call("GET", "/v1/standing")).body.orders).toHaveLength(1);
  });

  it("parks again when the human does not sign before the quote expires", async () => {
    const { call, standing, advance } = await setup();
    const { body } = await call("POST", "/v1/standing", { intent: "Buy $20 of NVIDIA", user: USER });
    await call("POST", `/v1/standing/${body.id}/review`);
    advance(26);
    await standing.tick(); // one step per tick: the expired quote parks the order
    expect(standing.get(body.id)!.state).toBe("PARKED");
    await standing.tick(); // the next tick re-decides it
    expect(standing.get(body.id)!.state).toBe("READY");
    expect(standing.get(body.id)!.events.map((e) => e.state)).toEqual(["PARKED", "READY", "AWAITING_SIGNATURE", "PARKED", "READY"]);
  });
});
