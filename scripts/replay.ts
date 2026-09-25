/**
 * The judge command. Recomputes every recorded ticket from its recorded inputs, offline,
 * and exits 1 if any hash differs.
 *
 *   npm run replay                 # fixtures/golden + fixtures/replay/*
 *   npm run replay -- --set 2026-09-25-premarket
 */
import { parseArgs } from "node:util";
import { replayAll, type ReplayRow } from "@stamp/api";

const { values } = parseArgs({ options: { set: { type: "string" }, fixtures: { type: "string", default: "fixtures" } } });

const rows = (await replayAll(values.fixtures!)).filter((r) => !values.set || r.set === values.set);
if (rows.length === 0) {
  console.error("no recorded tickets found");
  process.exit(1);
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const fmt = (r: ReplayRow) =>
  [
    r.ok ? "ok   " : "DRIFT",
    pad(r.set, 22),
    pad(r.intent, 26),
    pad(r.symbol ?? "—", 8),
    pad(r.verdict, 5),
    pad(r.reasons.join(","), 26),
    pad(r.premiumBps === null ? "" : `${r.premiumBps} bps`, 10),
    pad(r.overpayUsd ? `$${r.overpayUsd}` : "", 7),
    r.hash.slice(0, 12),
  ].join("  ");

let set = "";
for (const r of rows) {
  if (r.set !== set) {
    set = r.set;
    console.log();
  }
  console.log(fmt(r));
  if (r.problem) console.log(`       ${r.problem}: expected ${r.expectedHash.slice(0, 12)}`);
}
const bad = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length} tickets recomputed · ${bad === 0 ? "all hashes match" : `${bad} DRIFTED`}`);
process.exit(bad === 0 ? 0 : 1);
