import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const partial = (name: string) => readFileSync(join(here, "partials", name), "utf8");

/** Every page of the site. Each is a real HTML file, so it reads without JavaScript. */
const PAGES = [
  "index.html",
  "404.html",
  "check/index.html",
  "proof/index.html",
  "standing/index.html",
  "agents/index.html",
  "docs/index.html",
  "docs/checks/index.html",
  "docs/policy/index.html",
  "docs/api/index.html",
  "docs/agent/index.html",
  "docs/verify/index.html",
  "docs/limits/index.html",
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/**
 * The home page's "Buy 1 NFLX" ticket, rendered into the HTML at build time from the golden
 * fixture, so a cold server start never shows an empty hero. It is the recorded ticket, hash and
 * all; the proof page recomputes the same hash.
 */
function nflxTicket(): string {
  const file = JSON.parse(readFileSync(resolve(here, "../../fixtures/golden/nflx-bare-one.json"), "utf8"));
  const t = file.ticket;
  const u = t.unitReadings;
  const names: Record<string, string> = { ondo: "Ondo", xstock: "xStock", bstock: "bStock" };
  const when = new Date(t.asOf).toUTCString().slice(5, 22);
  const others = t.rejected.map((r: { symbol: string; issuer: string }) => `${r.symbol} (${names[r.issuer]})`).join(" · ");
  const fact = (dt: string, dd: string) => `<div class="fact"><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`;
  return `<div class="panel ticket-static">
  <div class="panel-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span><span class="bar-prefix">stamp - </span>${esc(t.intent.raw)}</span><span class="bar-note">recorded ${esc(new Date(t.asOf).toUTCString().slice(5, 16))}</span></div>
  <div class="ticket">
    <div class="ticket-head"><span class="verdict ${t.verdict}">${t.verdict}</span><div class="codes">${t.reasons.map((r: string) => `<span class="code ${t.verdict}">${esc(r)}</span>`).join("")}</div></div>
    <p class="narration">"1 NFLX" has two honest readings. Stamp will not pick one for you.</p>
    <dl class="facts">
      ${fact("if you meant tokens", `1 ${esc(t.chosen.symbol)} token = ${trim(u.asTokens.shares)} shares ≈ <b>$${esc(u.asTokens.usd)}</b>`)}
      ${fact("if you meant shares", `1 share = ${trim(u.asShares.tokens)} token ≈ <b>$${esc(u.asShares.usd)}</b>`)}
      ${fact("instrument", `${esc(t.chosen.symbol)} · ${names[t.chosen.issuer]}`)}
      ${fact("not the same instrument", esc(others))}
      ${fact("ticket hash", `<span class="hash-row"><code class="hash-short" title="${t.hash}">${t.hash.slice(0, 16)}…</code><a class="chip" href="/proof/?set=golden">recomputed on /proof ↗</a></span>`)}
    </dl>
    <p class="ticket-foot">an example, not a quote: Binance's live data at ${esc(when)} UTC · <a href="/check/?q=${encodeURIComponent(t.intent.raw)}">run it live ↗</a></p>
  </div>
</div>`;
}

/** The hero sentence, rounded from the same fixture as the ticket card, so the two never disagree. */
function nflxLede(): string {
  const t = JSON.parse(readFileSync(resolve(here, "../../fixtures/golden/nflx-bare-one.json"), "utf8")).ticket;
  const usd = (s: string) => `$${Math.round(Number(s))}`;
  return `One reading is ${usd(t.unitReadings.asTokens.usd)}. The other is ${usd(t.unitReadings.asShares.usd)}.`;
}

function layout(): Plugin {
  return {
    name: "stamp-layout",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        // "/docs/api/index.html" → "/docs/api/". The header marks its section, the docs nav its page.
        const route = `/${relative(here, ctx.filename).replace(/\\/g, "/")}`.replace(/index\.html$/, "");
        const mark = (src: string, exact: boolean) =>
          src.replace(/<a([^>]*?) href="(\/[^"]*)"/g, (m, pre: string, href: string) => {
            const on = exact ? href === route : href !== "/" && route.startsWith(href);
            return on ? `<a${pre} href="${href}" aria-current="page"` : m;
          });
        return html
          .replace("<!-- @head -->", partial("head.html"))
          .replace("<!-- @header -->", mark(partial("header.html"), false))
          .replace("<!-- @footer -->", partial("footer.html"))
          .replace("<!-- @docs-nav -->", () => mark(partial("docs-nav.html"), true))
          .replace("<!-- @nflx-ticket -->", () => nflxTicket())
          .replace("<!-- @nflx-lede -->", () => nflxLede());
      },
    },
  };
}

export default defineConfig({
  plugins: [layout()],
  server: { proxy: { "/v1": "http://localhost:8787", "/health": "http://localhost:8787" } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p.replace(/\/?index\.html$|\.html$/, "") || "home", resolve(here, p)])),
    },
  },
});
