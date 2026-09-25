import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` properties dropped.
 * Money, prices and multipliers must already be strings. The only numbers allowed are safe
 * integers (bps, seconds), so a float can never change a hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalJson: non-integer number ${value}; use a string`);
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const entries = Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Ticket hash: everything except `hash` itself and the template `narration`. */
export function ticketHash(ticket: Record<string, unknown>): string {
  const { hash: _hash, narration: _narration, ...body } = ticket;
  return sha256Hex(canonicalJson(body));
}
