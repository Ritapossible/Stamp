# Decision log

One entry per decision: what we chose, why, and what we gave up. Newest at the bottom.
Earlier ideas came from a Grok conversation (Afterbell → Stamp). Where live data or official
docs contradicted that spec, the entry says so.

---

### D1 — Build Stamp, not Afterbell (2026-09-25)
**Chosen:** a pre-trade gate that returns hashed tickets.
**Why:** Afterbell (a wallet statement with multiplier-aware lots) already exists on Solana
as Clearbook, StockBasis and Multiplier from the Stocklana hackathon. That costs the 25%
originality score. Stamp's parts exist separately (a weekend price guard, a closed-market
boolean, a signer price band), but nobody combines issuer, share count, halt and premium into
one deterministic, hashed verdict on BSC. *The prior-art repos are not yet verified. Check
them before citing (PLAN Day 13).*
**Gave up:** the statement/tax angle.

### D2 — Lead with share count and issuer, not the weekend premium (2026-09-25)
**Why:** The weekend premium check is the one the prior art already has, and it needs a
snapshot plus a thin weekend book. The multiplier trap is visible on any weekday and is
dramatic (`NFLXon` = 10 shares, $716 vs $72). Judging (12–23 Oct) happens mostly on weekdays.
**Consequence:** the video opens on "Buy 1 share of Netflix".

### D3 — Default demo issuer is Ondo, not bStock (2026-09-25)
**Why:** For bStocks, the probe showed `marketStatus: null`, `nextOpen/Close: null` and
`stockInfo.price: null`. Under the original spec, every bStock would have been
`BLOCK INCOMPLETE_STATUS`, so the product could never say `ALLOW` on its default policy.
Binance's `binance-tokenized-securities-info` skill is also Ondo-only. Ondo has complete data.
**bStock and xStock stay supported:** the session comes from the venue-level status, and the
reference comes from a same-ticker sibling's `stockInfo.price` or a snapshot (D6).

### D4 — Issuer from `type`, key `(chainId, contractAddress)` (2026-09-25)
**Why:** On BSC, `type` 1 is Ondo, 2 is xStock, 3 is bStock (confirmed through the meta
names "Netflix (Ondo)", "NVIDIA xStock" and "NVIDIA (bStocks)"). The same symbol exists on
several chains (`NFLXon` is on 56, 1 and Solana), and the probe script itself hit that
collision when it built a dict keyed by symbol. Symbol parsing is only a display hint.

### D5 — Dynamic `sharesMultiplier` is the source of truth (2026-09-25) — *amended by D13*
**Why:** For xStocks, the list endpoint says `multiplier: "1"` while the dynamic endpoint says
`1.0009…`. For Ondo and bStock they agree. A 2× or larger disagreement blocks
(`MULTIPLIER_CONFLICT`, which is the split case). A small drift warns, except for xStock,
where the list is known stale.

### D6 — The reference is per-ticker, and siblings count (2026-09-25)
**Why:** `stockInfo.price` describes the underlying stock, and Ondo and xStock return
identical values (226.083333 for NVDA). Taking it from a sibling to price a bStock is honest
and the ticket records it (`referenceSource: "live-sibling"`). A sibling's *token* price is
never used.

### D7 — Execution check is "typed data matches the ticket", not tx simulation (2026-09-25)
**Why:** The Trading API executes tokenized stocks in **RFQ mode**. The user signs EIP-712
typed data and the order is submitted off-chain. There is no swap transaction to simulate.
The original spec's "simulate every swap" doesn't apply as written. We decode the typed data
and check the token, amount and recipient against the ticket. Simulation is used only for
the approve tx (SWAP mode).
**DEVEX material:** RFQ vs SWAP is not mentioned in the tokenized-securities skill.

### D8 — x402 settles through Binance b402 (2026-09-25)
**Why:** Binance's Web3 API ships an x402 facilitator (b402: verify and settle on
`eip155:56`). Using it puts the payment itself on the Binance Web3 API, which is the stated
tie-break, and it's the real self-funding path for the Agent Studio special.

### D9 — Human signs every fill in v1 (2026-09-25)
**Why:** Agentic Wallet docs mention swaps and daily limits but not tokenized stocks. An
unattended key is the fastest route to disqualification or a bad demo. The human signing
the typed data *is* the confirmation.
**Revisit:** if `baw` supports stock swaps with a visible standing limit (PLAN Day 8–9).

### D10 — Quote TTL 25 s (2026-09-25)
**Why:** The docs say a quote "expires in about 30 seconds". 25 s leaves a margin, and a
stale quote triggers a re-quote instead of a failed submit.

### D11 — `decimal.js`, not bigint fixed point (2026-09-25)
**Why:** Prices arrive with up to 39 decimal places (`224.269085228744065903122755434969591456`)
and multipliers with 18. `decimal.js` at precision 40 handles both without scaling code.
Numbers stay strings at every boundary, and the only integers are bps and seconds.

### D12 — Verdict combination: first BLOCK stops, WARNs pile up (2026-09-25)
**Why:** A ticket showing every warning is more useful than one showing only the first. A
block ends evaluation because later checks may read fields that are now meaningless.

### D13 — Neither multiplier source is trusted alone (2026-09-25, amends D5)
**Why:** At 10:11Z, the dynamic endpoint reported `NFLXx` `sharesMultiplier: "10"` while the
list said `"1"`. The token trades at ~$77.19 against NFLX's $71.60, so it is priced as ~1
share. The dynamic value is the wrong one here, which is the opposite of the xStock lag seen in
D5. The engine still reads the dynamic value, but a ≥2× disagreement is
`BLOCK MULTIPLIER_CONFLICT` before any price is computed.
**Evidence:** `fixtures/probe-2026-09-25/capture-101145.json`, golden case `nflxx-multiplier-conflict`.

### D14 — `VENUE_CLOSED` is separate from `MARKET_HALTED` (2026-09-25)
**Why:** An instrument whose own `openState` is false may just be closed (possibly Ondo on
weekends; this weekend's captures will show it), not halted. Both BLOCK, but the ticket should
say which one is true. Unknown or null `reasonCode` → `INCOMPLETE_STATUS`, per invariant 9.

### D15 — `reasons` and `notes` are separate (2026-09-25)
**Why:** `THIN_BOOK` and xStock `MULTIPLIER_DRIFT` are worth showing but must not stop an
order. Keeping them out of `reasons` means a verdict can be read from `reasons` alone.

### D16 — Company names come from a fixed alias table (2026-09-25)
**Why:** The list endpoint has no company names. `aliases.ts` maps 20 names to tickers, and
anything else must be typed as a ticker or symbol. No fuzzy matching of stock names: a wrong
guess is exactly the bug Stamp exists to stop.

### D17 — The snapshotter loops instead of relying on cron (2026-09-25)
**Why:** Two hours after the workflow landed, GitHub had not fired a single scheduled run.
Missing Friday's close would cost the first weekend's replay. Each run now loops for about
5.5 h, commits every tick, and dispatches its successor (the workflow token may trigger
`workflow_dispatch`). The cron stays as an hourly watchdog. Captures now carry the universe
rows they were classified from, so a capture replays without a separate list file.

### D18 — Stored tickets keep their inputs (2026-09-25)
**Why:** A hash alone proves nothing to a judge. `GET /v1/tickets/:hash` returns the inputs,
and `POST /v1/verify` recomputes from them. Inputs are trimmed to the chosen instrument's
family (~4 KB), and the trim is only kept if it reproduces the same hash.
