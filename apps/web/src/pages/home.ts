import "../common";
import { api, type Summary } from "../api";
import { $, h, mount, trimNum } from "../dom";

function stat(value: string, label: string, href: string): HTMLElement {
  return h("a", { class: "stat", href, ...(href.startsWith("/v1") ? { target: "_blank", rel: "noopener" } : {}) }, h("b", null, value), h("span", null, label));
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
    items.push(stat(String(s.instruments), "tokenized stocks listed on BSC", "/v1/summary"));
  }
  if (replay.status === "fulfilled") {
    items.push(stat(String(replay.value.count), "tickets recomputed", "/proof/"));
    items.push(stat(String(replay.value.drifted), "hashes drifted", "/proof/"));
  }
  if (items.length) mount($("stats"), ...items);
  $("live-dot").classList.toggle("down", !live);
  $("live-text").textContent = live ? "live · Binance public RWA API" : "Binance data unreachable right now - the recorded figures below still hold";
}

void loadStats();
