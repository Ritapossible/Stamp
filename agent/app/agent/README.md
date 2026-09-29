# stampagent - MCP + X402 seller agent

The valuable Agent and the **SOLE key-holder/signer** for the stampagent seller.
Serves MCP + X402 directly on AgentCore. Canonical quotes use the one
`[payments.seller].price_usd` value shared by every configured asset and rail;
fixed entrypoint code converts it with the selected asset's catalog decimals,
rejects non-representable values instead of rounding, and signs the selected
token and exact atomic amount. Submit and settle are likewise fixed in
`src/signing.ts` - never an LLM-callable tool.

## What's here

- `src/mcpMain.ts` - MCP serving entrypoint (streamable HTTP on `/mcp`; deploy
  binds `0.0.0.0:8000`, local `bag dev` defaults to `localhost:8000/mcp` to match).
- `src/signing.ts` - protocol-neutral signing entrypoints. ALL on-chain writes
  go through these functions - never an LLM-callable tool.
- `src/model.ts` - provider adapter (e.g. the Pieverse managed model with
  budget-gated LLM-credit auto-renew).
- `src/tools.ts` - read-only chain tools.
- `studio.toml` - Agent's own config (wallet, LLM, canonical seller USD price,
  assets, and budget).
- the wallet key material lives OUTSIDE this sub-project so deploy packaging can
  never bundle it: an evm-local keystore at the WORKSPACE root `.studio/wallets/`,
  or the twak mnemonic in the project's twak home (gitignored either way).

## Set up

```bash
# from the workspace root - installs the agent package too (pnpm workspace):
pnpm install
```

## Run locally

Run the Agent with `bag dev` from the workspace root - it auto-loads
`.studio/.env.local` and runs the agent in-process (`tsx src/mcpMain.ts`, no
Docker). Use `bag dev --container` to run it via `agentcore dev` in Docker
for image parity.

```bash
bag dev                                    # MCP + X402 on http://localhost:8000/mcp
```

## Deploy

```bash
# From the workspace root:
bag deploy --provider aws
# ships to AgentCore (--protocol MCP) after a readiness sweep; the wallet
# is injected via AWS Secrets Manager, never in the package.
```
