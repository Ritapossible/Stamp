import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/latin-800.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "./styles.css";
import { api, ApiError, type ReplayRow, type StandingOrder, type Summary, type Ticket } from "./api";
import { $, h, mount, roundNum, shortHash, trimNum } from "./dom";
import { connect, hasWallet, signTypedData } from "./wallet";

const EXAMPLES = ["Buy 1 NFLX", "Buy $20 of NVIDIA", "Buy $20 of NVDAB", "Buy 1 share of Netflix", "Buy $20 of Micron", "Buy 1 KLAC"];
const ISSUER_NAME: Record<string, string> = { ondo: "Ondo", xstock: "xStock", bstock: "bStock" };

// ——— theme ———
function effectiveTheme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paintThemeButton(): void {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  const btn = $("theme-toggle");
  btn.textContent = `[${next}]`;
  btn.setAttribute("aria-label", `Switch to ${next} theme`);
}

$("theme-toggle").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("stamp-theme", next);
  } catch {
    // private mode: the choice lasts for this page only
  }
  paintThemeButton();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintThemeButton);
paintThemeButton();

// ——— menu ———
const menu = $("menu");
const menuBtn = $("menu-toggle");
function setMenu(open: boolean): void {
  menu.dataset.open = String(open);
  menuBtn.textContent = open ? "[close]" : "[menu]";
  menuBtn.setAttribute("aria-expanded", String(open));
  document.body.style.overflow = open ? "hidden" : "";
}
menuBtn.addEventListener("click", () => setMenu(menu.dataset.open !== "true"));
menu.querySelectorAll("[data-close]").forEach((a) => a.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenu(false);
});

// ——— live figures ———
function stat(value: string, label: string, href: string | null): HTMLElement {
  return href
    ? h("a", { class: "stat", href, ...(href.startsWith("/") ? { target: "_blank", rel: "noopener" } : {}) }, h("b", null, value), h("span", null, label))
    : h("div", { class: "stat" }, h("b", null, value), h("span", null, label));
}

async function loadStats(): Promise<void> {
  const [summary, replay] = await Promise.allSettled([api.summary(), api.replay()]);
  const items: HTMLElement[] = [];
  const live = summary.status === "fulfilled";
  if (live) {
    const s: Summary = summary.value;
    items.push(stat(String(s.multiIssuerTickers), "tickers sold by more than one issuer", "/v1/summary"));
    const top = s.largestMultipliers[0];
    if (top) items.push(stat(`${trimNum(Number.parseFloat(top.multiplier).toFixed(2))}×`, `shares inside one ${top.symbol} token`, "/v1/summary"));
    items.push(stat(String(s.instruments), "tokenized stocks priced on BSC", "/v1/summary"));
  }
  if (replay.status === "fulfilled") {
    items.push(stat(String(replay.value.count), "tickets recomputed", "#replay"));
    items.push(stat(String(replay.value.drifted), "hashes drifted", "#replay"));
    renderReplay(replay.value.rows, replay.value.count, replay.value.drifted);
  } else {
    mount($("replay-table"), h("p", { class: "notice error" }, `Replay unavailable: ${String(replay.reason)}`));
  }
  mount($("stats"), ...items);

  for (const [dot, text] of [
    ["live-dot", "live-text"],
    ["foot-dot", "foot-status"],
  ] as const) {
    $(dot).classList.toggle("down", !live);
    $(text).textContent = live ? "live · Binance public RWA API" : "Binance data unreachable right now";
  }
}

// ——— checker ———
const input = $("order-input") as HTMLInputElement;
const issuerSelect = $("issuer-select") as HTMLSelectElement;
const result = $("result");

mount(
  $("chips"),
  ...EXAMPLES.map((ex) =>
    h("button", { class: "chip", type: "button", onclick: () => {
      input.value = ex;
      void check();
    } }, ex),
  ),
);

$("order-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void check();
});

async function check(): Promise<void> {
  const intent = input.value.trim();
  if (!intent) return;
  const issuer = issuerSelect.value === "any" ? null : issuerSelect.value;
  const btn = $("order-submit") as HTMLButtonElement;
  btn.disabled = true;
  mount(result, h("p", { class: "placeholder" }, h("span", { class: "spinner" }), "reading Binance and running the checks…"));
  try {
    const { ticket } = await api.ticket(intent, issuer);
    mount(result, renderTicket(ticket));
  } catch (err) {
    mount(result, h("p", { class: "notice error" }, err instanceof ApiError && err.status === 503 ? "Binance data is unreachable right now. No ticket was made — Stamp never guesses." : `Could not check: ${String((err as Error).message)}`));
  } finally {
    btn.disabled = false;
  }
}

