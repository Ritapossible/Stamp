# BNB Hack: Tokenized Stocks Edition — rules we build against

Sources (read 2026-09-25):
- https://www.bnbchain.org/en/blog/bnb-hack-tokenized-stocks-edition-with-binance-web3-wallet
- https://www.bnbchain.org/en/hackathons/tokenized-stocks

If this summary and the official page disagree, the official page wins.

## Dates (UTC)
| | |
|---|---|
| Build starts | Wed 16 Sep 2026, 12:00 |
| **Submission deadline** | **Sun 11 Oct 2026, 12:00** |
| Screening | 12–14 Oct |
| Judging | 15–23 Oct (the event page says 12–23 Oct) |
| Winners | week of 26 Oct |

## Hard requirements
- **BSC mainnet only.** **Spot only, no perps.**
- bStocks, Ondo or xStocks must be **central** to the product.
- A public repository.
- A deployed link **or** runnable instructions that let judges verify it works.
- A demo video of **4 minutes or less** (the event page says recommended; the blog lists it
  as required, so treat it as required).
- **Developer Experience Report**, mandatory, submitted via the template form. AI-assisted
  writing is OK; **AI-generated reports are rejected.** "Specific and honest beats polite."
- The repo, demo and deployed link must stay reachable through judging.
- One entry per team. Restricted jurisdictions include the US, UK, Canada, Netherlands, Japan
  and others (see the event page).

## Scoring
| Criterion | Weight | What it means for Stamp |
|---|---|---|
| Technical implementation | 30% | It runs, integration depth, **error handling** → golden tests, replay, honest failure states |
| Creativity & originality | 25% | Novel API use, not a clone → share-count/issuer gate with hashed tickets; b402-paid agent face |
| DevEx report | 25% | Time to first call, blockers, error clarity, edge cases, latency, asset behavior (liquidity, slippage, off-hours), **differences between providers**, rebuild suggestions |
| Product quality & UX | 20% | Usable by **non-crypto** users → one screen, plain words, dollars |

Tie-breakers (from the blog): **depth of Binance Web3 API usage**, then DevEx quality.

## Prizes
1st $6k · 2nd $4k · 3rd $3k · 4th $2k · 5th $1k. There are two $2k specials, which need no
separate entry and can stack with a placement:
- **Best Use of Agentic Wallet / Wallet Skills**: "deepest, most credible use of the AI execution layer"
- **Best Use of BNB Agent Studio**: "agent identity, autonomous runtime, self-funding via x402"

## What the DevEx report must cover (our raw log should feed each)
1. Time from docs to first API call
2. Where we got stuck
3. How clear the error messages were
4. Edge cases
5. Latency
6. Tokenized-stock behavior: liquidity, slippage, off-hours
7. Differences between Ondo, bStocks and xStocks
8. "If I owned this platform I would…"

## Links
- Submit project: https://forms.gle/yToDUzaDMwWnq6R6A
- DevEx template: https://forms.gle/EUQ39xf54GHjC2ys5
- Register: https://forms.gle/NEmy3FxYc4f5Dua47
- Telegram: https://t.me/+MhiOLT0YUnlmNWFk
- Docs index (LLM-friendly): https://web3.binance.com/en/dev-docs/llms.txt
- RWA data API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data
- Trading API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api
- Transaction API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/transaction-api
- b402: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/b402-payments
- Agentic Wallet: https://developers.binance.com/en/docs/products/agentic-wallet/welcome
- Wallet Skills: https://developers.binance.com/en/docs/products/wallet-skills/overview
- Skills hub: https://github.com/binance/binance-skills-hub
- API key portal: https://web3.binance.com/en/dev-portal/project
