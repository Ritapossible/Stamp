/**
 * Free HTTP API. Public Binance endpoints only; no key.
 *
 *   PORT=8787 DATA_DIR=data SNAPSHOTS_DIR=data/snapshots npx tsx packages/api/src/server.ts
 */
import { serve } from "@hono/node-server";
import { LiveMarket, RwaClient, SnapshotStore } from "@stamp/sources";
import { join } from "node:path";
import { createApp } from "./app.js";
import { TicketStore } from "./tickets.js";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? "data";
const snapshotsDir = process.env.SNAPSHOTS_DIR ?? join(dataDir, "snapshots");
const fixturesDir = process.env.FIXTURES_DIR ?? "fixtures";

const store = await TicketStore.open(join(dataDir, "tickets.jsonl"));
let snapshots = await SnapshotStore.fromDir(snapshotsDir);
setInterval(async () => {
  snapshots = await SnapshotStore.fromDir(snapshotsDir);
}, 5 * 60_000).unref();

const app = createApp({ market: new LiveMarket(new RwaClient()), store, snapshots: () => snapshots, fixturesDir });
serve({ fetch: app.fetch, port }, () => {
  console.log(`stamp api on :${port} · ${store.size} tickets · ${snapshots.size} snapshot rows`);
});
