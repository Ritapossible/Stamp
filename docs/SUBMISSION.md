# Submission pack

Drafts for the submission form and the demo video. Edit freely; every fact here is checked
against the code and the live site as of 3 Oct 2026. The DevEx report is not here: it is
`DEVEX.md`, sections 1-8, in your own words.

- Submit: https://forms.gle/yToDUzaDMwWnq6R6A
- DevEx template: https://forms.gle/EUQ39xf54GHjC2ys5
- Deadline: **Sun 11 Oct 2026, 12:00 UTC**

## Form fields

**Project name:** Stamp

**One line:** A pre-trade gate for tokenized stocks on BSC: issuer, share count, halt and
off-hours price are checked in code, and every answer is hashed, before anything is signed.

**Links**
- Live: https://stamp-iizn.onrender.com
- Repo: https://github.com/Ritapossible/Stamp
- Video: _(your link)_

**Description (about 200 words)**

> A tokenized stock is not a share. On BSC, Netflix exists as three legal products: Ondo's
> `NFLXon` holds 10 shares, bStock's `NFLXB` holds one, and xStock's own two endpoints
> disagreed about `NFLXx` (1 vs 10). Tokens trade all weekend while the stock doesn't, so a
> Saturday price can sit well above Friday's close. An agent asked to "buy 1 Netflix" can buy
> ten, the wrong product, or pay a premium nobody showed it.
>
> Stamp checks the order first, in fixed code: the issuer is never switched, the share count
> is never assumed to be 1, halts block, and the price per share is compared with the real
> stock (0.30% while the market is open, 0.80% over the last close while it's shut). Every
> verdict is a hashed ticket anyone can recompute: the repo replays 621 recorded tickets from
> real Binance captures, including a weekend, with zero drift.
>
> Only an ALLOW reaches a wallet. People sign in Binance Wallet after Stamp checks the Trading
> API's quote and simulated swap. Agents get the same ticket over HTTP, MCP (a BNB Agent Studio
> agent), or in front of Binance's Agentic Wallet, where Stamp also verifies the fill on chain.

**Which Binance APIs** (the tie-breaker is depth of use)
- RWA data API, all five public endpoints: list, venue status, asset status and dynamic in
  every decision; meta in the probe that mapped the issuers.
- Trading API (HMAC): quote, approve-transaction, swap. Live from Frankfurt; SWAP mode.
- Transaction API: pre-transaction/simulate on the approval and the swap, with balance changes.
- Wallet API: token-balances-by-address (USDT and BNB) before any approval is asked for;
  transaction-detail-by-txhash for the fill status.
- Binance Wallet in the browser, per Binance's provider docs: `binancew3w` provider,
  `isBinance`, EIP-6963 (`wallet.binance.com`), the `getDeeplink` "open in Binance app" link,
  a switch to BSC, and `accountsChanged` / `chainChanged` handling.
- Agentic Wallet (`baw`): market-order quote, swap and list, wallet status and address, behind
  Stamp's decision, execution and fill tickets.
- BNB Agent Studio: `bag init` agent with MCP tools, a B402 `/x402` seller route at $0.02, and
  ERC-8004 registration (`bag erc8004 register`).

**Specials**
- Best Use of BNB Agent Studio: `agent/` (MCP `stamp_ticket` / `stamp_verify`, paid `/x402`
  with a free pre-check and durable replay records, ERC-8004).
- Best Use of Agentic Wallet / Wallet Skills: `npm run agentic` and `skills/stamp-gate`.

## Demo video (4 minutes or less)

Record on the live site, ideally during US market hours (13:30-20:00 UTC) so the NVIDIA order
can be ALLOW. Phone or desktop both work; desktop is easier to read on the recording.

| Time | Show | Say (roughly) |
|---|---|---|
| 0:00-0:25 | Home page | "On BSC, one Netflix token is ten shares and another is one. Stamp checks an order before anything is signed." Point at the recorded BLOCK ticket. |
| 0:25-1:05 | /check: press **Buy 1 NFLX** | BLOCK `UNIT_AMBIGUOUS`: both readings in dollars, the other issuers' tokens listed as not the same instrument, the hash. |
| 1:05-1:40 | Press **Buy $20 of NVDAB** (issuer Ondo) | BLOCK `ISSUER_NOT_ALLOWED`: Stamp never swaps you into another issuer's product. Then **Buy $20 of NVIDIA**: ALLOW, $20 → tokens → shares, price per share against the stock. |
| 1:40-2:20 | **review & sign** on the ALLOW | Fresh quote checked against the ticket; first time an exact-amount USDT approval, then the swap, in Binance Wallet. If you have the live fill, show it on BscScan. |
| 2:20-2:55 | /proof: the **26 Sep 16:00 weekend** tab | Real Saturday capture: xStock tokens 1-3% above Friday's close are WARN `SESSION_RICH` with the overpay in dollars. "621 recomputed, 0 drifted." Paste a hash into verify: MATCH. |
| 2:55-3:35 | /agents, then a terminal | The same ticket for agents: MCP `stamp_ticket`, and `npm run agentic -- "Buy $20 of NVIDIA" --dry-run` in front of the Agentic Wallet. The paid `/x402` route refuses an unreadable order for free. |
| 3:35-4:00 | /docs/limits | "Specific beats polite": orders that skip Stamp aren't covered, US addresses are blocked by Binance, and the weekend status we found undocumented. Close on the repo and `npm run replay`. |

## Before you submit

- [ ] One live fill of $20 or less (Binance Wallet on the site, or `npm run agentic`), from
      outside the US; send the BscScan link so it goes in the README.
- [ ] B402 merchant for the agent wallet, then one paid `bag x402 buy`, if approval arrives in time.
- [ ] `DEVEX.md` sections 1-8 in your words, then the DevEx form.
- [ ] Record the video; put the link in the README and the form.
- [ ] Submit the form before Sun 11 Oct 12:00 UTC.
- [ ] Last push before the lock: the hackathon freezes repos at 11 Oct 12:00 UTC. From then
      the snapshot job only pings the site (no commits); it stops itself after judging (23 Oct).