function sessionWords(t: Ticket): string | null {
  if (!t.session) return null;
  const words: Record<string, string> = {
    regular: "US market open",
    extended: "pre-market / after-hours",
    closed: "US market closed",
    unknown: "session unknown",
  };
  return `${words[t.session] ?? t.session} · ${t.marketStatus ?? "—"}${t.sessionSource === "venue" ? " (venue status)" : ""}`;
}

function referenceWords(t: Ticket): string {
  if (!t.referenceUsd) return "no official price available";
  const src =
    t.referenceSource === "stockInfo"
      ? "live stock price"
      : t.referenceSource === "stockInfo-sibling"
        ? `live stock price, via ${t.referenceSibling}`
        : `last close, ${t.referenceAsOf ? new Date(t.referenceAsOf).toUTCString().slice(5, 22) : ""} UTC`;
  return `$${roundNum(t.referenceUsd, 2)} · ${src}`;
}

function fact(label: string, ...value: Array<Node | string | null>): HTMLElement | null {
  if (value.every((v) => v === null || v === "")) return null;
  return h("div", { class: "fact" }, h("dt", null, label), h("dd", null, ...value));
}

function renderTicket(t: Ticket): HTMLElement {
  const box = h("div", { class: "ticket" });
  const codes = h(
    "div",
    { class: "codes" },
    ...t.reasons.map((r) => h("span", { class: `code ${r === "OK" ? "ALLOW" : t.verdict}` }, r)),
    ...t.notes.map((n) => h("span", { class: "code note" }, n)),
  );
  const facts = h("dl", { class: "facts" });
  const add = (el: HTMLElement | null) => el && facts.append(el);

  if (t.chosen) add(fact("instrument", `${t.chosen.symbol} · ${ISSUER_NAME[t.chosen.issuer] ?? t.chosen.issuer}`, h("span", { class: "sub" }, `  ${shortHash(t.chosen.contractAddress)}`)));
  if (t.unitReadings) {
    const u = t.unitReadings;
    add(fact("if you meant tokens", `${trimNum(t.intent.amount)} token = ${trimNum(u.asTokens.shares)} shares ≈ $${u.asTokens.usd}`));
    add(fact("if you meant shares", `${trimNum(t.intent.amount)} share = ${trimNum(u.asShares.tokens)} token ≈ $${u.asShares.usd}`));
  }
  if (t.tokenUnits && t.economicShares && t.chosen) add(fact("you get", `$${t.notionalUsd} → ${trimNum(t.tokenUnits)} ${t.chosen.symbol} tokens = ${trimNum(t.economicShares)} shares`));
  if (t.multiplier)
    add(fact("one token holds", h("span", { title: t.multiplier }, `${roundNum(t.multiplier, 4)} shares`), t.listMultiplier && t.listMultiplier !== t.multiplier ? h("span", { class: "sub" }, `  · the other Binance endpoint says ${roundNum(t.listMultiplier, 4)}`) : null));
  if (t.economicPriceUsd) add(fact("price per share", `$${roundNum(t.economicPriceUsd, 2)}`, h("span", { class: "sub", title: `${t.tokenPriceUsd} ÷ ${t.multiplier}` }, `  · token $${roundNum(t.tokenPriceUsd, 2)} ÷ ${roundNum(t.multiplier, 4)}`)));
  if (t.referenceSource) add(fact("stock price", referenceWords(t)));
  if (t.premiumBps !== null)
    add(fact("difference", `${t.premiumBps > 0 ? "+" : ""}${t.premiumBps} bps (${(t.premiumBps / 100).toFixed(2)}%)`, t.overpayUsd && t.overpayUsd !== "0.00" ? h("span", { class: "sub" }, `  · about $${t.overpayUsd} overpaid on this order`) : null));
  add(fact("market", sessionWords(t)));
  if (t.reasonMsg) add(fact("binance says", `${t.reasonCode ?? ""} · ${t.reasonMsg}`));
  const others = t.rejected.filter((r) => r.reason === "NEVER_SWITCH");
  if (others.length) add(fact("not the same instrument", others.map((r) => `${r.symbol} (${ISSUER_NAME[r.issuer] ?? r.issuer})`).join(" · ")));

  const copyBtn = h("button", { class: "chip", type: "button" }, "copy");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(t.hash);
      copyBtn.textContent = "copied";
    } catch {
      copyBtn.textContent = "select & copy";
    }
  });
  add(fact("ticket hash", h("span", { class: "hash-row" }, h("span", null, shortHash(t.hash)), copyBtn, h("a", { class: "chip", href: `/v1/tickets/${t.hash}`, target: "_blank", rel: "noopener" }, "verify ↗"))));

  const json = h("pre", { class: "json", hidden: true }, JSON.stringify(t, null, 2));
  const jsonBtn = h("button", { class: "btn ghost small", type: "button", onclick: () => {
    json.hidden = !json.hidden;
    jsonBtn.textContent = json.hidden ? "[json]" : "[hide json]";
  } }, "[json]");
  const exec = h("div", { class: "exec" });
  const actions = h("div", { class: "ticket-actions" });
  if (t.verdict === "ALLOW") actions.append(h("button", { class: "btn small", type: "button", onclick: () => void reviewAndSign(t, exec) }, "review & sign →"));
  actions.append(jsonBtn);

  box.append(h("div", { class: "ticket-head" }, h("span", { class: `verdict ${t.verdict}` }, t.verdict), codes), h("p", { class: "narration" }, plainNarration(t.narration)), facts, actions, exec, json);
  return box;
}

