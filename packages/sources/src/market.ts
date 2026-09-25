import { parseIntent, type Policy, resolve } from "@stamp/engine";
import { toMarketView, toVenueStatus } from "./adapters.js";
import { buildUniverse, type Universe } from "./classify.js";
import type { MarketInputs } from "./capture.js";
import type { RwaClient } from "./rwa.js";

export interface LiveMarketOptions {
  /** How long the universe list is reused. It changes rarely; multipliers are re-read per call anyway. */
  listTtlMs?: number;
  nowIso?: () => string;
}

/**
 * Fetches what one decision needs: the universe (cached), the venue status, and the dynamic
 * payload of every same-ticker instrument (the chosen one plus siblings for the reference).
 */
export class LiveMarket {
  private cached: { at: number; universe: Universe } | null = null;
  private readonly listTtlMs: number;
  private readonly nowIso: () => string;

  constructor(
    private readonly client: RwaClient,
    opts: LiveMarketOptions = {},
  ) {
    this.listTtlMs = opts.listTtlMs ?? 5 * 60_000;
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
  }

  async universe(): Promise<Universe> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.listTtlMs) return this.cached.universe;
    const res = await this.client.list();
    if (!res.ok || !Array.isArray(res.data)) throw new Error(`RWA list unavailable: ${res.error}`);
    const universe = buildUniverse(res.data);
    this.cached = { at: now, universe };
    return universe;
  }

  async forIntent(intent: string, policy: Policy): Promise<MarketInputs> {
    const { rows } = await this.universe();
    const parsed = parseIntent(intent);
    const family = parsed.ok ? resolve(parsed.intent.query, rows, policy).family : [];
    const byAddress = new Map(rows.filter((r) => r.chainId === "56").map((r) => [r.contractAddress.toLowerCase(), r]));

    const [venue, ...dynamics] = await Promise.all([
      this.client.venueStatus(),
      ...family.map((i) => this.client.dynamic(i.contractAddress).then((d) => ({ i, d, at: this.nowIso() }))),
    ]);
    const views = dynamics.map(({ i, d, at }) => toMarketView(byAddress.get(i.contractAddress)!, d.ok ? d.data : null, at));
    return { asOf: this.nowIso(), universe: rows, views, venue: venue.ok ? toVenueStatus(venue.data) : null };
  }
}
