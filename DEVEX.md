# Developer Experience Report — Stamp

> **This report is written by the builder, in the builder's own words.** Claude may add dated
> raw facts to the *Raw log* at the bottom (the call, what was expected, what came back, the
> latency). Claude does not write or polish the sections above it. The hackathon rejects
> AI-generated reports, and this is 25% of the score.

## 1. Time from docs to first API call
_(your words)_

## 2. Where I got stuck
_(your words)_

## 3. Error messages — clear or not
_(your words)_

## 4. Edge cases I hit
_(your words)_

## 5. Latency
_(your words — numbers come from the raw log)_

## 6. Tokenized-stock behavior: liquidity, slippage, off-hours
_(your words)_

## 7. Ondo vs bStocks vs xStocks — what differs for a builder
_(your words)_

## 8. If I owned this platform I would…
_(your words)_

---

## Raw log

Format: `date time UTC · call · expected · got · latency · what I did`
Evidence: `fixtures/` and `docs/API-NOTES.md`.

- 2026-09-25 09:58 · `GET …/rwa/asset/market/status/ai` + `v2 …/dynamic/ai` for NVDAx (BSC) · data · `data: null` on both, `success: true` · — · retry-once rule, then INCOMPLETE_STATUS
- 2026-09-25 10:03 · same two calls, NVDAx · data · full data this time · — · noted as intermittent
- 2026-09-25 10:03 · `dynamic` NVDAB · `stockInfo.price`, `statusInfo.marketStatus` · both `null` (Ondo sibling has both) · — · reference from sibling; session from venue status
- 2026-09-25 10:03 · `list` vs `dynamic` multiplier, NVDAx · equal · list `"1"`, dynamic `"1.0009180758490996"` · — · dynamic is source of truth
- 2026-09-25 10:03 · `list` · unique symbols · `NFLXon` exists on chain 56, 1 and Solana with different addresses; my own probe collided on it · — · key by (chainId, address)
- 2026-09-25 10:03 · `dynamic` NFLXon · token ≈ share price · token 716.27, stock 71.60, multiplier 10 · — · this is the demo
- 2026-09-25 · docs · Agentic Wallet swap supports tokenized stocks? · skills reference doesn't mention them · — · test on Day 8–9
- 2026-09-25 · docs · simulate the stock swap · stock swaps are RFQ (EIP-712 typed data), nothing to simulate · — · check typed data against ticket instead
- 2026-09-25 10:11 · `v2 …/dynamic/ai` NFLXx · sharesMultiplier matching list · dynamic `"10"`, list `"1"`, token $77.19 vs NFLX $71.60 · ~150 ms · engine blocks ≥2× disagreement (MULTIPLIER_CONFLICT)
- 2026-09-25 10:11 · `v2 …/dynamic/ai` MUx · price near MU · 980.48 vs stock 1092.01 (−10.25%) · — · PRICE_IMPLAUSIBLE, never read as a bargain
- 2026-09-25 10:11 · `v2 …/dynamic/ai` NFLX family · one share count · Ondo 10, bStock 1, xStock 10-or-1 · — · shown on every ticket
- 2026-09-25 10:12 · snapshot workflow from GitHub Actions runners · Binance may refuse US cloud IPs · 200s on all 56 calls · list ~450 ms, dynamic ~150–200 ms · no workaround needed
