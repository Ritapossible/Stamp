import "../common";
import { api, ApiError } from "../api";
import { $, h, mount } from "../dom";
import { ISSUER_NAME, renderTicket } from "../ticket";

const EXAMPLES = ["Buy 1 NFLX", "Buy $20 of NVIDIA", "Buy $20 of NVDAB", "Buy 1 share of Netflix", "Buy $20 of Micron", "Buy 1 KLAC"];

const input = $("order-input") as HTMLInputElement;
const issuerSelect = $("issuer-select") as HTMLSelectElement;
const result = $("result");

/** The policy in one sentence, always the one the next check will use. */
function paintPolicy(): void {
  const issuer = ISSUER_NAME[issuerSelect.value];
  const first = issuer
    ? [h("b", null, `${issuer} only.`), ` Other issuers' tokens for the same stock are shown, never bought.`]
    : [h("b", null, "Name the issuer in the order"), ` (NVDAon, NVDAx or NVDAB) - Stamp never picks one for you.`];
  mount(
    $("policy-line"),
    ...first,
    ` Never guess what "1" means. Park if the market is shut and the price is more than 0.80% above the last close. `,
    h("b", null, "$20 an order, $50 a day."),
  );
}
issuerSelect.addEventListener("change", paintPolicy);
paintPolicy();

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
  history.replaceState(null, "", `?q=${encodeURIComponent(intent)}${issuer === "ondo" ? "" : `&issuer=${issuerSelect.value}`}`);
  mount(result, h("p", { class: "placeholder" }, h("span", { class: "spinner" }), "reading Binance and running the checks…"));
  try {
    const { ticket } = await api.ticket(intent, issuer);
    mount(result, renderTicket(ticket));
  } catch (err) {
    mount(result, h("p", { class: "notice error" }, err instanceof ApiError && err.status === 503 ? "Binance data is unreachable right now. No ticket was made - Stamp never guesses." : `Could not check: ${String((err as Error).message)}`));
  } finally {
    btn.disabled = false;
  }
}

// /check/?q=Buy%201%20NFLX&issuer=xstock runs straight away (the home page links here).
const params = new URLSearchParams(location.search);
const q = params.get("q");
const iss = params.get("issuer");
if (iss && [...issuerSelect.options].some((o) => o.value === iss)) {
  issuerSelect.value = iss;
  paintPolicy();
}
if (q) {
  input.value = q.slice(0, 200);
  void check();
}
