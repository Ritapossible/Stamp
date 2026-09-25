/**
 * Records raw RWA payloads for BSC symbols into fixtures/probe-<date>/ (or --out).
 * Writes the envelope exactly as returned, including `data: null`, so fixtures show
 * what Binance actually sent.
 *
 *   npx tsx scripts/probe.ts NVDAB NFLXx MUx
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildUniverse, RwaClient } from "@stamp/sources";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
  const now = new Date().toISOString();
  const out = values.out ?? `fixtures/probe-${now.slice(0, 10)}`;
  const client = new RwaClient({ onCall: (c) => console.log(`${c.ok ? "ok  " : "FAIL"} ${c.latencyMs} ms x${c.attempts} ${c.error ?? ""} ${c.url}`) });

  const [list, venue] = await Promise.all([client.list(), client.venueStatus()]);
  if (!list.ok || !list.data) throw new Error(`list failed: ${list.error}`);
  await mkdir(out, { recursive: true });
  const write = (name: string, body: unknown) => writeFile(join(out, name), `${JSON.stringify(body)}\n`);
  await write("list.json", list.body);
  await write("market-status.json", venue.body);

  const bsc = buildUniverse(list.data).rows.filter((r) => r.chainId === "56");
  for (const symbol of positionals) {
    const row = bsc.find((r) => r.symbol === symbol);
    if (!row) {
      console.error(`not on BSC: ${symbol}`);
      continue;
    }
    const [status, dynamic, meta] = await Promise.all([client.assetStatus(row.contractAddress), client.dynamic(row.contractAddress), client.meta(row.contractAddress)]);
    await write(`${symbol}.asset-status.json`, status.body);
    await write(`${symbol}.dynamic.json`, dynamic.body);
    await write(`${symbol}.meta.json`, meta.body);
  }
  await writeFile(join(out, "CAPTURED_AT"), `${now}\n`);
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
