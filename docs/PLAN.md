# Stamp — Build Plan

Today is **Fri 2026-09-25**. Submissions close **Sun 2026-10-11 12:00 UTC**. The target is
to **submit on Sat 10 Oct**, leaving a day of margin. US cash hours are 13:30–20:00 UTC while
EDT is in effect (all of this window). DST ends Sun 1 Nov and starts Sun 8 Mar, so test both.

Each day has a **done-when** line. A day isn't done until its done-when is true, whatever
else got built.

## Hard dates you cannot move

| When (UTC) | Why it matters |
|---|---|
| **Fri 25 Sep before 20:00 — today** | The snapshotter must be recording, so a real Friday close exists for the first weekend. |
| Sat 26 – Sun 27 Sep | First weekend capture → `fixtures/last-weekend/` (v1). |
| Fri 2 Oct before 20:00 | Check the snapshotter is still alive before the second weekend. |
| Sat 3 – Sun 4 Oct | Second weekend capture. This becomes the demo's "last weekend" if it's better. |
| A weekday 13:30–20:00, Mon 5 – Thu 8 Oct | One live, human-confirmed buy of ≤ $20. It only happens if that day's ticket is `ALLOW`. |
| Sat 10 Oct | Submit the project form and the DevEx form. |
| Sun 11 Oct 12:00 | Hard deadline. |
| 12 – 23 Oct | Judging. The deployed link and the replay must stay up. |

## Admin (do these today)

- [ ] Register: https://forms.gle/NEmy3FxYc4f5Dua47 (this also unlocks the free API tier)
- [ ] Create a Binance Web3 API project and key: https://web3.binance.com/en/dev-portal/project
- [ ] Join the builder Telegram: https://t.me/+MhiOLT0YUnlmNWFk
- [ ] Open the DevEx template form and copy its questions into `DEVEX.md` headings: https://forms.gle/EUQ39xf54GHjC2ys5
- [ ] Start a stopwatch on "docs → first successful call" and write it in DEVEX today.
- [ ] Fund one BSC wallet with ~$30 USDT plus a little BNB for gas (demo only).

## Schedule

### Fri 25 Sep — Day 0: docs, skeleton, **snapshotter live by 20:00 UTC**
- [x] Probe the live endpoints and record `fixtures/probe-2026-09-25/`
- [x] Write CLAUDE.md, ARCHITECTURE, PLAN, DECISIONS, API-NOTES and HACKATHON
- [x] npm workspaces skeleton, tsconfig, vitest, and CI (`.github/workflows/ci.yml`)
- [x] `scripts/snapshot.ts`, a standalone script (moves onto `packages/sources` on Day 3). Each tick:
      1. appends one line per ticker to `data/snapshots/YYYY-MM-DD.jsonl` for 20 tickers (NVDA,
         NFLX, AAPL, TSLA, MSFT, GOOGL, AMZN, META, MU, AVGO, KLAC, CRWD, NOW, CVNA, SPY, QQQ,
         ORCL, AMD, COIN, PLTR), with every BSC issuer's token price, multiplier, status and
         the ticker's `stockInfo.price`
      2. writes raw payloads to `data/captures/YYYY-MM-DD/HHMMSS.json` off-hours (half-hourly)
         and on every tick from 19:50 to 20:20 UTC around the close
- [x] `.github/workflows/snapshot.yml` runs it every 10 min and commits to the **`snapshots`
      branch**. The schedule only runs from the default branch.
- [ ] Confirm the first scheduled runs landed on `snapshots`. GitHub cron is best-effort, so
      if runs are skipped or Binance refuses GitHub's US runners, start the backup on any
      always-on machine outside the US: `npm ci && npx tsx scripts/snapshot.ts --loop 600`
- **Done when:** `snapshots` has rows from today's regular session and keeps growing with
  your laptop closed.

