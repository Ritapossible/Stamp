/**
 * One QUOTE-ONLY call to the Binance Trading API, recorded raw for fixtures. Never calls
 * /swap, /order/submit or broadcast, so nothing can execute.
 *
 *   STAMP_TRADING_API_KEY=… STAMP_TRADING_API_SECRET=… npx tsx scripts/quote-probe.ts [SYMBOL] [USD]
 *
 * The key and secret are read from the environment and never printed or written.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildUniverse, BSC_USDT, RwaClient, TradingApiClient, TradingApiError } from "@stamp/sources";

const symbol = process.argv[2] ?? "NVDAon";
const usd = process.argv[3] ?? "20";
/** A placeholder recipient: quotes may require an address, and this one owns nothing. */
const QUOTE_USER = "0x000000000000000000000000000000000000dEaD";

const apiKey = process.env.STAMP_TRADING_API_KEY;
const secret = process.env.STAMP_TRADING_API_SECRET;
if (!apiKey || !secret) throw new Error("STAMP_TRADING_API_KEY and STAMP_TRADING_API_SECRET must be set");

const list = await new RwaClient().list();
const row = buildUniverse(list.data ?? []).rows.find((r) => r.chainId === "56" && r.symbol === symbol);
if (!row) throw new Error(`${symbol} not found on BSC`);

const calls: unknown[] = [];
const client = new TradingApiClient({ apiKey, secret, onCall: (c) => calls.push(c) });
const query = {
  binanceChainId: "56",
  fromTokenAddress: BSC_USDT,
  toTokenAddress: row.contractAddress,
  amount: (BigInt(usd) * 10n ** 18n).toString(),
  userWalletAddress: QUOTE_USER,
};

const at = new Date().toISOString();
let response: unknown;
let error: { message: string; status: number | null; body: unknown } | null = null;
try {
  response = await client.get("/api/v1/dex/aggregator/quote", query);
} catch (err) {
  error = err instanceof TradingApiError ? { message: err.message, status: err.status, body: err.body } : { message: String(err), status: null, body: null };
}

const out = "fixtures/trading";
await mkdir(out, { recursive: true });
const file = join(out, `${at.slice(0, 10)}-quote-${symbol}.json`);
await writeFile(file, `${JSON.stringify({ at, symbol, query, calls, response: response ?? null, error }, null, 2)}\n`);
console.log(JSON.stringify({ file, calls, ok: error === null, error: error?.message ?? null }, null, 2));
