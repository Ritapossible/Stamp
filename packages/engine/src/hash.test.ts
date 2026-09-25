import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, ticketHash } from "./hash.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [2, { f: true, e: null }] } })).toBe(
      '{"a":{"c":[2,{"e":null,"f":true}],"d":"x"},"b":1}',
    );
  });

  it("drops undefined properties", () => {
    expect(canonicalJson({ a: undefined, b: "1" })).toBe('{"b":"1"}');
  });

  it("rejects floats so prices must stay strings", () => {
    expect(() => canonicalJson({ price: 226.08 })).toThrow(/use a string/);
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });

  it("keeps decimal strings byte-for-byte", () => {
    expect(canonicalJson({ m: "1.000778223752807865" })).toBe('{"m":"1.000778223752807865"}');
  });
});

describe("ticketHash", () => {
  const ticket = { kind: "decision", verdict: "BLOCK", premiumBps: 190, multiplier: "10" };

  it("is stable across key order", () => {
    const reordered = { multiplier: "10", premiumBps: 190, verdict: "BLOCK", kind: "decision" };
    expect(ticketHash(ticket)).toBe(ticketHash(reordered));
  });

  it("ignores narration and the hash field", () => {
    const withExtras = { ...ticket, narration: "anything", hash: "old" };
    expect(ticketHash(withExtras)).toBe(ticketHash(ticket));
  });

  it("changes when any hashed field changes", () => {
    expect(ticketHash({ ...ticket, multiplier: "1" })).not.toBe(ticketHash(ticket));
  });

  it("matches a known SHA-256 vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
