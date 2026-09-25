import { describe, expect, it } from "vitest";
import { shouldCaptureRaw } from "./snapshot.js";

const at = (iso: string) => new Date(iso);

describe("shouldCaptureRaw", () => {
  it("honours always / never", () => {
    expect(shouldCaptureRaw("always", "regular", at("2026-09-25T15:15:00Z"))).toBe(true);
    expect(shouldCaptureRaw("never", "closed", at("2026-09-26T12:05:00Z"))).toBe(false);
  });

  it("skips the regular session outside the close window", () => {
    expect(shouldCaptureRaw("auto", "regular", at("2026-09-25T15:05:00Z"))).toBe(false);
  });

  it("captures every tick around the close", () => {
    expect(shouldCaptureRaw("auto", "regular", at("2026-09-25T19:55:00Z"))).toBe(true);
    expect(shouldCaptureRaw("auto", "postmarket", at("2026-09-25T20:15:00Z"))).toBe(true);
  });

  it("captures off-hours on the half-hour slots only", () => {
    expect(shouldCaptureRaw("auto", "closed", at("2026-09-26T12:05:00Z"))).toBe(true);
    expect(shouldCaptureRaw("auto", "closed", at("2026-09-26T12:35:00Z"))).toBe(true);
    expect(shouldCaptureRaw("auto", "closed", at("2026-09-26T12:15:00Z"))).toBe(false);
  });
});
