import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decide, type DecideInput, type DecisionTicket, ticketHash } from "@stamp/engine";

export interface ReplayRow {
  set: string;
  name: string;
  intent: string;
  symbol: string | null;
  verdict: string;
  reasons: string[];
  premiumBps: number | null;
  overpayUsd: string | null;
  expectedHash: string;
  hash: string;
  ok: boolean;
  problem: string | null;
}

/**
 * Recomputes every recorded ticket from its recorded inputs. A row is ok only when the
 * stored ticket still matches its own hash AND the engine today produces the same hash.
 */
export async function replayDir(dir: string, set: string): Promise<ReplayRow[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const rows: ReplayRow[] = [];
  for (const f of files) {
    const rec = JSON.parse(await readFile(join(dir, f), "utf8")) as { input: DecideInput; ticket: DecisionTicket; name?: string };
    const name = rec.name ?? f.replace(/\.json$/, "");
    let problem: string | null = null;
    let recomputed: DecisionTicket | null = null;
    try {
      recomputed = decide(rec.input);
    } catch (err) {
      problem = `engine threw: ${String(err)}`;
    }
    if (!problem && ticketHash(rec.ticket as unknown as Record<string, unknown>) !== rec.ticket.hash) problem = "stored ticket does not match its own hash";
    if (!problem && recomputed!.hash !== rec.ticket.hash) problem = "engine now produces a different ticket";
    const t = recomputed ?? rec.ticket;
    rows.push({
      set,
      name,
      intent: rec.input.intent,
      symbol: t.chosen?.symbol ?? null,
      verdict: t.verdict,
      reasons: t.reasons,
      premiumBps: t.premiumBps,
      overpayUsd: t.overpayUsd,
      expectedHash: rec.ticket.hash,
      hash: t.hash,
      ok: problem === null,
      problem,
    });
  }
  return rows;
}

/** fixtures/golden plus every set under fixtures/replay/. */
export async function replayAll(fixturesDir: string): Promise<ReplayRow[]> {
  const rows = await replayDir(join(fixturesDir, "golden"), "golden");
  let sets: string[] = [];
  try {
    sets = (await readdir(join(fixturesDir, "replay"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    // no replay sets yet
  }
  for (const s of sets) rows.push(...(await replayDir(join(fixturesDir, "replay", s), s)));
  return rows;
}