/** The ticket's own sentence, minus the parts the facts table already shows. */
function plainNarration(n: string): string {
  return n
    .replace(/^(ALLOW|WARN|BLOCK)\. /, "")
    .replace(/ Hash [0-9a-f]+…$/, "")
    .replace(/ Not the same instrument: [^.]*\./, "")
    .replace(/ \$[\d.]+ buys [\d.]+ \S+ tokens? = [\d.]+ shares? \(multiplier [\d.]+\)\./, "")
    .trim();
}

// ——— review & sign (the human's own wallet) ———
async function reviewAndSign(t: Ticket, area: HTMLElement): Promise<void> {
  const say = (text: string, error = false) => mount(area, h("p", { class: `notice${error ? " error" : ""}` }, text));
  try {
    if (!hasWallet()) return say("To sign, open this page in a browser with a wallet (MetaMask, Rabby, Binance Wallet). The ticket above stays valid proof either way.");
    say("connecting your wallet…");
    const user = await connect();
    say("getting a fresh quote and checking it against the ticket…");
    const exec = await api.review(t.hash, user);
    const e = exec.ticket;
    const body = h("div", { class: "notice" }, h("b", null, `execution ${e.verdict}`), ` · ${e.narration.replace(/ Hash [0-9a-f]+…$/, "")}`);
    if (e.verdict !== "ALLOW" || !exec.typedData) return mount(area, body);
    const signBtn = h("button", { class: "btn small", type: "button" }, "sign in wallet →");
    signBtn.addEventListener("click", async () => {
      try {
        (signBtn as HTMLButtonElement).disabled = true;
        const signature = await signTypedData(user, exec.typedData);
        say("submitted · waiting for the fill…");
        await api.submit(e.hash, signature);
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const s = await api.execution(e.hash);
          if (s.status && s.status !== "PENDING") return say(`${s.status} · order ${s.submittedOrderId ?? ""}`, s.status !== "FILLED");
        }
        say("still pending — check again in a minute.");
      } catch (err) {
        say(String((err as Error).message), true);
      }
    });
    mount(area, body, h("div", { class: "ticket-actions" }, signBtn));
  } catch (err) {
    if (err instanceof ApiError && err.status === 501) return say("Live execution is switched off on this server. The decision ticket above is still valid, verifiable proof.");
    say(String((err as Error).message), true);
  }
}

// ——— replay ———
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-25-2000-close-pause" → { key: "2026-09-25 2000", label: "25 Sep · 20:00 close pause" } */
function describeSet(set: string): { key: string; label: string } {
  if (set === "golden") return { key: "0", label: "test cases" };
  const m = /^(\d{4})-(\d{2})-(\d{2})-(?:(\d{2})(\d{2})-)?(.*)$/.exec(set);
  if (!m) return { key: set, label: set };
  const [, y, mo, d, hh, mm, rest] = m;
  const day = `${Number(d)} ${MONTHS[Number(mo) - 1]}`;
  return { key: `${y}-${mo}-${d} ${hh ?? "00"}${mm ?? "00"}`, label: `${day} · ${hh ? `${hh}:${mm} ` : ""}${rest!.replace(/-/g, " ")}` };
}

