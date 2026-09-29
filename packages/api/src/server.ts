/**
 * Stamp HTTP API plus the web page. Decisions use public Binance endpoints only (no key).
 *
 *   PORT=8787 npx tsx packages/api/src/server.ts
 *
 * Env:
 *   DATA_DIR            where tickets.jsonl / standing.jsonl live (default data)
 *   SNAPSHOTS_DIR       local snapshot JSONL directory (default $DATA_DIR/snapshots)
 *   SNAPSHOTS_REMOTE    base URL of the `snapshots` branch, e.g.
 *                       https://raw.githubusercontent.com/Ritapossible/Stamp/snapshots
 *                       - used when the host has no local snapshots (Render free has no disk)
 *   WEB_DIR             built web page (default apps/web/dist); skipped if missing
 *   STAMP_TRADING_API_KEY + STAMP_TRADING_API_SECRET  → live Binance Trading API (RFQ)
 *   STAMP_FAKE_WALLET=1 → labelled fake wallet (vendor "fake"), demo only
 * The server never holds a signing key; the human's wallet signs the typed data.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  FakeWallet,
  LiveMarket,
  parseSnapshotLines,
  RwaClient,
  type SnapshotRow,
  SnapshotStore,
  type StockWallet,
  summarizeUniverse,
  TradingApiClient,
  TradingApiWallet,
} from "@stamp/sources";
import { createApp } from "./app.js";
import { ExecutionService } from "./execution.js";
import { StandingService } from "./standing.js";
import { TicketStore } from "./tickets.js";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? "data";
const snapshotsDir = process.env.SNAPSHOTS_DIR ?? join(dataDir, "snapshots");
const snapshotsRemote = process.env.SNAPSHOTS_REMOTE?.replace(/\/$/, "");
const fixturesDir = process.env.FIXTURES_DIR ?? "fixtures";
const webDir = process.env.WEB_DIR ?? "apps/web/dist";

/** The last few UTC days of snapshot JSONL from the `snapshots` branch. Missing days are skipped. */
async function remoteSnapshots(base: string): Promise<SnapshotStore> {
  const rows: SnapshotRow[] = [];
  for (let back = 4; back >= 0; back--) {
    const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    try {
      const res = await fetch(`${base}/data/snapshots/${day}.jsonl`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) rows.push(...parseSnapshotLines(await res.text()).rows);
    } catch {
      // a missing or slow day only means fewer references; decisions say NO_REFERENCE honestly
    }
  }
  return new SnapshotStore(rows);
}

const loadSnapshots = () => (snapshotsRemote && !existsSync(snapshotsDir) ? remoteSnapshots(snapshotsRemote) : SnapshotStore.fromDir(snapshotsDir));

const store = await TicketStore.open(join(dataDir, "tickets.jsonl"));
let snapshots = await loadSnapshots();
setInterval(async () => {
  snapshots = await loadSnapshots();
}, 10 * 60_000).unref();

let wallet: StockWallet | null = null;
if (process.env.STAMP_TRADING_API_KEY && process.env.STAMP_TRADING_API_SECRET) {
  wallet = new TradingApiWallet(new TradingApiClient({ apiKey: process.env.STAMP_TRADING_API_KEY, secret: process.env.STAMP_TRADING_API_SECRET }));
} else if (process.env.STAMP_FAKE_WALLET === "1" || process.env.STAMP_FAKE_WALLET === "swap") {
  // "swap" mimics what the live Trading API returned from Frankfurt (SWAP + one approval).
  wallet = new FakeWallet(
    (token) => {
      const p = store.latestTokenPrice(token);
      if (!p) throw new Error(`fake wallet has no recent price for ${token}`);
      return p;
    },
    undefined,
    5,
    process.env.STAMP_FAKE_WALLET === "swap" ? "SWAP" : "RFQ",
  );
}

const market = new LiveMarket(new RwaClient());
const execution = wallet ? new ExecutionService({ wallet, store }) : null;
const standing = await StandingService.open({ market, store, snapshots: () => snapshots, execution, path: join(dataDir, "standing.jsonl") });
setInterval(() => void standing.tick(), 10 * 60_000).unref();

const app = createApp({
  market,
  store,
  snapshots: () => snapshots,
  fixturesDir,
  execution,
  standing,
  summary: async () => summarizeUniverse((await market.universe()).rows),
});

if (existsSync(webDir)) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("*", serveStatic({ path: join(webDir, "index.html") }));
}

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(
    `stamp on :${port} · ${store.size} tickets · ${snapshots.size} snapshot rows${snapshotsRemote ? " (remote)" : ""} · wallet: ${wallet?.name ?? "none (execution disabled)"} · web: ${existsSync(webDir) ? webDir : "not built"}`,
  );
});
