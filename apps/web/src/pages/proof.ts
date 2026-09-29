import "../common";
import { api, type ReplayRow } from "../api";
import { $, h, mount } from "../dom";
import { renderTicket } from "../ticket";

// --- replay ---
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
  $("replay-title-bar").textContent = `stamp - replay · ${count} recomputed · ${drifted} drifted`;
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
          h("td", null, r.symbol ?? "-"),
          h("td", null, h("span", { class: `v ${r.verdict}` }, r.verdict)),
          h("td", null, r.reasons.join(", ")),
          h("td", { class: "num" }, r.premiumBps === null ? "" : `${r.premiumBps} bps`),
          h("td", { class: "hash" }, `${r.ok ? "✓ " : "✗ "}${r.hash.slice(0, 12)}`),
        ),
      );
    mount(table, h("table", null, h("thead", null, h("tr", null, ...["order", "token", "verdict", "reason", "premium", "hash"].map((c) => h("th", { scope: "col", class: c === "premium" ? "num" : null }, c)))), h("tbody", null, ...body)));
  };
  mount(tabs, ...sets.map((s) => h("button", { class: "tab", type: "button", role: "tab", "data-set": s, onclick: () => show(s) }, describeSet(s).label)));
  const wanted = new URLSearchParams(location.search).get("set");
  const first = sets.find((s) => s === wanted) ?? sets[0];
  if (first) show(first);
}


api
  .replay()
  .then((r) => renderReplay(r.rows, r.count, r.drifted))
  .catch((err) => mount($("replay-table"), h("p", { class: "notice error" }, `Replay unavailable: ${String((err as Error).message)}`)));

// --- verify one ticket by hash: fetch its stored inputs, recompute, compare ---
const form = $("verify-form");
const out = $("verify-result");
const field = $("verify-input") as HTMLInputElement;

async function verify(hash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return mount(out, h("p", { class: "notice error" }, "A ticket hash is 64 lowercase hex characters."));
  mount(out, h("p", { class: "placeholder" }, h("span", { class: "spinner" }), "fetching the stored inputs and recomputing…"));
  try {
    const stored = await api.stored(hash);
    const v = await api.verify(stored.input, stored.ticket);
    mount(
      out,
      h("p", { class: `notice${v.matches ? "" : " error"}` }, v.matches ? `MATCH · recomputed ${v.hash.slice(0, 16)}… from the recorded inputs - same verdict (${v.verdict}), same hash.` : `NO MATCH · recomputed ${v.hash.slice(0, 16)}…, stored ${hash.slice(0, 16)}….`),
      renderTicket(stored.ticket),
    );
  } catch (err) {
    const e = err as Error & { status?: number };
    mount(out, h("p", { class: "notice error" }, e.status === 404 ? "This server has no ticket with that hash. It may come from another server, or from before a restart of this free host. Anyone holding the ticket and its inputs can still verify it with POST /v1/verify." : e.message));
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  history.replaceState(null, "", `?hash=${field.value.trim()}`);
  void verify(field.value.trim());
});
const given = new URLSearchParams(location.search).get("hash");
if (given) {
  field.value = given;
  void verify(given);
}
