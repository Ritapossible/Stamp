import { describe, expect, it } from "vitest";
import { Dec, parseDec, toInt } from "./decimal.js";
import { DEFAULT_POLICY, policyHash, validatePolicy } from "./policy.js";
import { economicPrice, overpayUsd, premiumBps } from "./premium.js";
import { bothReadings, toAmounts } from "./unit.js";

describe("parseDec", () => {
  it("accepts plain decimals, including 39-place API prices", () => {
    expect(parseDec("224.269085228744065903122755434969591456")?.toString()).toBe("224.269085228744065903122755434969591456");
  });
  it.each([null, undefined, "", " ", "NaN", "1e3", "Infinity", "0x10", "1,000"])("rejects %j", (v) => {
    expect(parseDec(v as string | null)).toBeNull();
  });
});

describe("premium", () => {
  it("uses Binance's formula on NFLXon (multiplier 10)", () => {
    const e = economicPrice(new Dec("716.15"), new Dec("10"));
    expect(e.toString()).toBe("71.615");
    expect(premiumBps(e, new Dec("71.603333"))).toBe(2);
  });

  it("rounds bps half-even to an integer", () => {
    expect(premiumBps(new Dec("100.025"), new Dec("100"))).toBe(2);
    expect(premiumBps(new Dec("100.035"), new Dec("100"))).toBe(4);
    expect(() => toInt(new Dec("1e20"))).toThrow();
  });

  it("computes overpay as shares bought × excess per share", () => {
    // $20 at +190 bps over 226.00: 20 × (230.294 − 226) / 230.294 ≈ 0.37
    expect(overpayUsd(new Dec("20"), new Dec("230.294"), new Dec("226"))).toBe("0.37");
    expect(overpayUsd(new Dec("20"), new Dec("225"), new Dec("226"))).toBeNull();
  });
});

describe("units", () => {
  const price = new Dec("716.15");
  const m = new Dec("10");

  it("converts USD → tokens → shares", () => {
    expect(toAmounts("usd", new Dec("20"), price, m)).toEqual({ notionalUsd: "20.00", tokenUnits: "0.02792711", economicShares: "0.27927110" });
  });

  it("converts shares → tokens (1 share of NFLX is 0.1 NFLXon)", () => {
    expect(toAmounts("shares", new Dec("1"), price, m)).toEqual({ notionalUsd: "71.62", tokenUnits: "0.10000000", economicShares: "1.00000000" });
  });

  it("shows both readings of a bare number", () => {
    expect(bothReadings(new Dec("1"), price, m)).toEqual({
      asTokens: { tokens: "1.00000000", shares: "10.00000000", usd: "716.15" },
      asShares: { tokens: "0.10000000", shares: "1.00000000", usd: "71.62" },
    });
  });
});

describe("policy", () => {
  it("default policy is valid and its hash is stable", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(policyHash({ ...DEFAULT_POLICY })).toBe(policyHash(DEFAULT_POLICY));
  });

  it("rejects unsafe policies", () => {
    const bad = { ...DEFAULT_POLICY, neverSwitchIssuer: false, quoteTtlSec: 60, maxOrderUsd: "0", noiseBandBps: 1.5 } as never;
    expect(validatePolicy(bad)).toEqual([
      "neverSwitchIssuer must be true",
      "noiseBandBps must be a non-negative integer",
      "quoteTtlSec must be <= 30 (Binance quotes expire in ~30 s)",
      "maxOrderUsd must be a positive decimal string",
    ]);
  });
});
