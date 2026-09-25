# API notes — verified facts

These are facts observed against the live APIs, dated, with raw payloads in `fixtures/`. The
file is not a copy of the docs: an entry goes in only once we've seen the behavior
ourselves. It feeds the DEVEX raw log.

## 2026-09-25 ~10:00 UTC probe (Fri, US premarket) — `fixtures/probe-2026-09-25/`

### Access
- All five RWA endpoints answered with no key, sending only `User-Agent: binance-web3/1.1 (Skill)`
  and `Accept-Encoding: identity`. The envelope is `{code:"000000", data, success:true}`.
- Binance's authentication doc says "all Web3 API endpoints require authentication". The
  public `bapi` RWA paths are a different host (`www.binance.com/bapi/...`) and don't need
  it. The Trading, Transaction and b402 APIs (`web3.binance.com/build`) do.

### Universe (list endpoint)
- 1,925 rows across chains `56`, `1`, `CT_501` (Solana), `4663` and `8453`.
- On BSC (chainId `"56"`, a **string**): type 1 = 458, type 2 = 128, type 3 = 80, type 4 = 4,
  type 9 = 1.
- The type→issuer mapping was confirmed via meta `name`: 1 = "(Ondo)", 2 = "xStock", 3 = "(bStocks)".
- Type 4 is pre-IPO names (`xOPAI`/OPENAI, `xSPCX`/SPCX, `xKLSH`, `pPOLY`/POLYMARKET).
  Type 9 is `BNC4`. Both are unsupported in v1.
- 515 BSC tickers, **118 with more than one issuer** (e.g. NVDA, AAPL, TSLA, MU, GOOGL, AVGO, ORCL).
- Some rows lack `assetType`, so it's an optional field.
- `lastUpdateTime` appears only on some rows.
- `d` (decimals) is 18 on all rows seen.
- Symbols are **not unique across chains**: `NFLXon` and `NVDAon` exist on BSC, Ethereum and
  Solana with different addresses.

### Large multipliers on BSC (Ondo)
| Symbol | Multiplier |
|---|---|
| NFLXon | 10 |
| PPLTon | 10 |
| KLACon | 10.026064925604903975 |
| PALLon | 5 |
| CVNAon | 5 |
| NOWon | 5 |
| IWFon | 4.012874287579009489 |
| CRWDon | 4 |
| APHon | 2.004270673342698199 |

### Per-issuer shape (dynamic `v2 …/dynamic/ai`)
| Symbol | tokenInfo.price | sharesMultiplier | list multiplier | stockInfo.price | statusInfo.marketStatus | limitInfo |
|---|---|---|---|---|---|---|
| NVDAon | 226.484479035849056746 | 1.0017152487959898 | same | 226.083333 | premarket | — |
| NVDAB | 226.2759563905098582765 | 1.000778223752807865 | same | **null** | **null** | null |
| NVDAx | 224.269085228744065903122755434969591456 | 1.0009180758490996 | **"1"** | 226.083333 | **null** | null |
| NFLXon | 716.26667 | 10 | same | 71.603333 | premarket | `{maxAttestationCount:"500", maxActiveNotionalValue:"400000"}` |

Economic price (`tokenPrice / sharesMultiplier`) against the NVDA reference of 226.083333:
- NVDAon 226.0967 → **+0.6 bps**
- NVDAB 226.1000 → **+0.7 bps**
- NVDAx 224.0634 → **−89.3 bps** (a THIN_BOOK note; not bought extra)
- NFLXon 71.6267 vs 71.603333 → **+3.3 bps**

$20 buys: NVDAon 0.088306 tokens = 0.088458 shares; NFLXon **0.027923 tokens = 0.279226 shares**.

