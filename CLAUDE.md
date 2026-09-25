# CLAUDE.md — Stamp project memory

Read this file at the start of every session. It is short on purpose. The full design is in
`docs/ARCHITECTURE.md`, the schedule is in `docs/PLAN.md`, and the reasons behind each choice
are in `docs/DECISIONS.md`.

## What Stamp is

Stamp is a **pre-trade gate for tokenized US stocks on BSC**. It is not a trading bot.

You give it an order in plain English, such as "Buy $20 of NVIDIA" or "Buy 1 share of
Netflix". It returns a **hashed, deterministic ticket** with a verdict of `ALLOW`, `WARN` or
`BLOCK`. The verdict comes from four checks: issuer, share count (multiplier), halt state and
session premium. A signature can only be prepared from an `ALLOW` execution ticket that is
tied to a fresh quote.

The one-sentence pitch: **"Your agent can't buy the wrong Netflix."** One `NFLXon` token is
10 Netflix shares (~$716, not ~$72). Stamp catches that before anything is signed.

This is for the BNB Hack: Tokenized Stocks Edition. Submissions are due
**Sun 11 Oct 2026, 12:00 UTC** and judging runs 12–23 Oct. See `docs/HACKATHON.md`.

## Invariants — do not break these

1. **Only BSC mainnet (chainId `56`), spot, buy side.** No perps, leverage, sells or second
   chain. Symbols are not unique across chains (`NFLXon` exists on 56, 1 and Solana), so the
   key is always `(chainId, contractAddress)`.
2. **Never switch issuer.** `NVDAB`, `NVDAon` and `NVDAx` are different legal products. A
   cheaper sibling is information, never a route.
3. **The multiplier is never hardcoded and never defaults to `1`.** If it is missing or
   `<= 0`, the verdict is `BLOCK`. **Neither source is trusted alone.** The engine uses the
   dynamic `tokenInfo.sharesMultiplier` and cross-checks the list `multiplier`. A 2× or
   larger disagreement is `BLOCK MULTIPLIER_CONFLICT` (live example: `NFLXx` list `1` vs
   dynamic `10`).
4. **The engine never uses JavaScript `number` for money, prices or multipliers.** They are
   strings in and out, and `decimal.js` does the math inside. The only integers are basis
   points (`premiumBps`) and seconds.
5. **The verdict is code.** `packages/engine/src/verdict.ts` is the only place a verdict is
   created. No LLM goes into the engine, the hash or signing. Narration is a template filled
   in *after* the verdict and is excluded from the hash.
6. **A decision `ALLOW` is not permission to sign.** Signing needs an execution ticket tied
   to a quote under 30 s old, with the typed data checked against the ticket.
7. **No worker holds a signing key.** A human confirms every fill in v1.
8. **The judge path needs no key.** `npm test` and `npm run replay` run offline from fixtures.
   The public RWA GETs need no key. The Trading API and b402 do, and only the live path uses
   them.
9. **A missing reference is never treated as fair.** It is `WARN NO_REFERENCE`. A missing or
   `null` API `data` field is never treated as "trading". It is `INCOMPLETE_STATUS`.

## Repo layout (target)

```
packages/engine    pure TS, no I/O. types, policy, units, issuer, session, premium, verdict, hash, narrate
packages/sources   Binance RWA client, issuer classifier, snapshot store, wallet adapters (fake + live)
packages/api       HTTP server (Hono), ticket store, standing order worker
apps/web           one screen (Vite + React, no component library)
apps/agent         BNB Agent Studio seller: ERC-8004 identity, MCP tool stamp.ticket, x402 via b402
fixtures/          recorded payloads, never edited by hand; golden/ has expected verdicts
scripts/           probe.ts (record payloads), replay.ts (judge command), snapshot.ts (cron)
docs/              ARCHITECTURE, PLAN, DECISIONS, API-NOTES, HACKATHON
```

## Engine status

