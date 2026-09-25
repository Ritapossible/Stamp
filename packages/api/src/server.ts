/**
 * Stamp HTTP API. Decisions use public Binance endpoints only (no key).
 *
 *   PORT=8787 DATA_DIR=data SNAPSHOTS_DIR=data/snapshots npx tsx packages/api/src/server.ts
 *
 * Execution (optional):
 *   STAMP_TRADING_API_KEY + STAMP_TRADING_API_SECRET  → live Binance Trading API (RFQ)
 *   STAMP_FAKE_WALLET=1                               → labelled fake wallet (vendor "fake"), demo only
 *   neither                                           → execution routes answer 501
 * The server never holds a signing key; the human's wallet signs the typed data.
 */
import { serve } from "@hono/node-server";
import { FakeWallet, LiveMarket, RwaClient, SnapshotStore, type StockWallet, TradingApiClient, TradingApiWallet } from "@stamp/sources";
import { join } from "node:path";
import { createApp } from "./app.js";
import { ExecutionService } from "./execution.js";
import { StandingService } from "./standing.js";
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

let wallet: StockWallet | null = null;
if (process.env.STAMP_TRADING_API_KEY && process.env.STAMP_TRADING_API_SECRET) {
  wallet = new TradingApiWallet(new TradingApiClient({ apiKey: process.env.STAMP_TRADING_API_KEY, secret: process.env.STAMP_TRADING_API_SECRET }));
} else if (process.env.STAMP_FAKE_WALLET === "1") {
  wallet = new FakeWallet((token) => {
    const p = store.latestTokenPrice(token);
    if (!p) throw new Error(`fake wallet has no recent price for ${token}`);
    return p;
  });
}

const market = new LiveMarket(new RwaClient());
const execution = wallet ? new ExecutionService({ wallet, store }) : null;
const standing = await StandingService.open({ market, store, snapshots: () => snapshots, execution, path: join(dataDir, "standing.jsonl") });
setInterval(() => void standing.tick(), 10 * 60_000).unref();

const app = createApp({ market, store, snapshots: () => snapshots, fixturesDir, execution, standing });
serve({ fetch: app.fetch, port }, () => {
  console.log(`stamp api on :${port} · ${store.size} tickets · ${snapshots.size} snapshot rows · wallet: ${wallet?.name ?? "none (execution disabled)"}`);
});
