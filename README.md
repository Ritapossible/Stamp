# Stamp

**A pre-trade gate for tokenized US stocks on BSC.** *Your agent can't buy the wrong Netflix.*

Say "Buy 1 share of Netflix" to an agent on BSC and it may buy `NFLXon`. One `NFLXon` token
is **10 Netflix shares, about $716, not $72**. Say "Buy NVIDIA" and there are three different
legal products to pick from: `NVDAon` (Ondo), `NVDAx` (xStock) and `NVDAB` (bStock). Over the
weekend, a token can trade well above Friday's close with no live print behind it.

Stamp checks an order **before** anything is signed and returns a hashed ticket:

```
BLOCK · UNIT_AMBIGUOUS
"1 NFLX" could mean 1 token (= 10 shares ≈ $716) or 1 share (= 0.1 token ≈ $72).
Say "$72 of Netflix" or "1 share of Netflix".
hash 3f9c…   (recompute it yourself: POST /v1/verify)
```

It checks four things in fixed code, in order: **issuer** (never switched), **share count**
(the multiplier is never assumed to be 1), **halt state** (a corporate action blocks) and
**session premium** (no overpaying while the market is shut). No LLM decides the verdict.
Signing is only prepared from an `ALLOW` execution ticket tied to a fresh quote, with the
exact typed data you sign checked against the ticket. Other agents can buy the same ticket
over x402, settled through Binance b402.

> Status: **in progress**. Built and tested (`npm test`): the verdict engine, the Binance data
> client, the free API with replay and verify, execution tickets and the standing order.
> Next: the web screen, then a live Trading API quote. The design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the
> schedule in [`docs/PLAN.md`](docs/PLAN.md), and the reasoning in
> [`docs/DECISIONS.md`](docs/DECISIONS.md). Live API findings are in
> [`docs/API-NOTES.md`](docs/API-NOTES.md). Built for the
> [BNB Hack: Tokenized Stocks Edition](https://www.bnbchain.org/en/hackathons/tokenized-stocks).

## Try it live — no key needed

```bash
npm ci
npm run stamp -- "Buy 1 NFLX"                 # BLOCK: 1 token = 10 shares
npm run stamp -- "Buy \$20 of NVIDIA"         # ALLOW NVDAon; NVDAx and NVDAB are not the same instrument
npm run stamp -- "Buy \$20 of Micron" --issuer xstock   # BLOCK when MUx is far from the stock
```

## Run it (judges) — no key needed

```bash
git clone https://github.com/Ritapossible/Stamp && cd Stamp
npm ci
npm test          # golden verdict tests, offline
npm run replay    # re-derives last weekend's tickets and checks every hash
```

Expected: one line per ticket, then `103 tickets recomputed · all hashes match`, for example:

```
ok     golden                  Buy 1 NFLX                  NFLXon    BLOCK  UNIT_AMBIGUOUS    476b8e4ef3e9
ok     2026-09-25-premarket    Buy $20 of NFLXx            NFLXx     BLOCK  MULTIPLIER_CONFLICT  bafe687f7356
ok     2026-09-25-premarket    Buy $20 of MUx              MUx       BLOCK  PRICE_IMPLAUSIBLE  -1025 bps  1bc98d447859
```

Run the free API locally with `npm run serve`, then:

```bash
curl -s -X POST localhost:8787/v1/tickets -H 'content-type: application/json' \
  -d '{"intent":"Buy 1 share of Netflix"}'
curl -s localhost:8787/v1/tickets/<hash>          # the ticket plus the inputs it was decided from
curl -s -X POST localhost:8787/v1/verify -H 'content-type: application/json' --data @stored.json
```

## What Stamp is honest about

- The Agentic Wallet and Trading API don't know about Stamp tickets. A caller that skips
  Stamp can still trade. Stamp's guarantee covers flows that go through it.
- For bStocks, Binance's status API returns no market session and no stock reference price.
  Stamp takes the session from the venue-level status and the reference from a same-ticker
  sibling or its own snapshot, and says so on the ticket.
- v1 is buy-only, spot-only, BSC-only, capped at $20 per order, and a person signs every fill.

## Prior art

_(To be written on Day 13, after verifying each project exists. The candidates are a Solana
keeper that skips buys when the pool and Pyth disagree, a CLI that blocks orders while the
US market is closed, an offline signer with a 1% price band, and Binance's own
tokenized-securities skill. Each blocks on one signal. Stamp won't prepare a signature unless
all four pass.)_

## Layout

```
packages/engine   pure verdict engine (no I/O)
packages/sources  Binance RWA client, issuer adapters, snapshots, wallet adapters
packages/api      HTTP API, ticket store, standing order
apps/web          one-screen UI
apps/agent        BNB Agent Studio: ERC-8004 identity, MCP tool, x402 via b402
fixtures/         recorded API payloads and golden cases
```
