import { describe, expect, it } from "vitest";
import { parseIntent } from "./intent.js";

const ok = (raw: string) => {
  const r = parseIntent(raw);
  if (!r.ok) throw new Error(`expected ok: ${raw} (${r.problem})`);
  return r.intent;
};

describe("parseIntent", () => {
  it.each([
    ["Buy $20 of NVIDIA", "usd", "20", "NVIDIA"],
    ["$20.50 worth of NVDAon", "usd", "20.5", "NVDAon"],
    ["buy 20 USDT of Netflix stock", "usd", "20", "Netflix"],
    ["Buy 1 share of Netflix", "shares", "1", "Netflix"],
    ["Buy 2 shares NVDA.", "shares", "2", "NVDA"],
    ["buy 0.5 NFLXon tokens", "tokens", "0.5", "NFLXon"],
    ["Buy 1 NFLX", "ambiguous", "1", "NFLX"],
    ["  buy   3   the  Apple  ", "ambiguous", "3", "Apple"],
  ])("%s → %s %s %s", (raw, unit, amount, query) => {
    const i = ok(raw);
    expect([i.unit, i.amount, i.query, i.side]).toEqual([unit, amount, query, "buy"]);
  });

  it.each(["Sell 5 NVDA", "buy NVDA", "Buy $0 of NVDA", "Buy $-5 of NVDA", "Buy $1e3 of NVDA", "", "x".repeat(201)])(
    "rejects %j",
    (raw) => {
      expect(parseIntent(raw).ok).toBe(false);
    },
  );
});
