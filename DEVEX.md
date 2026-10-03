# Developer Experience Report - Stamp

> **This report is written by the builder, in the builder's own words.** Claude may add dated
> raw facts to the *Raw log* at the bottom (the call, what was expected, what came back, the
> latency). Claude does not write or polish the sections above it. The hackathon rejects
> AI-generated reports, and this is 25% of the score.

## 1. Time from docs to first API call
_(your words)_

## 2. Where I got stuck
_(your words)_

## 3. Error messages - clear or not
_(your words)_

## 4. Edge cases I hit
_(your words)_

## 5. Latency
_(your words - numbers come from the raw log)_

## 6. Tokenized-stock behavior: liquidity, slippage, off-hours
_(your words)_

## 7. Ondo vs bStocks vs xStocks - what differs for a builder
_(your words)_

## 8. If I owned this platform I would…
_(your words)_

---

## Raw log

Format: `date time UTC · call · expected · got · latency · what I did`
Evidence: `fixtures/` and `docs/API-NOTES.md`.

- 2026-09-25 09:58 · `GET …/rwa/asset/market/status/ai` + `v2 …/dynamic/ai` for NVDAx (BSC) · data · `data: null` on both, `success: true` · - · retry-once rule, then INCOMPLETE_STATUS
- 2026-09-25 10:03 · same two calls, NVDAx · data · full data this time · - · noted as intermittent
- 2026-09-25 10:03 · `dynamic` NVDAB · `stockInfo.price`, `statusInfo.marketStatus` · both `null` (Ondo sibling has both) · - · reference from sibling; session from venue status
- 2026-09-25 10:03 · `list` vs `dynamic` multiplier, NVDAx · equal · list `"1"`, dynamic `"1.0009180758490996"` · - · dynamic is source of truth
- 2026-09-25 10:03 · `list` · unique symbols · `NFLXon` exists on chain 56, 1 and Solana with different addresses; my own probe collided on it · - · key by (chainId, address)
- 2026-09-25 10:03 · `dynamic` NFLXon · token ≈ share price · token 716.27, stock 71.60, multiplier 10 · - · this is the demo
- 2026-09-25 · docs · Agentic Wallet swap supports tokenized stocks? · skills reference doesn't mention them · - · test on Day 8–9
- 2026-09-25 · docs · simulate the stock swap · stock swaps are RFQ (EIP-712 typed data), nothing to simulate · - · check typed data against ticket instead
- 2026-09-25 10:11 · `v2 …/dynamic/ai` NFLXx · sharesMultiplier matching list · dynamic `"10"`, list `"1"`, token $77.19 vs NFLX $71.60 · ~150 ms · engine blocks ≥2× disagreement (MULTIPLIER_CONFLICT)
- 2026-09-25 10:11 · `v2 …/dynamic/ai` MUx · price near MU · 980.48 vs stock 1092.01 (−10.25%) · - · PRICE_IMPLAUSIBLE, never read as a bargain
- 2026-09-25 10:11 · `v2 …/dynamic/ai` NFLX family · one share count · Ondo 10, bStock 1, xStock 10-or-1 · - · shown on every ticket
- 2026-09-25 10:12 · snapshot workflow from GitHub Actions runners · Binance may refuse US cloud IPs · 200s on all 56 calls · list ~450 ms, dynamic ~150–200 ms · no workaround needed
- 2026-09-25 10:40 · `v2 …/dynamic/ai` MUx, NFLXx · token prices moving with the stock · identical to 10:11 to the last digit (980.4846…, 77.1898…) while MU moved 1092.01 → 1093.25 · 250–450 ms · no price timestamp in the payload, so staleness can't be detected; the premium check catches the result
- 2026-09-25 10:40 · 5 calls for one decision (list + venue + 3 dynamic), in parallel · - · list 160–200 ms, dynamic 250–455 ms, venue 36–398 ms · list cached 5 min
- 2026-09-25 10:11 · `v2 …/dynamic/ai` all 20 watched xStocks · token near the stock · ORCLx +1625 bps, METAx −2646, PLTRx −1067, MUx −1025, QQQx −288, MSFTx −150; Ondo and bStock versions of the same names within ±15 bps · - · PRICE_IMPLAUSIBLE blocks the >5% ones
- 2026-09-25 10:12→12:22 · GitHub Actions `schedule: */10` on a new repo · a run every ~10 min · zero scheduled runs in 2 h (only the manual dispatch ran) · - · replaced with a self-dispatching loop workflow
- 2026-09-25 20:00 · `v1 …/market/status/ai` + NVDAon statusInfo at the close · docs list `marketStatus` value `pause` · live value is **`paused`**, openState false, reasonCode MARKET_PAUSED, reasonMsg "Paused for session transition"; bStock/xStock statusInfo stay TRADING with marketStatus null · - · engine now treats pause and paused the same, and the venue pause blocks bStocks too
- 2026-09-25 19:50→20:00 · NVDA `stockInfo.price` · last regular print ≈ close · 224.4475 at 19:50 (regular) vs 225.3736 at 20:00 (paused) = 41 bps apart · - · the paused print right after regular is used as the close
- 2026-09-25 12:23→20:40 · snapshot loop workflow · a tick every 10 min · 53 ticks, no gap over 20 min after the loop started, 0 failed calls, including the 18:00 hand-off to the next run · - · -
- 2026-09-29 09:58 · first Trading API call, `GET /build/api/v1/dex/aggregator/quote` USDT→NVDAon $20, quote only · a quote or an auth error · auth accepted (no 40102), then `code 40304 "Service not available due to compliance restriction"` returned with **HTTP 200** · 468 ms · the same 40304 for USDT→WBNB, so it is the caller's region (this build container exits in the US), not the stock; public RWA data endpoints work from the same IP
- 2026-09-29 10:29 · Trading API quote from the Render service in Frankfurt, USDT→NVDAon $20 · 40304 again? · **worked**: quoteId, vendor LiquidMesh, 0.08637745 NVDAon for $20 ($231.54 per token, 22 bps from the decision) · - · the region block is the only blocker; the key was fine
- 2026-09-29 10:29 · same quote · `executionMode: "RFQ"` for equity tokens (docs: "RFQ (equity/RWA tokens)") · **`executionMode: "SWAP"`** · - · built the SWAP path: allowance check, exact-amount approval, simulate, wallet sends the tx
- 2026-09-29 10:29 · `POST /api/v1/dex/pre-transaction/simulate` with the body the docs page shows (`evmTx`) · a simulation · `code 50000 "evmParams is required for EVM chains"` · - · the docs page and the API disagree on the field name; Stamp sends both
- 2026-09-29 10:48 · `bag init` (`@bnbagent/studio-cli` 0.0.14) with `--protocols MCP,X402 --rails b402 --llm-provider none` · a scaffold · worked non-interactively with `--no-onboard --no-install`; the project name must be ASCII alphanumerics only (`stamp-agent` is rejected, not renamed) · - · named it `stampagent`
- 2026-09-29 10:48 · the generated `studio.toml` and `bag x402 buy --help` · English · some comments and the `--asset` help text are in Chinese only · - · translated the comments in our copy
- 2026-09-29 10:48 · paid x402 seller (`price_usd = "0.02"`) · configure and go · needs a B402 merchant, issued **per wallet and per environment after manual approval**; with the four `B402_*` values empty, `/x402` answers `503 "x402 rail dormant"` and the rest of the agent runs · - · shipped with the route enabled but dormant; MCP tools stay free
- 2026-09-29 10:55 · `bag dev` + MCP client calling `stamp_ticket` / `stamp_verify` · tools answer · Buy 1 NFLX → BLOCK UNIT_AMBIGUOUS, Buy $20 of NVIDIA → ALLOW, verify → matches true · - · -
- 2026-09-29 10:55 · `/x402` with `price_usd = "0"` (local only) · free passthrough runs the work hook · `{"result": "<ticket JSON>"}`, prompt taken from `{"prompt": …}`, raw body or `?prompt=` · - · -
- 2026-09-29 · `bag deploy --provider bnb` (managed) · a host for judging · 48 h BSC testnet trial, and the trial wallet key goes to the operator · - · use a throwaway wallet; aws/azure/nodeops for anything longer
- 2026-09-29 · Studio advisory M01 · paid replay protection · in-memory, lost on restart; managed deploy injects no shared store · - · acceptable at $0.02 for a demo, listed in limits
- 2026-09-29 11:20 · `binance-agentic-wallet` skill 1.12.0 / `baw` 1.10.0 · tokenized stocks supported? · yes: the skill resolves stocks with the RWA list `type` filter (1 Ondo, 2 xStock, 3 bStock) and tells agents not to default to Ondo on a bare ticker; its bStock campaign file (ended 2026-09-01) is still shipped with an expiry switch · - · Stamp's ticket supplies the contract address instead
- 2026-09-29 11:22 · `baw market-order quote` without sign-in · a price · `NOT_LOGGED_IN` (code 10003000); even a quote needs a signed-in wallet · - · all live testing must happen on the person's machine
- 2026-09-29 11:22 · `market-order quote` vs `swap` · swap bound to the quote · they are independent calls; the swap executes at market within `--slippage`, and the quote names symbols and human amounts, no addresses · - · Stamp checks the quote before and the BSC receipt after (D25)
- 2026-09-29 11:22 · `baw x402-payment preview/sign` · - · the Agentic Wallet can pay x402 (B402) challenges, with its own daily x402 limit · - · a possible second client for Stamp's /x402
- 2026-09-30 · Studio B402 seller, paid `/x402` · reject bad input before charging · the seller settles before `runWork`, with no hook in between, so a bad prompt is paid for · - · Stamp's route checks the prompt (`POST /v1/intent`) and Stamp's health before calling `seller.handle`; tested: empty, bad JSON, unknown issuer, unreadable order → 400, Stamp down → 503, all `charged: false`
- 2026-09-30 · `B402Seller.create({ replayStore })` · a durable store to plug in · the contract is two methods (`get`, atomic `update` returning `noop`/`set`/`delete`), typed in `@bnb-chain/b402/server` but not re-exported by the Studio runtime · - · file-backed store with serialised writes and temp-file + rename
- 2026-09-30 · keep-awake ping from the snapshot loop · `/health` 200 every 10 min · 200 in 0.16-0.39 s on every tick 03:00-05:30Z, i.e. already warm · - · -
- 2026-10-03 · Ondo `statusInfo.marketStatus` on the weekend (captures 26 Sep 16:00Z, 27 Sep 23:30Z) · a value from the docs' list (regular, premarket, postmarket, overnight, closed, pause) · **`offhours`**, with reasonCode TRADING and the venue saying `closed`; 7 other Ondo tokens said `closed` + `MARKET_CLOSED` (trading off) · - · Stamp mapped it to "unknown" and WARNed every readable Ondo weekend order; now `offhours` = closed (compare to Friday's close). Found by building the weekend replay sets
- 2026-10-03 · weekend xStock prices vs Friday's close · near the close · AMDx +208 bps, AMZNx +278, AVGOx +140, COINx +129, TSLAx +207 (Sat 16:00Z); ORCLx +1801 (blocked as implausible); Ondo and bStock versions within the 0.80% band · - · these are the SESSION_RICH tickets in the weekend replay sets, with the overpay in dollars
- 2026-10-03 · Agentic Wallet stock-trading guide (developers.binance.com …/use-cases/trading/stock-trading) · the three issuers on the RWA list · names **bStock and Ondo** only, and requires the `binance-tokenized-securities-info` skill · - · Stamp's agentic script stops xStock before `baw`
- 2026-10-03 · Wallet API `POST /api/v1/dex/balance/token-balances-by-address` · balances for USDT and native BNB in one call · documented response `data[].tokenAssets[]` with `balance` (decimal string) and `rawBalance`; "" as the contract address asks for the native asset · - · used before review; if the answer is unusable the check is skipped, not guessed
- 2026-10-03 · Binance Wallet provider docs · detection and events · `window.binancew3w.ethereum`, `isBinance`, rdns `wallet.binance.com`, `getDeeplink(url, chainId)`, and dApps should listen to `accountsChanged` / `chainChanged` · - · Stamp re-checks account and chain before every send and invalidates a review on either event
