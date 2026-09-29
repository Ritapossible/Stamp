/** Loaded by every page: fonts, styles, theme toggle, menu, and the footer's server status. */
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/latin-800.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "./styles.css";
import { api } from "./api";
import { $ } from "./dom";

// --- theme ---
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

// --- menu (small screens; wide screens show the nav inline) ---
const menu = $("menu");
const menuBtn = $("menu-toggle");
function setMenu(open: boolean): void {
  menu.dataset.open = String(open);
  menuBtn.textContent = open ? "[close]" : "[menu]";
  menuBtn.setAttribute("aria-expanded", String(open));
  document.body.style.overflow = open ? "hidden" : "";
}
menuBtn.addEventListener("click", () => setMenu(menu.dataset.open !== "true"));
menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenu(false);
});

// --- footer status: is this server up, and can it execute? ---
const WALLET_WORDS: Record<string, string> = {
  "binance-trading-api": "execution via Binance Trading API",
  fake: "execution: labelled fake wallet (demo)",
};

void api
  .health()
  .then((h) => {
    $("foot-status").textContent = `server up · ${h.wallet ? (WALLET_WORDS[h.wallet] ?? h.wallet) : "decisions only, execution off"}`;
  })
  .catch(() => {
    $("foot-dot").classList.add("down");
    $("foot-status").textContent = "server unreachable - the page still works offline for docs";
  });

/** Adds a copy button to every <pre data-copy> on the page (docs, agents). */
export function copyButtons(): void {
  document.querySelectorAll<HTMLElement>("pre[data-copy]").forEach((pre) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip copy";
    btn.textContent = "copy";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "");
        btn.textContent = "copied";
      } catch {
        btn.textContent = "select & copy";
      }
      setTimeout(() => (btn.textContent = "copy"), 1600);
    });
    pre.append(btn);
  });
}