`packages/engine` implements the §6 decision table in `docs/ARCHITECTURE.md` (`decide()` in
`verdict.ts`). Golden cases live in `packages/engine/test/cases.ts`, with their files in
`fixtures/golden/`. After an intentional engine change, run `npm run golden:update` and
review the diff. **Never update goldens to make a failing test pass without understanding
why it changed.** Execution tickets (§7) are not built yet.

## Commands

```
npm test                                   all tests, offline
npm run typecheck
npm run golden:update                      after an intentional engine change; review the diff
npm run stamp -- "Buy 1 NFLX"              live decision (public endpoints, no key)
npm run stamp -- "Buy $20 of NVIDIA" --issuer bstock --calls
npm run probe -- NVDAB NFLXx               record raw payloads into fixtures/probe-<date>/
npx tsx scripts/snapshot.ts --out data     one snapshot tick (the workflow runs this every 10 min)
```

`packages/sources` is built: `RwaClient` (fetch is injectable; tests never hit the network),
`buildUniverse`, `toMarketView`, `fromCapture`, `LiveMarket`, `SnapshotStore`. The capture
test proves that raw capture → adapters → engine reproduces the golden hashes.

## Build order (do not skip ahead)

The build order is: engine and fixtures → API and replay → web → wallet (fake, then live
quote) → standing order → Agent Studio → video. **If a session starts on the React app or
the agent before `npm test` is green on the engine, stop and go back.**

## Conventions

- TypeScript strict mode, Node 22, npm workspaces, ESM. Vitest for tests. `tsx` for scripts.
- Tests never hit the network. Record payloads with `scripts/probe.ts` into `fixtures/`,
  then test against the files.
- Every RWA GET sends `User-Agent: binance-web3/1.1 (Skill)` and `Accept-Encoding: identity`.
- The canonical hash is JSON with sorted keys, no whitespace and numbers-as-strings, then
  SHA-256 hex. One function, `packages/engine/src/hash.ts`, is used everywhere.
- Reason codes live in one union type in `packages/engine/src/types.ts`. Add new ones there
  and in the check table in `docs/ARCHITECTURE.md` in the same commit.
- Keep commits small and name the check or module they touch.

## DEVEX.md is the user's voice

`DEVEX.md` is 25% of the score, and AI-generated reports are rejected. **Claude may add dated
raw facts** (the call, what was expected, what came back, the latency) under "Raw log".
**Claude must not write the prose sections or polish the user's wording.** When something
breaks or surprises us, add a raw-log line the same day.

## Out of scope — delete these if they appear

Tax lots, PDFs, baskets, DCA across names, news or earnings trading, charts, cross-issuer
arbitrage, sells, perps, a second chain, an LLM that picks the verdict, unattended signing,
and orders above the policy cap.

## Known API facts (verified 2026-09-25; details in docs/API-NOTES.md)

- On BSC, `type` 1 is Ondo, 2 is xStock, 3 is bStock. Types 4 (pre-IPO: xOPAI, xSPCX…) and 9
  are unsupported and map to `UNKNOWN_TOKEN`.
- Ondo has complete data: `marketStatus`, `nextOpen` and `stockInfo.price`.
- For bStocks and xStocks, `marketStatus` and `nextOpen*` are `null`, so the session comes
  from the venue-level `market/status` plus the NY clock.
- For bStocks, `stockInfo.price` is `null`. The reference is per-ticker, taken from a sibling
  with a live `stockInfo.price` or from the snapshot store.
- xStock responses have been seen as `data: null` and then populated minutes later. Retry
  once, then `INCOMPLETE_STATUS`.
- xStock multipliers are unreliable in **both** sources. The list usually says `"1"` (stale by
  about 0.1%), and the dynamic value for `NFLXx` says `10` while the token is priced as 1 share
  (~$77 vs NFLX $71.60). A small drift is a note; 2× or more is a BLOCK.
- xStock prices can sit far from the stock: `MUx` was −10% (−1025 bps) → `PRICE_IMPLAUSIBLE`.
- Tokenized-stock swaps run in **RFQ mode** in the Trading API: you sign EIP-712 typed data
  and submit an order. There is no transaction to simulate, so the check is "typed data
  matches the ticket".
