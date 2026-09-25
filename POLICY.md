# Stamp policy (v1)

This is the policy in plain English. The same values live in `packages/engine/src/policy.ts`,
and their hash (`policyHash`) is on every ticket.

> **Ondo only. Never switch issuer. Never guess what "1" means. Don't buy while a stock is
> halted. If the US market is shut, don't pay more than 0.80% above the last official price.
> At most $20 per order and $50 per day. A person signs every order.**

| Field | Value | Meaning |
|---|---|---|
| `issuer` | `ondo` | Only buy the Ondo version (e.g. `NVDAon`). Other versions are shown but never bought. |
| `neverSwitchIssuer` | `true` | A cheaper `NVDAB` or `NVDAx` is never used instead. The type system forbids `false`. |
| `noiseBandBps` | 10 | ±0.10% from the reference counts as normal (Binance's own guidance). |
| `maxRegularPremiumBps` | 30 | During cash hours, warn if paying more than 0.30% over the live price. |
| `maxClosedPremiumBps` | 80 | Premarket, after-hours, overnight or weekend: warn if paying more than 0.80% over the reference. |
| `implausibleAbsBps` | 500 | More than 5% off the reference in either direction is treated as a data error, and the order is blocked. |
| `maxSlippageBps` | 50 | The quote may be at most 0.50% worse than the price on the decision ticket. |
| `quoteTtlSec` | 25 | Quotes older than 25 s are re-requested. |
| `maxOrderUsd` | "20" | Per-order cap. |
| `maxDayUsd` | "50" | Daily cap, counted from filled orders only. |
| `blockCorporateActions` | `true` | Splits, dividends, mergers, spinoffs and earnings halts block. |

A `WARN` never leads to a signature. A standing order stays parked until a later check says `ALLOW`.
