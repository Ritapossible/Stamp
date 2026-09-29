import "../common";
import { api, ApiError, type StandingOrder } from "../api";
import { $, h, mount } from "../dom";
import { carryOut, connectOrExplain, fact } from "../ticket";

// --- standing order ---
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
        fact("last check", lastEvent ? `${new Date(lastEvent.at).toUTCString().slice(5, 22)} UTC · ${lastEvent.note}` : "-"),
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
      parts.push(h("div", { class: "ticket-actions" }, act("recheck", "recheck now"), active.state === "READY" ? act("review", "review →", true) : null, act("cancel", "cancel")));
      if (active.state === "AWAITING_SIGNATURE" && active.executionHash) {
        const area = h("div", null);
        const go = h("button", { class: "btn small", type: "button" }, "finish in Binance Wallet →");
        go.addEventListener("click", async () => {
          const w = await connectOrExplain(area);
          if (!w) return;
          if (w.user.toLowerCase() !== active.user.toLowerCase()) return mount(area, h("p", { class: "notice error" }, `Connect the wallet that owns this order (${active.user.slice(0, 8)}…).`));
          try {
            const view = await api.execution(active.executionHash!);
            await carryOut(view, w, area, async () => {
              await api.standingAction(active.id, "review");
              void loadStanding();
            }, async (txHash) => {
              await api.standingSent(active.id, txHash);
            });
          } catch (err) {
            mount(area, h("p", { class: "notice error" }, (err as Error).message));
          }
        });
        parts.push(h("div", { class: "ticket-actions" }, go), area);
      }
    }
  }
  if (!active) {
    const field = h("input", { class: "order-input", value: "Buy $20 of NVIDIA", maxlength: 200, "aria-label": "Standing order" }) as HTMLInputElement;
    const start = h("button", { class: "btn", type: "button" }, "connect Binance Wallet & park it →");
    const note = h("div", null);
    start.addEventListener("click", async () => {
      const w = await connectOrExplain(note);
      if (!w) return;
      try {
        await api.createStanding(field.value.trim(), w.user);
        void loadStanding();
      } catch (err) {
        mount(note, h("p", { class: "notice error" }, (err as Error).message));
      }
    });
    parts.push(h("div", { class: "order-form" }, field, start), note);
    if (!shown) parts.unshift(h("p", { class: "placeholder" }, "No standing order yet. Park one: it is re-checked every ten minutes and waits for your signature when the verdict is ALLOW."));
  }
  mount(body, ...parts);
}

void loadStanding();
