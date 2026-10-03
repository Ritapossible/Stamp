# Decision log

One entry per decision: what we chose, why, and what we gave up. Newest at the bottom.
Earlier ideas came from a Grok conversation (Afterbell → Stamp). Where live data or official
docs contradicted that spec, the entry says so.

---

### D1 - Build Stamp, not Afterbell (2026-09-25)
**Chosen:** a pre-trade gate that returns hashed tickets.
**Why:** Afterbell (a wallet statement with multiplier-aware lots) already exists on Solana
as Clearbook, StockBasis and Multiplier from the Stocklana hackathon. That costs the 25%
originality score. Stamp's parts exist separately (a weekend price guard, a closed-market
boolean, a signer price band), but nobody combines issuer, share count, halt and premium into
one deterministic, hashed verdict on BSC. *The prior-art repos are not yet verified. Check
them before citing (PLAN Day 13).*
**Gave up:** the statement/tax angle.

### D2 - Lead with share count and issuer, not the weekend premium (2026-09-25)
**Why:** The weekend premium check is the one the prior art already has, and it needs a
snapshot plus a thin weekend book. The multiplier trap is visible on any weekday and is
dramatic (`NFLXon` = 10 shares, $716 vs $72). Judging (12–23 Oct) happens mostly on weekdays.
**Consequence:** the video opens on "Buy 1 share of Netflix".

### D3 - Default demo issuer is Ondo, not bStock (2026-09-25)
**Why:** For bStocks, the probe showed `marketStatus: null`, `nextOpen/Close: null` and
`stockInfo.price: null`. Under the original spec, every bStock would have been
`BLOCK INCOMPLETE_STATUS`, so the product could never say `ALLOW` on its default policy.
Binance's `binance-tokenized-securities-info` skill is also Ondo-only. Ondo has complete data.
**bStock and xStock stay supported:** the session comes from the venue-level status, and the
reference comes from a same-ticker sibling's `stockInfo.price` or a snapshot (D6).

### D4 - Issuer from `type`, key `(chainId, contractAddress)` (2026-09-25)
**Why:** On BSC, `type` 1 is Ondo, 2 is xStock, 3 is bStock (confirmed through the meta
names "Netflix (Ondo)", "NVIDIA xStock" and "NVIDIA (bStocks)"). The same symbol exists on
several chains (`NFLXon` is on 56, 1 and Solana), and the probe script itself hit that
collision when it built a dict keyed by symbol. Symbol parsing is only a display hint.

### D5 - Dynamic `sharesMultiplier` is the source of truth (2026-09-25) - *amended by D13*
**Why:** For xStocks, the list endpoint says `multiplier: "1"` while the dynamic endpoint says
`1.0009…`. For Ondo and bStock they agree. A 2× or larger disagreement blocks
(`MULTIPLIER_CONFLICT`, which is the split case). A small drift warns, except for xStock,
where the list is known stale.

### D6 - The reference is per-ticker, and siblings count (2026-09-25)
**Why:** `stockInfo.price` describes the underlying stock, and Ondo and xStock return
identical values (226.083333 for NVDA). Taking it from a sibling to price a bStock is honest
and the ticket records it (`referenceSource: "live-sibling"`). A sibling's *token* price is
never used.

### D7 - Execution check is "typed data matches the ticket", not tx simulation (2026-09-25)
**Why:** The Trading API executes tokenized stocks in **RFQ mode**. The user signs EIP-712
typed data and the order is submitted off-chain. There is no swap transaction to simulate.
The original spec's "simulate every swap" doesn't apply as written. We decode the typed data
and check the token, amount and recipient against the ticket. Simulation is used only for
the approve tx (SWAP mode).
**DEVEX material:** RFQ vs SWAP is not mentioned in the tokenized-securities skill.

### D8 - x402 settles through Binance b402 (2026-09-25)
**Why:** Binance's Web3 API ships an x402 facilitator (b402: verify and settle on
`eip155:56`). Using it puts the payment itself on the Binance Web3 API, which is the stated
tie-break, and it's the real self-funding path for the Agent Studio special.

### D9 - Human signs every fill in v1 (2026-09-25)
**Why:** Agentic Wallet docs mention swaps and daily limits but not tokenized stocks. An
unattended key is the fastest route to disqualification or a bad demo. The human signing
the typed data *is* the confirmation.
**Revisit:** if `baw` supports stock swaps with a visible standing limit (PLAN Day 8–9).

### D10 - Quote TTL 25 s (2026-09-25)
**Why:** The docs say a quote "expires in about 30 seconds". 25 s leaves a margin, and a
stale quote triggers a re-quote instead of a failed submit.

### D11 - `decimal.js`, not bigint fixed point (2026-09-25)
**Why:** Prices arrive with up to 39 decimal places (`224.269085228744065903122755434969591456`)
and multipliers with 18. `decimal.js` at precision 40 handles both without scaling code.
Numbers stay strings at every boundary, and the only integers are bps and seconds.