function renderReplay(rows: ReplayRow[], count: number, drifted: number): void {
  $("replay-title-bar").textContent = `stamp — replay · ${count} recomputed · ${drifted} drifted`;
  const sets = [...new Set(rows.map((r) => r.set))].sort((a, b) => describeSet(b).key.localeCompare(describeSet(a).key));
  const tabs = $("replay-tabs");
  const table = $("replay-table");
  const show = (set: string) => {
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.set === set)));
    const body = rows
      .filter((r) => r.set === set)
      .map((r) =>
        h(
          "tr",
          null,
          h("td", null, r.intent),
          h("td", null, r.symbol ?? "—"),
          h("td", null, h("span", { class: `v ${r.verdict}` }, r.verdict)),
          h("td", null, r.reasons.join(", ")),
          h("td", { class: "num" }, r.premiumBps === null ? "" : `${r.premiumBps} bps`),
          h("td", { class: "hash" }, `${r.ok ? "✓ " : "✗ "}${r.hash.slice(0, 12)}`),
        ),
      );
    mount(table, h("table", null, h("thead", null, h("tr", null, ...["order", "token", "verdict", "reason", "premium", "hash"].map((c) => h("th", { scope: "col", class: c === "premium" ? "num" : null }, c)))), h("tbody", null, ...body)));
  };
  mount(tabs, ...sets.map((s) => h("button", { class: "tab", type: "button", role: "tab", "data-set": s, onclick: () => show(s) }, describeSet(s).label)));
  if (sets[0]) show(sets[0]);
}

// ——— standing order ———
async function loadStanding(): Promise<void> {
  const body = $("standing-body");
  let data: { orders: StandingOrder[]; filledTodayUsd: string };
  try {
    data = await api.standing();
  } catch (err) {
    return mount(body, h("p", { class: "placeholder" }, err instanceof ApiError && err.status === 501 ? "Standing orders are switched off on this server." : "Standing orders are unavailable right now."));
  }
  const active = [...data.orders].reverse().find((o) => !["FILLED", "CANCELLED"].includes(o.state)) ?? null;
  const last = [...data.orders].reverse()[0] ?? null;
  const shown = active ?? last;
  const parts: Array<HTMLElement | null> = [];
  if (shown) {
    const lastEvent = shown.events.at(-1);
    parts.push(
      h(
        "dl",
        { class: "facts" },
        fact("state", h("span", { class: `pill ${shown.state}` }, shown.state.replace("_", " "))),
        fact("order", shown.intent),
        fact("last check", lastEvent ? `${new Date(lastEvent.at).toUTCString().slice(5, 22)} UTC · ${lastEvent.note}` : "—"),
        fact("filled today", `$${data.filledTodayUsd} of $50`),
      ),
    );
    if (active) {
      const act = (a: "recheck" | "review" | "cancel", label: string, primary = false) =>
        h("button", { class: `btn small${primary ? "" : " ghost"}`, type: "button", onclick: async () => {
          try {
            await api.standingAction(active.id, a);
          } catch (err) {
            alert((err as Error).message);
          }
          void loadStanding();
        } }, label);
      parts.push(h("div", { class: "ticket-actions" }, act("recheck", "recheck now"), active.state === "READY" ? act("review", "review & sign →", true) : null, act("cancel", "cancel")));
    }
  }
  if (!active) {
    const field = h("input", { class: "order-input", value: "Buy $20 of NVIDIA", maxlength: 200, "aria-label": "Standing order" }) as HTMLInputElement;
    const start = h("button", { class: "btn", type: "button" }, "connect wallet & park it →");
    start.addEventListener("click", async () => {
      try {
        const user = await connect();
        await api.createStanding(field.value.trim(), user);
        void loadStanding();
      } catch (err) {
        alert((err as Error).message);
      }
    });
    parts.push(h("div", { class: "order-form" }, field, start));
    if (!shown) parts.unshift(h("p", { class: "placeholder" }, "No standing order yet. Park one: it is re-checked every ten minutes and waits for your signature when the verdict is ALLOW."));
  }
  mount(body, ...parts);
}

void loadStats();
void loadStanding();
