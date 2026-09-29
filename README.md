# Stamp

**A pre-trade gate for tokenized US stocks on BSC.** *Your agent can't buy the wrong Netflix.*

Ondo's Netflix token is ten shares. Binance's is one. xStock's own data disagrees with itself.
Stamp will not guess, and nothing gets signed until the issuer, the share count, the halt, and
the off-hours price all pass.

Stamp checks an order **before** anything is signed and returns a hashed ticket:

```
BLOCK · UNIT_AMBIGUOUS
"1 NFLX" could mean 1 token = 10 shares ≈ $716.15, or 1 share = 0.1 token ≈ $71.62.
Say "$… of" or "… shares of".
hash 476b8e4ef3e9…   (recompute it yourself: npm run replay, or POST /v1/verify)
```

It checks four things in fixed code, in order: **issuer** (never switched), **share count**
(the multiplier is never assumed to be 1), **halt state** (a corporate action blocks) and
**off-hours premium** (no overpaying while the market is shut). No LLM decides the verdict.
The guarantee covers **orders that ask Stamp first**: Stamp does not sit inside Binance's
wallet or signer. For those orders, a quote is only requested after an `ALLOW`, the quote and
transaction are checked against that ticket, and you sign in your own Binance Wallet. Other
agents get the same ticket over MCP or a paid x402 route ([`agent/`](agent/README.md)).

**Live:** https://stamp-iizn.onrender.com ([check](https://stamp-iizn.onrender.com/check/) ·
[proof](https://stamp-iizn.onrender.com/proof/) · [docs](https://stamp-iizn.onrender.com/docs/)).
It runs on a free host, so the first request after a quiet spell takes ~30 s.

<p>
  <img src="docs/screenshots/hero-dark.png" alt="Stamp home page, dark theme" width="49%" />
  <img src="docs/screenshots/ticket-block-light.png" alt="A BLOCK ticket for Buy 1 NFLX, light theme" width="49%" />
</p>

> **Status (2026-09-29).** Working and deployed: the verdict engine, the Binance data client,
> the free API with replay and verify, execution tickets (SWAP and RFQ), the standing order, the
> multi-page site with docs (light and dark), and the Agent Studio agent (MCP tools work
> locally; the paid `/x402` route waits on B402 merchant approval).
> **Execution, by region:** from Render in Frankfurt the Binance Trading API quotes, approves
> and builds the swap. A live review reached `APPROVAL_REQUIRED`, and Binance's approve calldata
> matched Stamp's byte for byte. From US IP addresses the same API answers **`40304` inside an
> HTTP 200**, for tokenized stocks and for WBNB alike. So don't demo execution from GitHub
> Actions or a US laptop. Decisions use public endpoints and work everywhere.
> Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · reasoning: [`docs/DECISIONS.md`](docs/DECISIONS.md) ·
> live API findings: [`docs/API-NOTES.md`](docs/API-NOTES.md) · deploy: [`docs/DEPLOY.md`](docs/DEPLOY.md).
> Built for the [BNB Hack: Tokenized Stocks Edition](https://www.bnbchain.org/en/hackathons/tokenized-stocks).

## Try it live - no key needed

```bash
npm ci
npm run stamp -- "Buy 1 NFLX"                 # BLOCK: 1 token = 10 shares
npm run stamp -- "Buy \$20 of NVIDIA"         # ALLOW NVDAon; NVDAx and NVDAB are not the same instrument
npm run stamp -- "Buy \$20 of Micron" --issuer xstock   # BLOCK when MUx is far from the stock
```

## Run it (judges) - no key needed

```bash
git clone https://github.com/Ritapossible/Stamp && cd Stamp
npm ci
npm test          # golden verdict tests, offline
npm run replay    # re-derives last weekend's tickets and checks every hash
```

Expected: one line per ticket, then `325 tickets recomputed · all hashes match` (the test cases plus four real 2026-09-25 captures: premarket, the last regular print, the 20:00 close pause, and postmarket), for example:

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
- Binance returned SWAP mode, not the RFQ its docs describe, for tokenized stocks from
  Frankfurt. Stamp checks SWAP by simulation and balance changes. The RFQ path is built and
  tested but has not been seen live.
- The full list is on the site: [/docs/limits](https://stamp-iizn.onrender.com/docs/limits/).

## Prior art

- [bozBasket](https://github.com/elaris-xyz/bozBasket) (Solana, Stocklana) defers a recurring
  basket buy on Pyth freshness, confidence, venue divergence, depth and session.
- [PixStock](https://github.com/PixStock/pixstock) (Solana, Stocklana) is an air-gapped phone
  signer that refuses an order more than 1% from a signed Pyth price.
- Binance's [`binance-tokenized-securities-info`](https://www.binance.com/en/skills/detail/binance-web3/binance-tokenized-securities-info)
  skill gives an agent the status codes, multipliers and prices as data and prose. The agent
  that wants the fill still decides.

The two Solana projects gate on price; the skill doesn't gate at all. None of them, as their
READMEs describe it, treats *which issuer's product* or *how many
shares one token holds* as a blocking check, and on BSC those are the two that cost a buyer 10×
or the wrong legal product. Stamp blocks on all four, issuer, share count, halt and off-hours
price, and hashes the answer.

## Layout

```
packages/engine   pure verdict engine (no I/O)
packages/sources  Binance RWA client, issuer adapters, snapshots, wallet adapters
packages/api      HTTP API, ticket store, standing order
apps/web          the site: one HTML page per route, plus /docs
agent/            BNB Agent Studio project (bag init): MCP tools, paid /x402 via B402, ERC-8004
fixtures/         recorded API payloads and golden cases
```
