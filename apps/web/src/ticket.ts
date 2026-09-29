/** A decision ticket on screen, and the review & sign flow that follows an ALLOW. */
import { api, ApiError, type ExecView, type Ticket } from "./api";
import { h, mount, roundNum, shortHash, trimNum } from "./dom";
import { binanceAppLink, connect, type Eip1193, findWallet, sendTx, signTypedData, waitReceipt } from "./wallet";

export const ISSUER_NAME: Record<string, string> = { ondo: "Ondo", xstock: "xStock", bstock: "bStock" };

function sessionWords(t: Ticket): string | null {
  if (!t.session) return null;
  const words: Record<string, string> = {
    regular: "US market open",
    extended: "pre-market / after-hours",
    closed: "US market closed",
    unknown: "session unknown",
  };
  return `${words[t.session] ?? t.session} · ${t.marketStatus ?? "-"}${t.sessionSource === "venue" ? " (venue status)" : ""}`;
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

export function fact(label: string, ...value: Array<Node | string | null>): HTMLElement | null {
  if (value.every((v) => v === null || v === "")) return null;
  return h("div", { class: "fact" }, h("dt", null, label), h("dd", null, ...value));
}

export function renderTicket(t: Ticket): HTMLElement {
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
  add(fact("ticket hash", h("span", { class: "hash-row" }, h("span", null, shortHash(t.hash)), copyBtn, h("a", { class: "chip", href: `/proof/?hash=${t.hash}` }, "verify ↗"))));

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

// --- review & sign (the human's own wallet; Binance Wallet first) ---
const clean = (n: string) => n.replace(/^(ALLOW|WARN|BLOCK)\. /, "").replace(/ Hash [0-9a-f]+…$/, "");

/** Shown when no wallet is injected: reopen the page inside the Binance app, or install a wallet. */
function noWalletHelp(): HTMLElement {
  const link = binanceAppLink();
  return h(
    "div",
    { class: "notice" },
    h("p", { style: "margin:0 0 12px" }, "Sign with Binance Wallet. On a phone, open this page inside the Binance app; on a computer, install the Binance Wallet extension. Any other BSC wallet works too."),
    h("div", { class: "hash-row" }, h("a", { class: "btn small", href: link.http }, "open in Binance app →"), h("a", { class: "chip", href: "https://www.binance.com/en/web3wallet", target: "_blank", rel: "noopener" }, "get Binance Wallet ↗")),
  );
}

export async function connectOrExplain(area: HTMLElement): Promise<{ user: string; provider: Eip1193; name: string } | null> {
  try {
    return await connect();
  } catch (err) {
    if ((err as Error).message === "NO_WALLET") mount(area, noWalletHelp());
    else mount(area, h("p", { class: "notice error" }, (err as Error).message));
    return null;
  }
}

/**
 * Walks one execution to the end with the human's wallet:
 * APPROVAL_REQUIRED → send the exact-amount approval, wait, review again;
 * ALLOW + SWAP → send the checked transaction; ALLOW + RFQ → sign the checked typed data.
 * `onSent` lets a standing order record the transaction too.
 */
export async function carryOut(view: ExecView, w: { user: string; provider: Eip1193; name: string }, area: HTMLElement, again: () => Promise<void>, onSent?: (txHash: string) => Promise<void>): Promise<void> {
  const say = (text: string, error = false) => mount(area, h("p", { class: `notice${error ? " error" : ""}` }, text));
  const e = view.ticket;
  const step = e.reasons.includes("APPROVAL_REQUIRED") ? "step 1 of 2 · approve" : e.verdict === "ALLOW" ? (e.executionMode === "SWAP" ? "ready to send" : "ready to sign") : `execution ${e.verdict}`;
  const summary = h("p", { class: "notice" }, h("b", null, step), ` · ${clean(e.narration)}`);

  if (e.reasons.includes("APPROVAL_REQUIRED") && view.approvalTx) {
    const btn = h("button", { class: "btn small", type: "button" }, `approve $${e.amountInUsd} USDT in ${w.name} →`);
    btn.addEventListener("click", async () => {
      try {
        (btn as HTMLButtonElement).disabled = true;
        say("waiting for the approval in your wallet…");
        const hash = await sendTx(w.provider, view.approvalTx!, w.user);
        say("approval sent · waiting for it to confirm…");
        if (!(await waitReceipt(w.provider, hash))) return say("The approval failed on chain.", true);
        say("approved · getting a fresh quote…");
        await again();
      } catch (err) {
        say((err as Error).message, true);
      }
    });
    return mount(area, summary, h("div", { class: "ticket-actions" }, btn));
  }
  if (e.verdict !== "ALLOW") return mount(area, summary);

  const btn = h("button", { class: "btn small", type: "button" }, e.executionMode === "SWAP" ? `send in ${w.name} →` : `sign in ${w.name} →`);
  btn.addEventListener("click", async () => {
    try {
      (btn as HTMLButtonElement).disabled = true;
      if (e.executionMode === "SWAP" && view.tx) {
        const hash = await sendTx(w.provider, view.tx, w.user);
        await api.sent(e.hash, hash);
        if (onSent) await onSent(hash);
        say("sent · waiting for BSC to confirm…");
        const ok = await waitReceipt(w.provider, hash);
        return mount(area, h("p", { class: `notice${ok ? "" : " error"}` }, ok ? `FILLED · ` : `FAILED · `, h("a", { href: `https://bscscan.com/tx/${hash}`, target: "_blank", rel: "noopener" }, `${hash.slice(0, 18)}… on BscScan ↗`)));
      }
      if (view.typedData) {
        const signature = await signTypedData(w.provider, w.user, view.typedData);
        say("submitted · waiting for the fill…");
        await api.submit(e.hash, signature);
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const s = await api.execution(e.hash);
          if (s.status && s.status !== "PENDING") return say(`${s.status} · order ${s.submittedOrderId ?? ""}`, s.status !== "FILLED");
        }
        return say("still pending - check again in a minute.");
      }
      say("Nothing to sign for this execution.", true);
    } catch (err) {
      say((err as Error).message, true);
    }
  });
  mount(area, summary, h("div", { class: "ticket-actions" }, btn));
}

async function reviewAndSign(t: Ticket, area: HTMLElement): Promise<void> {
  const say = (text: string, error = false) => mount(area, h("p", { class: `notice${error ? " error" : ""}` }, text));
  if (!findWallet()) return mount(area, noWalletHelp());
  say("connecting your wallet…");
  const w = await connectOrExplain(area);
  if (!w) return;
  const run = async (): Promise<void> => {
    try {
      say("getting a fresh quote and checking it against the ticket…");
      const view = await api.review(t.hash, w.user);
      await carryOut(view, w, area, run);
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) return say("Live execution is switched off on this server. The decision ticket above is still valid, verifiable proof.");
      if (err instanceof ApiError && err.status === 409 && /only ALLOW/.test(err.message)) return say("This decision is too old to sign or is not ALLOW. Check the order again first.", true);
      say((err as Error).message, true);
    }
  };
  await run();
}
