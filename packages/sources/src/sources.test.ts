import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, DEFAULT_POLICY, type DecisionTicket } from "@stamp/engine";
import { describe, expect, it } from "vitest";
import { toMarketView } from "./adapters.js";
import { fromCapture, type CaptureFile } from "./capture.js";
import { buildUniverse, familyRows } from "./classify.js";
import { LiveMarket } from "./market.js";
import { RwaClient } from "./rwa.js";
import { parseSnapshotLines, SnapshotStore } from "./snapshots.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(`${root}${p}`, "utf8"));
const probe = (f: string) => json(`fixtures/probe-2026-09-25/${f}`);

const list = buildUniverse(probe("list.json").data);
const row = (symbol: string) => list.rows.find((r) => r.chainId === "56" && r.symbol === symbol)!;

describe("buildUniverse", () => {
  it("keeps every chain, lowercases BSC addresses, and records BSC types", () => {
    expect(list.rows).toHaveLength(1925);
    expect(list.malformed).toBe(0);
    expect(list.bscTypes).toEqual([1, 2, 3, 4, 9]);
    expect(list.rows.filter((r) => r.symbol === "NFLXon").map((r) => r.chainId).sort()).toEqual(["1", "56", "CT_501"]);
  });

  it("drops malformed rows instead of guessing", () => {
    const u = buildUniverse([
      { chainId: "56", contractAddress: "not-an-address", symbol: "X", ticker: "X", type: 1 },
      { chainId: "56", contractAddress: "0x" + "a".repeat(40), symbol: "Y", ticker: "Y", type: "1" as never },
      { chainId: "56", contractAddress: "0x" + "B".repeat(40), symbol: "Z", ticker: "Z", type: 3, multiplier: "1" },
    ]);
    expect(u.malformed).toBe(2);
    expect(u.rows[0]!.contractAddress).toBe("0x" + "b".repeat(40));
  });

  it("finds the priceable family of a ticker (excludes pre-IPO type 4)", () => {
    expect(familyRows(list.rows, "NVDA").map((r) => r.symbol).sort()).toEqual(["NVDAB", "NVDAon", "NVDAx"]);
    expect(familyRows(list.rows, "OPENAI")).toHaveLength(0);
  });
});

describe("toMarketView (per-issuer shapes from the live probe)", () => {
  it("Ondo: full status and stock price", () => {
    const v = toMarketView(row("NFLXon"), probe("NFLXon.dynamic.json").data, "t");
    expect(v).toMatchObject({ complete: true, multiplier: "10", listMultiplier: "10", stockPriceUsd: "71.603333" });
    expect(v.assetStatus).toEqual({ openState: true, marketStatus: "premarket", reasonCode: "TRADING", reasonMsg: null });
  });

  it("bStock: no marketStatus and no stock price, passed through as null", () => {
    const v = toMarketView(row("NVDAB"), probe("NVDAB.dynamic.json").data, "t");
    expect(v.stockPriceUsd).toBeNull();
    expect(v.assetStatus?.marketStatus).toBeNull();
    expect(v.assetStatus?.reasonCode).toBe("TRADING");
  });

  it("xStock data: null → incomplete, nothing filled in", () => {
    const v = toMarketView(row("NVDAx"), null, "t");
    expect(v).toMatchObject({ complete: false, tokenPriceUsd: null, multiplier: null, assetStatus: null, listMultiplier: "1" });
  });

  it("rejects numeric prices (JSON numbers have already lost precision)", () => {
    const v = toMarketView(row("NVDAon"), { symbol: "NVDAon", ticker: "NVDA", type: 1, tokenInfo: { price: 226.4 as never, sharesMultiplier: "1" } }, "t");
    expect(v.tokenPriceUsd).toBeNull();
  });
});

describe("fromCapture → engine matches the golden tickets", () => {
  const capture = probe("capture-101145.json") as CaptureFile;
  const inputs = fromCapture(capture, list.rows);
  const golden = (name: string): DecisionTicket => json(`fixtures/golden/${name}.json`).ticket;

  it.each([
    ["nvda-usd-ondo", "Buy $20 of NVIDIA", {}],
    ["nflx-bare-one", "Buy 1 NFLX", {}],
    ["nflxx-multiplier-conflict", "Buy $20 of NFLXx", { issuer: "xstock" as const }],
    ["mux-implausible", "Buy $20 of Micron", { issuer: "xstock" as const }],
    ["nvda-bstock-sibling-reference", "Buy $20 of NVIDIA", { issuer: "bstock" as const }],
  ])("%s", (name, intent, policy) => {
    const ticket = decide({ ...inputs, intent, policy: { ...DEFAULT_POLICY, ...policy }, lastOfficialClose: null, filledTodayUsd: "0" });
    expect(ticket.hash).toBe(golden(name).hash);
  });

  it("covers all 54 captured instruments and the venue", () => {
    expect(inputs.views).toHaveLength(54);
    expect(inputs.venue).toEqual({ marketStatus: "premarket", openState: true });
    expect(inputs.asOf).toBe("2026-09-25T10:11:45.769Z");
  });
});

