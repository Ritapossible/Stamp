import { parseDec } from "./decimal.js";
import type { ParsedIntent, Unit } from "./types.js";

/**
 * Deterministic order grammar (no LLM). Buy side only in v1.
 *
 *   [buy] $20 of NVIDIA          → usd
 *   [buy] 20 usd|dollars of X    → usd
 *   [buy] 2 shares of NVIDIA     → shares
 *   [buy] 0.5 NFLXon tokens      → tokens
 *   [buy] 1 NFLX                 → ambiguous (token or share?)
 */
const NUM = String.raw`(\d+(?:\.\d+)?)`;
const PATTERNS: Array<[Unit, RegExp]> = [
  ["usd", new RegExp(String.raw`^\$\s*${NUM}\s+(?:worth\s+)?of\s+(.+)$`, "i")],
  ["usd", new RegExp(String.raw`^${NUM}\s*(?:usd|usdt|dollars?)\s+(?:worth\s+)?of\s+(.+)$`, "i")],
  ["shares", new RegExp(String.raw`^${NUM}\s+shares?\s+(?:of\s+)?(.+)$`, "i")],
  ["tokens", new RegExp(String.raw`^${NUM}\s+(.+?)\s+tokens?$`, "i")],
  ["ambiguous", new RegExp(String.raw`^${NUM}\s+(.+)$`, "i")],
];

const MAX_LEN = 200;

export type IntentResult = { ok: true; intent: ParsedIntent } | { ok: false; raw: string; problem: string };

export function parseIntent(raw: string): IntentResult {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > MAX_LEN) return { ok: false, raw, problem: "empty or too long" };
  if (/^sell\b/i.test(text)) return { ok: false, raw, problem: "sells are not supported in v1" };
  const body = text.replace(/^buy\s+/i, "").replace(/[.!?]+$/, "");

  for (const [unit, re] of PATTERNS) {
    const m = re.exec(body);
    if (!m) continue;
    const amount = parseDec(m[1]);
    if (!amount || amount.lte(0)) return { ok: false, raw, problem: "amount must be positive" };
    const query = cleanQuery(m[2] ?? "");
    if (!query) return { ok: false, raw, problem: "no instrument named" };
    return { ok: true, intent: { raw, side: "buy", unit, amount: amount.toString(), query } };
  }
  return { ok: false, raw, problem: 'expected e.g. "Buy $20 of NVIDIA" or "Buy 1 share of Netflix"' };
}

function cleanQuery(q: string): string {
  return q
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\s+(stock|shares?|equity)$/i, "")
    .replace(/'s$/i, "")
    .trim();
}
