import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ticketHash } from "../src/hash.js";
import { decide } from "../src/verdict.js";
import { CASES } from "./cases.js";

const dir = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === "1";

describe("golden decisions", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.verdict} ${c.reasons.join(",")}`, () => {
      const ticket = decide(c.input);

      // Explicit expectations: the golden file is never the only guard.
      expect(ticket.verdict).toBe(c.verdict);
      expect(ticket.reasons).toEqual(c.reasons);
      expect(ticket.notes).toEqual(c.notes ?? []);
      if (c.chosen !== undefined) expect(ticket.chosen?.symbol ?? null).toBe(c.chosen);
      if (c.rejected) expect(ticket.rejected.map((r) => [r.symbol, r.reason])).toEqual(c.rejected);
      expect(ticketHash(ticket as unknown as Record<string, unknown>)).toBe(ticket.hash);
      expect(decide(c.input).hash).toBe(ticket.hash);

      const file = `${dir}${c.name}.json`;
      const golden = { name: c.name, kind: c.kind, change: c.change ?? null, input: c.input, ticket };
      if (UPDATE || !existsSync(file)) {
        if (!UPDATE) throw new Error(`missing golden ${file}; run npm run golden:update`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
        return;
      }
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(golden)));
    });
  }
});
