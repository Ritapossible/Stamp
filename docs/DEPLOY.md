# Deploying Stamp on Render

One Render **web service** runs the API and serves the web page. It is defined in
[`render.yaml`](../render.yaml) and pinned to **Frankfurt**, because Binance's Trading API
refuses requests from the US (`40304 compliance restriction`, see `docs/DECISIONS.md` D20).
Public price data works from anywhere; live quotes only from a non-US region.

## One-time setup (you, ~5 minutes)

1. Sign in at https://dashboard.render.com with GitHub.
2. **New → Blueprint** → pick the `Ritapossible/Stamp` repository. Render reads `render.yaml`.
3. It asks for the two secret values. Paste them **there** (never in chat or the repo):
   - `STAMP_TRADING_API_KEY`
   - `STAMP_TRADING_API_SECRET`

   Leave both empty to deploy without live execution; the page then says so honestly.
4. **Apply**. The first build takes a few minutes. The URL looks like
   `https://stamp-xxxx.onrender.com`.

## Check it works

- `https://<your-url>/health` → `{"ok":true,…,"wallet":"binance-trading-api"}` (or `null` without keys)
- `https://<your-url>/v1/summary` → live counts from Binance
- `https://<your-url>/v1/replay` → `"drifted":0`
- Open the page, press **Buy 1 NFLX** → `BLOCK UNIT_AMBIGUOUS`

## Things to know

- **Free instances sleep** after about 15 minutes idle; the first request then takes 30–60 s.
  Open the page a minute before a demo or a judge's visit.
- **No disk on the free plan.** Tickets made on the server last until it restarts. The
  replay proof is unaffected: it is recomputed from `fixtures/` in the repo on every request.
- **Recorded closes** (the weekend reference) are read from the `snapshots` branch every
  10 minutes via `SNAPSHOTS_REMOTE`.
- **Deploys** follow pushes to `claude/stamp-pretrade-gate-94h6me` (the repo's default branch).