describe("SnapshotStore", () => {
  const line = (capturedAt: string, venueMarketStatus: string, stockPrice: string | null) =>
    JSON.stringify({ capturedAt, ticker: "NVDA", venueMarketStatus, stockPrice, stockPriceFrom: "NVDAon" });
  const text = [
    line("2026-09-25T19:40:00Z", "regular", "226.10"),
    line("2026-09-25T19:50:00Z", "regular", "226.30"),
    line("2026-09-25T20:10:00Z", "postmarket", "226.90"),
    line("2026-09-25T19:55:00Z", "regular", null),
    "{not json",
  ].join("\n");

  it("returns the last regular-session print at or before asOf", () => {
    const { rows, bad } = parseSnapshotLines(text);
    expect(bad).toBe(1);
    const store = new SnapshotStore(rows);
    expect(store.lastOfficialClose("NVDA", "2026-09-26T15:00:00Z")).toEqual({ ticker: "NVDA", priceUsd: "226.30", asOf: "2026-09-25T19:50:00Z" });
    expect(store.lastOfficialClose("NVDA", "2026-09-25T19:45:00Z")?.priceUsd).toBe("226.10");
    expect(store.lastOfficialClose("NVDA", "2026-09-25T19:00:00Z")).toBeNull();
    expect(store.lastOfficialClose("MU", "2026-09-26T15:00:00Z")).toBeNull();
  });

  it("is empty, not an error, when the directory is missing", async () => {
    expect((await SnapshotStore.fromDir("/nonexistent/stamp")).size).toBe(0);
  });
});

describe("LiveMarket (fake network)", () => {
  it("fetches the venue and the whole family for an intent, and reuses the list", async () => {
    const urls: string[] = [];
    const capture = probe("capture-101145.json") as CaptureFile;
    const fetchFn = (async (url: string) => {
      urls.push(url);
      let data: unknown = null;
      if (url.endsWith("/stock/detail/list/ai")) data = probe("list.json").data;
      else if (url.endsWith("/market/status/ai")) data = capture.venue!.data;
      else data = capture.dynamic[new URL(url).searchParams.get("contractAddress")!]?.body?.data ?? null;
      return { ok: true, status: 200, json: async () => ({ code: "000000", success: true, data, message: null }) } as Response;
    }) as typeof fetch;
    const market = new LiveMarket(new RwaClient({ fetchFn, retryDelayMs: 0 }), { nowIso: () => "2026-09-25T10:11:45.769Z" });

    const a = await market.forIntent("Buy $20 of NVIDIA", DEFAULT_POLICY);
    expect(a.views.map((v) => v.contractAddress).sort()).toEqual([row("NVDAB"), row("NVDAon"), row("NVDAx")].map((r) => r.contractAddress).sort());
    await market.forIntent("Buy 1 NFLX", DEFAULT_POLICY);
    expect(urls.filter((u) => u.endsWith("/list/ai"))).toHaveLength(1);

    const t = decide({ ...a, intent: "Buy $20 of NVIDIA", policy: DEFAULT_POLICY, lastOfficialClose: null, filledTodayUsd: "0" });
    expect(t.hash).toBe(json("fixtures/golden/nvda-usd-ondo.json").ticket.hash);
  });

  it("fetches nothing per-instrument for an unparseable intent", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      const data = url.endsWith("/list/ai") ? probe("list.json").data : { marketStatus: "closed", openState: true };
      return { ok: true, status: 200, json: async () => ({ code: "000000", success: true, data, message: null }) } as Response;
    }) as typeof fetch;
    const m = await new LiveMarket(new RwaClient({ fetchFn, retryDelayMs: 0 })).forIntent("sell everything", DEFAULT_POLICY);
    expect(m.views).toEqual([]);
    expect(urls.some((u) => u.includes("/dynamic/"))).toBe(false);
  });
});
