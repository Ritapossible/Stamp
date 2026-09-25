import { describe, expect, it } from "vitest";
import { clockSaysCashOpen, nyClock, resolveSession } from "./session.js";

describe("NY clock", () => {
  it("follows EDT in September (UTC−4)", () => {
    expect(nyClock("2026-09-25T13:31:00Z")).toEqual({ weekday: "Fri", minutes: 9 * 60 + 31 });
  });

  it("follows EST after DST ends on 1 Nov 2026 (UTC−5)", () => {
    expect(nyClock("2026-11-02T14:35:00Z")).toEqual({ weekday: "Mon", minutes: 9 * 60 + 35 });
    expect(clockSaysCashOpen("2026-11-02T14:35:00Z")).toBe(true);
    expect(clockSaysCashOpen("2026-11-02T13:35:00Z")).toBe(false);
  });

  it("follows EDT after DST starts on 8 Mar 2026", () => {
    expect(clockSaysCashOpen("2026-03-09T13:35:00Z")).toBe(true);
    expect(clockSaysCashOpen("2026-03-06T13:35:00Z")).toBe(false); // Friday before, still EST
  });

  it("is closed on weekends and treats ±2 min around open/close as edge", () => {
    expect(clockSaysCashOpen("2026-09-26T15:00:00Z")).toBe(false);
    expect(clockSaysCashOpen("2026-09-25T13:31:00Z")).toBe("edge");
    expect(clockSaysCashOpen("2026-09-25T19:59:00Z")).toBe("edge");
    expect(clockSaysCashOpen("2026-09-25T19:55:00Z")).toBe(true);
  });
});

describe("resolveSession", () => {
  const asset = (marketStatus: string | null) => ({ openState: true, marketStatus, reasonCode: "TRADING", reasonMsg: null });

  it("prefers the asset status (Ondo)", () => {
    const r = resolveSession(asset("premarket"), { marketStatus: "closed", openState: true }, "2026-09-25T10:00:00Z");
    expect(r).toEqual({ session: "extended", source: "asset", marketStatus: "premarket", warn: null });
  });

  it("falls back to the venue when the asset status has none (bStock/xStock)", () => {
    const r = resolveSession(asset(null), { marketStatus: "regular", openState: true }, "2026-09-25T15:00:00Z");
    expect(r).toEqual({ session: "regular", source: "venue", marketStatus: "regular", warn: null });
  });

  it("warns when clock and API disagree", () => {
    expect(resolveSession(asset("regular"), null, "2026-09-26T15:00:00Z").warn).toBe("SESSION_DISAGREEMENT");
    expect(resolveSession(asset("overnight"), null, "2026-09-25T15:00:00Z").warn).toBe("SESSION_DISAGREEMENT");
  });

  it("does not warn at the open/close edge", () => {
    expect(resolveSession(asset("premarket"), null, "2026-09-25T13:31:00Z").warn).toBeNull();
  });

  it("marks unknown statuses", () => {
    expect(resolveSession(asset("halftime"), null, "2026-09-25T15:00:00Z")).toMatchObject({ session: "unknown", warn: "SESSION_UNKNOWN" });
    expect(resolveSession(null, null, "2026-09-25T15:00:00Z")).toMatchObject({ session: "unknown", source: null });
  });
});