### Sat 26 – Sun 27 Sep — Days 1–2: the engine
- [x] `decimal.ts`, `types.ts`, `policy.ts`, `hash.ts` (with tests first) — done Fri 25 Sep
- [x] `intent.ts` grammar: `$N of X`, `N shares of X`, `N X tokens`, bare `N X` → ambiguous
- [x] `unit.ts`, `issuer.ts`, `session.ts` (DST tests), `reference.ts`, `premium.ts`
- [x] `verdict.ts` covering the whole §6 table: 29 golden cases (15 unmodified live data,
      14 labelled synthetic changes of it), 83 tests in total
- [ ] Replace the synthetic weekend cases with real ones from the 26–27 Sep captures
- [ ] Look at the live weekend captures on Saturday. Record anything odd in the DEVEX raw log.
- **Done when:** every §6 row has a passing golden test, same inputs give the same hash, and
  there's no network in tests.

### Mon 28 Sep — Day 3: sources
- [x] `packages/sources/rwa.ts` with typed responses, retry-once on `data:null`, and latency logging — done Fri 25 Sep
- [x] `classify.ts` (keyed by `(chainId, address)`), and `adapters.ts` → `MarketView`
- [x] `snapshots.ts`, `capture.ts`, `market.ts`; the snapshot script now uses the shared client
- [x] `npm run stamp -- "Buy 1 NFLX"` — a live decision from the command line, no key
- [ ] Turn the weekend captures into `fixtures/last-weekend/` MarketView sets
- **Done when:** adapters produce `MarketView`s from every captured payload, with tests.

### Tue 29 Sep — Day 4: API and replay
- [x] Hono server with `POST /v1/tickets`, `GET /v1/tickets/:hash`, `POST /v1/verify` — done Fri 25 Sep
- [x] `tickets.ts` JSONL store with re-hash on read
- [x] `scripts/replay.ts` and `GET /v1/replay` (golden + every `fixtures/replay/<set>`);
      `scripts/build-replay.ts` turns a capture into a set (first set: `2026-09-25-premarket`, 74 tickets)
- [ ] Build `fixtures/replay/2026-09-26-weekend` from Saturday's captures on the `snapshots` branch
- **Done when:** `git clone && npm ci && npm run replay` prints a table and exits 0 on a
  clean machine with no key.

### Wed 30 Sep — Day 5: web screen
- [ ] One page, three example chips, the ticket card, the last-weekend table, a JSON toggle
- [ ] Copy pass: nothing a non-crypto person wouldn't understand on the first line
- [ ] Deploy the API and web, and put a public URL in the README
- **Done when:** a friend who doesn't do crypto can explain the NFLX `BLOCK` back to you.

### Thu 1 Oct — Day 6: Trading API, quote only
- [ ] HMAC client (include `/build` in the signed path), with a test against the doc's example
- [ ] `quote` for USDT→NVDAon $20 on BSC. Record the raw response and confirm `executionMode: RFQ`
- [ ] Log: time to the first 200, and each error code with its message → DEVEX raw log
- **Done when:** a real quote payload is recorded in `fixtures/trading/`.

### Fri 2 Oct — Day 7: execution ticket
- [ ] `prepare` → `rfq.typedDataToSign`, and decode it. Record which fields hold token, amount and recipient
- [ ] `execution.ts` checks E1–E8, `FakeWallet` tests for each row
- [ ] Approve-tx simulate via `pre-transaction/simulate`
- [ ] Snapshotter check before 20:00 UTC
- **Done when:** an execution ticket is produced from a live quote, and **nothing is submitted**.

### Sat 3 – Sun 4 Oct — Days 8–9: confirm flow, Agentic Wallet, standing order
- [ ] Review button → execution ticket → wallet connect (injected/WalletConnect) →
      `eth_signTypedData_v4` → `POST submit` → poll. Re-quote on `QUOTE_STALE`.
