/**
 * Tiny element builder. Text always goes in through textContent, never innerHTML, so an
 * order typed into the page (it is echoed in the narration) cannot inject markup.
 */
type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

export function h(tag: string, attrs: Attrs | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

export function mount(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : String(c))));
}

/** "0.08835968" → "0.08835968", "20.00000000" → "20" (display only; the ticket keeps full strings). */
export function trimNum(s: string | null | undefined): string {
  if (!s) return "-";
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

/** Display rounding only (the ticket and its hash keep Binance's full strings). */
export function roundNum(s: string | null | undefined, dp: number): string {
  if (!s) return "-";
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return trimNum(n.toFixed(dp));
}
