/**
 * Turns one raw capture into a replay set: for every captured ticker, the same standard
 * orders a person would try, decided from exactly what Binance returned at that moment.
 *
 *   npx tsx scripts/build-replay.ts --capture <file> --set <name> \
 *       [--list fixtures/probe-2026-09-25/list.json] [--snapshots data/snapshots]
 *
 * Orders per ticker:  "Buy $20 of <SYMBOL>" for each issuer (policy = that issuer),
 *                     "Buy 1 <TICKER>" under the default Ondo policy.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decide, DEFAULT_POLICY, ISSUER_BY_TYPE, type DecideInput } from "@stamp/engine";
import { buildUniverse, type CaptureFile, fromCapture, SnapshotStore } from "@stamp/sources";

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    set: { type: "string" },
    list: { type: "string", default: "fixtures/probe-2026-09-25/list.json" },
    snapshots: { type: "string" },
    fixtures: { type: "string", default: "fixtures" },
  },
});
if (!values.capture || !values.set) throw new Error("--capture and --set are required");

const capture = JSON.parse(await readFile(values.capture, "utf8")) as CaptureFile;
const fallback = capture.universe ? [] : buildUniverse(JSON.parse(await readFile(values.list!, "utf8")).data).rows;
const market = fromCapture(capture, fallback);
const store = values.snapshots ? await SnapshotStore.fromDir(values.snapshots) : new SnapshotStore([]);

const inView = new Set(market.views.map((v) => v.contractAddress));
const rows = market.universe.filter((r) => r.chainId === "56" && inView.has(r.contractAddress.toLowerCase()) && ISSUER_BY_TYPE[r.type]);
const tickers = [...new Set(rows.map((r) => r.ticker))].sort();

const out = join(values.fixtures!, "replay", values.set);
await mkdir(out, { recursive: true });
let n = 0;
for (const ticker of tickers) {
  const family = rows.filter((r) => r.ticker === ticker).sort((a, b) => a.type - b.type);
  const orders: Array<[string, string, DecideInput["policy"]]> = family.map((r) => [
    `${r.symbol.toLowerCase()}-usd20`,
    `Buy $20 of ${r.symbol}`,
    { ...DEFAULT_POLICY, issuer: ISSUER_BY_TYPE[r.type]! },
  ]);
  if (family.some((r) => r.type === 1)) orders.push([`${ticker.toLowerCase()}-bare1`, `Buy 1 ${ticker}`, DEFAULT_POLICY]);
  for (const [name, intent, policy] of orders) {
    const familyAddresses = new Set(family.map((r) => r.contractAddress.toLowerCase()));
    const input: DecideInput = {
      ...market,
      universe: market.universe.filter((r) => r.chainId === "56" && r.ticker === ticker),
      views: market.views.filter((v) => familyAddresses.has(v.contractAddress)),
      intent,
      policy,
      lastOfficialClose: store.lastOfficialClose(ticker, market.asOf),
      filledTodayUsd: "0",
    };
    const ticket = decide(input);
    await writeFile(join(out, `${name}.json`), `${JSON.stringify({ name, capture: values.capture, input, ticket }, null, 2)}\n`);
    n++;
  }
}
console.log(`wrote ${n} tickets for ${tickers.length} tickers to ${out}`);