- [ ] Install `binance-agentic-wallet`. Test whether `baw` can quote and buy a **tokenized stock**
      on BSC (the docs list swaps but don't mention stocks). Record the result in DEVEX either way.
  - If yes: add `wallet-baw.ts` behind `StockWallet`, and show it in the video as the agent path.
  - If no: note it in DEVEX, and keep the Trading API RFQ path as the executor.
- [ ] `standing.ts` state machine, 10-min recheck, daily cap from `FILLED`, and a pill in the web app
- **Done when:** the confirm flow works against `FakeWallet` in the browser, and a standing
  order sat `PARKED` through the weekend with tickets appended.

### Mon 5 Oct — Day 10: live fill (cash hours)
- [ ] Run the NVDAon $20 decision. If it's `ALLOW`, review, sign and submit, then record the
      order id, tx hash and ticket hashes.
- [ ] If it isn't `ALLOW`, don't force it. Try again Tue or Wed.
- **Done when:** one `FILLED` ticket exists with a BscScan link. Otherwise, record the attempt honestly.

### Tue 6 – Wed 7 Oct — Days 11–12: Agent Studio
- [ ] `npm i -g @bnbagent/studio-cli`, `bag skills install`, `bag init` in `apps/agent`
- [ ] MCP tool `stamp.ticket` (the same zod schema as the HTTP body)
- [ ] `POST /x402` settled via b402 verify/settle at a fixed `0.02` USDT
- [ ] Register the ERC-8004 identity on BSC. Record the tx.
- [ ] A second client pays once (`bag x402 buy` or a script). Record the settlement tx.
- **Done when:** a paid call returns a ticket whose hash verifies on the free `/v1/verify`.

### Thu 8 Oct — Day 13: harden and README
- [ ] README judge path: three commands, expected output pasted in
- [ ] README prior-art paragraph. Verify each named repo exists first, and drop any that don't.
- [ ] Error states on the web app (API down, no reference, quote stale)
- [ ] Freeze the fixtures and tag `v1.0.0-rc`
- **Done when:** a fresh clone on another machine passes `npm ci && npm test && npm run replay`.

### Fri 9 Oct — Day 14: video
- [ ] Record the video (script below), ≤ 4:00. Do the retakes today, not tomorrow.

### Sat 10 Oct — Day 15: DEVEX and submit
- [ ] **You** write DEVEX.md from the raw log. Claude doesn't write the prose.
- [ ] Submit the project form (https://forms.gle/yToDUzaDMwWnq6R6A) and the DevEx form. Tag `v1.0.0`.
- **Done when:** both forms are submitted and the confirmation emails are saved.

### Sun 11 Oct — buffer only. The deadline is 12:00 UTC.

## Cut order if behind

Cut from the top first: **standing order → ERC-8004 → x402 paid face → Agentic Wallet `baw`
adapter → live fill**. Never cut: the engine, golden tests, `npm run replay`, the web
screen, `DEVEX.md`.

## Video script (≤ 4:00)

1. **0:00–0:30** "Buy 1 share of Netflix." Show that the naive path buys `NFLXon`, where one
   token is 10 shares, about $716.
2. **0:30–1:15** Stamp: `BLOCK UNIT_AMBIGUOUS`, with both readings in dollars. Then
   "Buy $20 of NVIDIA" → chooses `NVDAon`, with `NVDAB` and `NVDAx` under "not the same instrument".
3. **1:15–1:50** Last weekend replay: a `SESSION_RICH` row with "$0.xx overpay". Copy the
   hash and run `POST /v1/verify` to get the same hash.
4. **1:50–2:40** A weekday `ALLOW` → Review → execution ticket → sign in wallet → `FILLED`, with the BscScan link.
5. **2:40–3:20** Another agent pays $0.02 over x402 (b402 settle tx) and gets the same ticket shape.
6. **3:20–4:00** The one-sentence claim, the honest limit, `npm run replay`. Stop.

## Daily habit

At the end of each day: one line in the DEVEX raw log (`YYYY-MM-DD · call · expected · got ·
latency · what I did`), then commit and push.
