import type { AssetStatus, ReasonCode, Session, VenueStatus } from "./types.js";

const MAP: Readonly<Record<string, Session>> = {
  regular: "regular",
  premarket: "extended",
  postmarket: "extended",
  overnight: "closed",
  closed: "closed",
};

export interface SessionResult {
  session: Session;
  source: "asset" | "venue" | null;
  marketStatus: string | null;
  warn: ReasonCode | null;
}

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes after NY midnight and weekday, DST-aware. */
export function nyClock(asOf: string): { weekday: string; minutes: number } {
  const parts = Object.fromEntries(nyFormat.formatToParts(new Date(asOf)).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday!, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const EDGE_TOLERANCE_MIN = 2;

/** NYSE cash hours by the clock alone (holidays not modelled; the API wins, we just warn). */
export function clockSaysCashOpen(asOf: string): boolean | "edge" {
  const { weekday, minutes } = nyClock(asOf);
  if (weekday === "Sat" || weekday === "Sun") return false;
  if (Math.abs(minutes - OPEN) <= EDGE_TOLERANCE_MIN || Math.abs(minutes - CLOSE) <= EDGE_TOLERANCE_MIN) return "edge";
  return minutes >= OPEN && minutes < CLOSE;
}

/**
 * Session comes from the instrument's own status when the API provides it (Ondo), otherwise
 * from the venue-level status (bStock and xStock return marketStatus: null).
 */
export function resolveSession(asset: AssetStatus | null, venue: VenueStatus | null, asOf: string): SessionResult {
  const assetMs = asset?.marketStatus ?? null;
  const venueMs = venue?.marketStatus ?? null;
  const source = assetMs !== null ? "asset" : venueMs !== null ? "venue" : null;
  const marketStatus = assetMs ?? venueMs;
  const session: Session = marketStatus !== null ? MAP[marketStatus] ?? "unknown" : "unknown";
  if (session === "unknown") return { session, source, marketStatus, warn: "SESSION_UNKNOWN" };

  const clock = clockSaysCashOpen(asOf);
  const disagree = clock !== "edge" && clock !== (session === "regular");
  return { session, source, marketStatus, warn: disagree ? "SESSION_DISAGREEMENT" : null };
}
