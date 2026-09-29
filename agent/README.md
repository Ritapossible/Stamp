# Stamp agent (BNB Agent Studio)

The same pre-trade gate as the web page, for other agents. It was scaffolded with
`bag init` (`@bnbagent/studio-cli` 0.0.14), and it keeps Studio's layout and signing
boundaries unchanged.

| Face | What it does | Price |
|---|---|---|
| MCP `stamp_ticket` | `{ intent, issuer? }` → a Stamp decision ticket (ALLOW / WARN / BLOCK, reason codes, hash) | free |
| MCP `stamp_verify` | `{ hash }` → recompute the ticket from its recorded inputs, `matches: true/false` | free |
| `POST /x402` | body `{"prompt": "Buy $20 of NVIDIA"}` (or `{"prompt": "{\"intent\":…,\"issuer\":\"ondo\"}"}`) → the same ticket as JSON | $0.02, settled by B402 **before** the work runs |
| ERC-8004 | on-chain identity pointing at `/mcp` | gas only |

**No check is reimplemented here.** `app/agent/src/stamp.ts` calls the Stamp API
(`STAMP_API_URL`, default `https://stamp-iizn.onrender.com`), and the verdict comes from
`packages/engine`. No LLM runs on any path (`[llm].provider = "none"`). The agent never
signs a trade. Its wallet only receives the $0.02 and signs its own identity.

Files that differ from the scaffold:
- `app/agent/src/stamp.ts` (new): the API client and prompt parser.
- `app/agent/src/mcpMain.ts`: `buildRunWork()` returns Stamp's work, with the two `stamp_*` tools registered.
- `app/agent/studio.toml`: MCP + X402 faces, B402 rail only, `price_usd = "0.02"`, seller enabled.

## Run it locally (no funds, no keys)

```bash
corepack enable                      # pnpm 10
cd agent && pnpm install
(cd app/agent && bag wallet new --generate-password)   # throwaway testnet key, stays in agent/.studio/
STAMP_API_URL=https://stamp-iizn.onrender.com bag dev  # MCP on http://localhost:8000/mcp
```

Then point any MCP client at `http://localhost:8000/mcp` and call `stamp_ticket` with
`{"intent":"Buy 1 NFLX"}`. The answer is BLOCK `UNIT_AMBIGUOUS` with both readings.

`POST /x402` answers `503 x402 rail dormant` until the B402 merchant values exist. That is
expected: nobody can pay, and nothing else breaks.

## Turn on the paid route (you, not Claude: these steps touch your wallet)

1. `(cd app/agent && bag wallet show)`: note the agent address. The $0.02 lands there.
2. Apply for a B402 merchant **for that exact wallet** (manual approval):
   https://developers.binance.com/en/docs/products/onchainpay-x402/basics/6.apply-developer-account
3. Put the four values the approval gives you (`B402_BASE_URL`, `B402_CLIENT_ID`,
   `B402_ACCESS_TOKEN`, `B402_PRIVATE_KEY`) in `agent/.studio/.env.local` with an editor.
   Never paste them into a chat, a commit or a command line.
4. `bag doctor`, then `bag dev`. `POST /x402` now answers `402` with a payment challenge.

## Put it online and give it an identity

- `bag deploy --provider bnb`: the managed BNB trial. It is **BSC testnet and 48 hours only**,
  and the trial wallet key is sent to the operator, so use the throwaway wallet.
- `bag deploy --provider aws | azure | nodeops`: your own cloud, no time limit.
- `bag erc8004 register --protocol MCP --name stamp --description "Pre-trade gate for tokenized stocks on BSC"`
  records the deployed `/mcp` endpoint on chain. Pass `--endpoint <url>` if you host it yourself.

## A second agent paying once

From any other Studio project with a funded wallet:

```bash
bag x402 buy https://<agent-host>/x402 --method POST \
  --json '{"prompt":"Buy $20 of NVIDIA"}' --max-usd 0.05 --asset USDT
```

The response body is `{"result": "<ticket JSON>"}`. Its `verifyUrl` opens the ticket on
`/proof`, where anyone can recompute the hash.

## Limits (also in the web docs)

- Payment settles before the work runs. A malformed order still costs $0.02 and comes back
  as `{"error": …}`. Try it free on MCP first.
- Paid replay protection is Studio's in-memory store (their advisory M01), so it is lost on
  restart. That is fine for a demo at $0.02, not for production.
- The ticket's data is BSC mainnet (live Binance). The agent's payment rail runs on whatever
  `[network].default` says (testnet by default here).