### D12 - Verdict combination: first BLOCK stops, WARNs pile up (2026-09-25)
**Why:** A ticket showing every warning is more useful than one showing only the first. A
block ends evaluation because later checks may read fields that are now meaningless.

### D13 - Neither multiplier source is trusted alone (2026-09-25, amends D5)
**Why:** At 10:11Z, the dynamic endpoint reported `NFLXx` `sharesMultiplier: "10"` while the
list said `"1"`. The token trades at ~$77.19 against NFLX's $71.60, so it is priced as ~1
share. The dynamic value is the wrong one here, which is the opposite of the xStock lag seen in
D5. The engine still reads the dynamic value, but a ≥2× disagreement is
`BLOCK MULTIPLIER_CONFLICT` before any price is computed.
**Evidence:** `fixtures/probe-2026-09-25/capture-101145.json`, golden case `nflxx-multiplier-conflict`.

### D14 - `VENUE_CLOSED` is separate from `MARKET_HALTED` (2026-09-25)
**Why:** An instrument whose own `openState` is false may just be closed (possibly Ondo on
weekends; this weekend's captures will show it), not halted. Both BLOCK, but the ticket should
say which one is true. Unknown or null `reasonCode` → `INCOMPLETE_STATUS`, per invariant 9.

### D15 - `reasons` and `notes` are separate (2026-09-25)
**Why:** `THIN_BOOK` and xStock `MULTIPLIER_DRIFT` are worth showing but must not stop an
order. Keeping them out of `reasons` means a verdict can be read from `reasons` alone.

### D16 - Company names come from a fixed alias table (2026-09-25)
**Why:** The list endpoint has no company names. `aliases.ts` maps 20 names to tickers, and
anything else must be typed as a ticker or symbol. No fuzzy matching of stock names: a wrong
guess is exactly the bug Stamp exists to stop.

### D17 - The snapshotter loops instead of relying on cron (2026-09-25)
**Why:** Two hours after the workflow landed, GitHub had not fired a single scheduled run.
Missing Friday's close would cost the first weekend's replay. Each run now loops for about
5.5 h, commits every tick, and dispatches its successor (the workflow token may trigger
`workflow_dispatch`). The cron stays as an hourly watchdog. Captures now carry the universe
rows they were classified from, so a capture replays without a separate list file.

### D18 - Stored tickets keep their inputs (2026-09-25)
**Why:** A hash alone proves nothing to a judge. `GET /v1/tickets/:hash` returns the inputs,
and `POST /v1/verify` recomputes from them. Inputs are trimmed to the chosen instrument's
family (~4 KB), and the trim is only kept if it reproduces the same hash.

### D19 - `paused` is a halt, and the paused print is the close (2026-09-25)
**Why:** At the 20:00Z close, the live API returned `marketStatus: "paused"` ("Paused for
session transition"), while the docs list `pause`. For bStocks and xStocks, whose own status
stays TRADING with a null marketStatus, only the venue said paused, and the old check missed
it. Both spellings now block. The stock print taken during that pause was 41 bps from the
19:50 regular print, so `lastOfficialClose` accepts a `paused` row that directly follows a
`regular` one. Evidence: `fixtures/captures/2026-09-25/{195006,200006,201005}.json` and the
replay sets built from them.

### D20 - Live trading calls must run from outside the US (2026-09-29)
**Why:** The first Trading API quote from the build container (US egress) returned
`40304 compliance restriction` for both USDT→NVDAon and USDT→WBNB, with HTTP 200. Signing was
accepted. The public RWA data endpoints still work from the US, so decisions, replay and the
free API are unaffected. Only quote, submit and b402 need a non-US origin: the deployed API
goes to a non-US region (e.g. Frankfurt or Singapore), or `scripts/quote-probe.ts` runs on
the builder's own machine. `TradingApiClient` already treats a non-zero `code` under HTTP 200
as an error. Evidence: `fixtures/trading/2026-09-29-quote-NVDAon.json`.

### D21 - SWAP mode: approve exactly, simulate, check balances, the wallet sends (2026-09-29)
**Why:** From Frankfurt the Trading API quoted NVDAon in `SWAP` mode (via LiquidMesh), not the
RFQ the docs describe. So the human's wallet sends a normal transaction. Before the execution
ticket can be ALLOW: the swap tx must come from the user and carry no BNB (`TX_MISMATCH`); the
user's USDT allowance for the spender Binance names (`approve-transaction` →
`dexContractAddress`, read over public BSC RPC) must cover the amount, else
`APPROVAL_REQUIRED` with an approve for **exactly** this amount, never unlimited; the swap must
simulate `SUCCESS` (body field `evmParams`, not the docs' `evmTx`); and the simulated balance
changes must show the user receiving the ticket's token and no sibling issuer's
(`SIMULATION_MISMATCH`). RFQ stays supported in case Binance switches.

### D22 - Binance Wallet first (2026-09-29)
**Why:** The hackathon is Binance Web3 Wallet's, and the Agentic Wallet / Wallet special rewards
using it. The page looks for `window.binancew3w.ethereum` (Binance app browser), then an
EIP-6963 announcement with rdns `wallet.binance.com` / `com.binance.wallet` (extension), then
`window.ethereum.isBinance`, and only then any other wallet. With no wallet it offers
**open in Binance app** (the link format of `getDeepLink` in `@binance/w3w-utils` 1.1.8,
reimplemented in a few lines) instead of an error. Source:
https://developers.binance.com/docs/binance-w3w/evm-compatible-provider

### D23 - One HTML page per route, with docs on the site (2026-09-29)
**Why:** One long page read like a landing page, and the docs lived only in the repo. Each
product area (check, proof, standing order, agents) and each doc topic now has its own URL and
a real HTML file, so it reads without JavaScript and can be linked from the submission. The
header, footer and docs nav are partials injected at build time (no framework). The home page
shows a real recorded ticket (Buy 1 NFLX, BLOCK, with its hash) rendered at build time, so a
cold free-tier start never shows an empty hero.

### D24 - The agent calls the Stamp API; the MCP tools are free, /x402 costs $0.02 (2026-09-29)
**Why:** Re-implementing checks in the agent would give two verdicts that could drift. The
agent is a thin Studio project whose work hook posts to `/v1/tickets`, so a paid answer and a
free answer for the same order are the same ticket with the same hash. MCP tools stay free so a
caller can try an order before paying, because B402 settles before the work runs. MCP tool
names use `stamp_ticket` / `stamp_verify` (underscores), which every MCP client accepts.

### D25 - The Agentic Wallet path: check the quote before, the receipt after (2026-09-29)
**Why:** Agents trade through the Binance Agentic Wallet (`baw` CLI, skill
`binance-agentic-wallet` 1.12.0), which trades tokenized stocks (its skill ran a bStock
campaign). The wallet builds and signs the transaction server-side under the person's in-app
limits, so there is no typed data or tx for Stamp to inspect, and `market-order swap` is not
bound to `market-order quote`. So: (1) no `baw` call at all unless the decision is ALLOW;
(2) `prepareAgenticExecution` checks the `baw` quote's symbols, dollars, price and age against
the ticket; it runs again right before the swap; (3) the swap uses the ticket's contract
address and `--slippage` = policy (0.5%); (4) `verifyFill` reads the BSC receipt and checks
that the wallet received the ticket's token, no sibling issuer's token, at a price within
policy. The fill cannot be undone, so its job is to tell the truth about it with a hash. The
session stays in `baw` on the person's machine. Stamp never holds it.

### D26 - Refuse unpayable work before payment; keep replay records on disk (2026-09-30)
**Why:** B402 settles before the work runs and Studio gives no hook in between, so the check has
to sit in front of `seller.handle`. `/x402` now parses the prompt exactly as the seller does and
asks Stamp's new `POST /v1/intent` (grammar only, no Binance call, nothing stored). An
unreadable order or an unreachable Stamp returns `400`/`503` with `"charged": false` and no
payment challenge. A readable order that gets BLOCK stays a paid answer. The replay guard
(Studio advisory M01) is a JSON file with serialised atomic writes instead of memory, so a
restart cannot accept one payment twice; it covers one process with a persistent disk.

### D27 - `offhours` means closed; four more replay sets (2026-10-03)
**Why:** Building replay sets from the weekend captures showed Ondo's per-token
`marketStatus: "offhours"` on Saturday and Sunday, a value missing from the documented list.
Stamp treated it as unknown (WARN `SESSION_UNKNOWN`), so no Ondo weekend order could be
compared with Friday's close. The token is trading (reasonCode TRADING), the venue says
`closed` and the clock agrees, so `offhours` maps to `closed`. No earlier recorded ticket
contained it, so every Friday and golden hash is unchanged. Four sets were added from the
`snapshots` branch: Sat 26 Sep 16:00Z, Sun 27 Sep 23:30Z, Mon 28 Sep 12:00Z and 19:50Z
(captures pause during Monday cash hours); the replay is now 621 tickets.

### D28 - Follow the handbook's wallet guidance (2026-10-03)
**Why:** A pass over the hackathon page and the docs it links found three gaps. (1) Binance's
Wallet API was unused, so a wallet without enough USDT was asked to approve and sign a swap
that would fail; now `token-balances-by-address` runs before the quote's checks finish and the
execution ticket blocks `INSUFFICIENT_BALANCE` (E6b) before any approval. An unusable answer
skips the check instead of guessing. (2) Binance's provider docs ask dApps to handle
`accountsChanged` and `chainChanged`; a switch after review could have sent a checked
transaction from another account or chain. Now every send or signature first confirms the
reviewed account and chain 56, and a change invalidates the review on screen. (3) Binance's
Agentic Wallet stock-trading guide covers bStock and Ondo only, so `npm run agentic` stops an
xStock ALLOW before calling `baw`.
