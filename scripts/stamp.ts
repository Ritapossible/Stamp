/**
 * Live decision from the command line. Public endpoints only; no key.
 *
 *   npx tsx scripts/stamp.ts "Buy 1 NFLX"
 *   npx tsx scripts/stamp.ts "Buy $20 of NVIDIA" --issuer bstock
 *   npx tsx scripts/stamp.ts "Buy $20 of NVIDIA" --snapshots data/snapshots --json
 *
 * --issuer     ondo | xstock | bstock | any   (default: the POLICY.md default, ondo)
 * --snapshots  directory of snapshot JSONL, for lastOfficialClose when stockInfo is null
 * --filled     USD already filled today (default 0)
 * --json       print the full ticket
 * --calls      print every API call with its latency (for the DEVEX raw log)
 */
import { parseArgs } from "node:util";
import { decide, DEFAULT_POLICY, type Issuer, type Policy } from "@stamp/engine";
import { type CallRecord, LiveMarket, RwaClient, SnapshotStore } from "@stamp/sources";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      issuer: { type: "string", default: "ondo" },
      snapshots: { type: "string" },
      filled: { type: "string", default: "0" },
      json: { type: "boolean", default: false },
      calls: { type: "boolean", default: false },
    },
  });
  const intent = positionals.join(" ").trim();
  if (!intent) throw new Error('usage: stamp "Buy $20 of NVIDIA" [--issuer ondo|xstock|bstock|any]');
  const issuer = values.issuer === "any" ? null : (values.issuer as Issuer);
  if (issuer !== null && !["ondo", "xstock", "bstock"].includes(issuer)) throw new Error("--issuer must be ondo, xstock, bstock or any");
  const policy: Policy = { ...DEFAULT_POLICY, issuer };

  const calls: CallRecord[] = [];
  const market = new LiveMarket(new RwaClient({ onCall: (c) => calls.push(c) }));
  const inputs = await market.forIntent(intent, policy);
  const store = values.snapshots ? await SnapshotStore.fromDir(values.snapshots) : new SnapshotStore([]);

  const parsedTicker = inputs.views.length > 0 ? inputs.universe.find((r) => r.contractAddress === inputs.views[0]!.contractAddress)?.ticker : undefined;
  const lastOfficialClose = parsedTicker ? store.lastOfficialClose(parsedTicker, inputs.asOf) : null;

  const ticket = decide({ ...inputs, intent, policy, lastOfficialClose, filledTodayUsd: values.filled! });

  if (values.json) {
    console.log(JSON.stringify(ticket, null, 2));
  } else {
    console.log(ticket.narration);
    console.log();
    const row = (k: string, v: unknown) => v !== null && v !== undefined && console.log(`  ${k.padEnd(16)} ${String(v)}`);
    row("verdict", `${ticket.verdict}  [${ticket.reasons.join(", ")}]${ticket.notes.length ? `  notes: ${ticket.notes.join(", ")}` : ""}`);
    row("instrument", ticket.chosen && `${ticket.chosen.symbol} ${ticket.chosen.contractAddress}`);
    row("session", ticket.session && `${ticket.session} (${ticket.marketStatus}, from ${ticket.sessionSource})`);
    row("token price", ticket.tokenPriceUsd);
    row("multiplier", ticket.multiplier && `${ticket.multiplier}${ticket.listMultiplier && ticket.listMultiplier !== ticket.multiplier ? `  (list says ${ticket.listMultiplier})` : ""}`);
    row("per-share price", ticket.economicPriceUsd);
    row("reference", ticket.referenceUsd && `${ticket.referenceUsd} (${ticket.referenceSource}${ticket.referenceSibling ? ` via ${ticket.referenceSibling}` : ""})`);
    row("premium", ticket.premiumBps !== null ? `${ticket.premiumBps} bps` : null);
    row("hash", ticket.hash);
  }
  if (values.calls) {
    console.log();
    for (const c of calls) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${String(c.latencyMs).padStart(5)} ms  x${c.attempts}  ${c.error ?? ""}  ${c.url.replace(/^https:\/\/www\.binance\.com\/bapi\/defi/, "")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