### Full capture 10:11Z (`capture-101145.json`, all 54 BSC instruments for 20 tickers)
| Symbol | tokenInfo.price | dynamic multiplier | list multiplier | stockInfo.price | Reading |
|---|---|---|---|---|---|
| NFLXon | 716.15 | 10 | 10 | 71.603333 | +2 bps, consistent |
| NFLXx | 77.1898… | **10** | **1** | 71.603333 | sources disagree 10×; the price says ~1 share → `MULTIPLIER_CONFLICT` |
| NFLXB | 71.71 | 1 | 1 | null | +15 bps via sibling |
| MUon | 1093.52 | 1.00112… | same | 1092.0125 | +2.6 bps |
| MUx | 980.4846… | 1.00040… | 1 | 1092.0125 | **−1025 bps** → `PRICE_IMPLAUSIBLE` |
| MUB | 1092.7274… | 1.000107… | same | null | +5.5 bps via sibling |
| KLACon | 1904.15 | 10.026064925604903975 | same | 190.18 | `buy 1 KLAC` → `UNIT_AMBIGUOUS` |

Netflix exists on BSC as three products with three different share counts per token:
Ondo 10, bStock 1, and xStock "10" or "1" depending on which endpoint you ask.

### Status
- The venue `market/status` returned `marketStatus: "premarket"`, `nextOpen` 13:31Z, `nextClose`
  13:29Z (next close *before* next open — that's the premarket segment end), plus an
  `offhours` object.
- Asset status for bStock and xStock: `openState: true`, `reasonCode: "TRADING"`, and
  `marketStatus`/`nextOpenTime`/`nextCloseTime` all **null**.
- `dynamic.statusInfo` has the same shape as the asset-status response, so one call gives both.

### Flakiness
- At about 09:58Z, NVDAx returned `data: null` from **both** asset-status and dynamic. At
  10:03Z, the same calls returned full data. Treat `data: null` as "unknown", retry once, and
  never read it as trading.

### Units
- `tokenInfo.volume24h` for NFLXon = 2,021,676,790 — this is US equity dollar volume, not
  on-chain volume. It is not a liquidity signal.
- Prices carry up to 39 decimal places.

## 2026-09-25 close (Fri) — `fixtures/captures/2026-09-25/`
- 19:50Z: venue `regular`. 20:00Z: venue `paused`, openState false, reasonCode `MARKET_PAUSED`,
  reasonMsg "Paused for session transition". 20:10Z onwards: `postmarket`.
- Ondo statusInfo mirrors the venue (`paused` / `MARKET_PAUSED`). bStock and xStock statusInfo
  stay `TRADING` with `marketStatus: null` throughout.
- `stockInfo.price` keeps updating in postmarket (extended-hours prints), so after 20:00 it
  is no longer the close.
- NVDA: 224.4475 (19:50, regular) → 225.3736 (20:00, paused) → 224.9933 (20:10, postmarket).

## Official docs read 2026-09-25 (not yet exercised)

- Trading API: base `https://web3.binance.com/build`, HMAC-SHA256. The pre-hash is
  `timestamp + METHOD + path(with /build + query) + body`, Base64'd. A missing `/build` gives
  `40102 Invalid signature`.
- RWA tokens quote with `executionMode: "RFQ"`: swap returns `rfq.typedDataToSign` →
  `eth_signTypedData_v4` → `POST /api/v1/dex/aggregator/order/submit` → poll
  `GET /api/v1/dex/aggregator/order/{orderId}`.
- `quoteId` "expires in about 30 seconds".
- Transaction API: `POST /api/v1/dex/pre-transaction/simulate` and `.../broadcast-transaction`.
- b402: x402 V1 and V2 facilitator — supported configs, verify, settle; `eip155:56`;
  `eip3009`, `permit2-exact` and `permit2-upto`.
- Agentic Wallet (`baw` CLI): quote-only is supported ("Quote only"), limit orders work on BSC
  and Solana, and daily spending limits exist. **Tokenized stock swaps are not mentioned.**
- Wallet Skills: `binance-tokenized-securities-info` is described as Ondo-only.
