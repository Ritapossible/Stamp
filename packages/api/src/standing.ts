import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decide, Dec, type DecideInput, type Policy, validatePolicy } from "@stamp/engine";
import type { SnapshotStore } from "@stamp/sources";
import type { MarketSource } from "./app.js";
import { ExecError, type ExecutionService } from "./execution.js";
import type { TicketStore } from "./tickets.js";

/**
 * Standing orders: one intent, one policy, rechecked every 10 minutes. Each wallet has at most
 * one active order and its own daily cap; the server holds at most MAX_ACTIVE active orders.
 *
 *   PARKED ──recheck ALLOW──► READY ──review (fresh decision + execution ALLOW)──► AWAITING_SIGNATURE
 *     ▲  ◄──recheck WARN/BLOCK── READY                                                │ sign + submit
 *     └──── execution BLOCK / quote expired / fill FAILED ◄──── SUBMITTED ◄───────────┘
 *                                                                 └──fill──► FILLED (terminal)
 *
 * The worker never signs. Daily spend is summed from FILLED orders, never from memory.
 */
export type StandingState = "PARKED" | "READY" | "AWAITING_SIGNATURE" | "SUBMITTED" | "FILLED" | "CANCELLED";

export interface StandingEvent {
  at: string;
  state: StandingState;
  note: string;
  ticketHash: string | null;
}

export interface StandingOrder {
  id: string;
  intent: string;
  policy: Policy;
  user: string;
  createdAt: string;
  state: StandingState;
  lastDecisionHash: string | null;
  executionHash: string | null;
  expiresAt: string | null;
  filledUsd: string | null;
  filledAt: string | null;
  events: StandingEvent[];
}

const ACTIVE: StandingState[] = ["PARKED", "READY", "AWAITING_SIGNATURE", "SUBMITTED"];
/** Every active order is re-decided each tick against live Binance data, so the total is capped. */
export const MAX_ACTIVE = 25;

export class StandingService {
  private readonly orders = new Map<string, StandingOrder>();
  private seq = 0;

  private constructor(
    private readonly deps: {
      market: MarketSource;
      store: TicketStore;
      snapshots: () => SnapshotStore;
      execution: ExecutionService | null;
      now: () => string;
      path: string | null;
    },
  ) {}

  static async open(deps: Omit<StandingService["deps"], "now"> & { now?: () => string }): Promise<StandingService> {
    const svc = new StandingService({ ...deps, now: deps.now ?? (() => new Date().toISOString()) });
    if (deps.path) {
      try {
        for (const line of (await readFile(deps.path, "utf8")).split("\n")) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line) as StandingOrder;
            svc.orders.set(o.id, o); // last snapshot of each order wins
            svc.seq = Math.max(svc.seq, Number(o.id.replace(/\D/g, "")) || 0);
          } catch {
            // torn last line
          }
        }
      } catch {
        await mkdir(dirname(deps.path), { recursive: true });
      }
    }
    return svc;
  }

  /** All orders, or one wallet's orders when `user` is given. */
  list(user?: string): StandingOrder[] {
    const all = [...this.orders.values()];
    return user ? all.filter((o) => o.user === user.toLowerCase()) : all;
  }

  get(id: string): StandingOrder | null {
    return this.orders.get(id) ?? null;
  }

  /** USD filled today (UTC day): one wallet's when `user` is given, else across all orders. */
  filledTodayUsd(now = this.deps.now(), user?: string): string {
    const day = now.slice(0, 10);
    return this.list(user)
      .filter((o) => o.state === "FILLED" && o.filledAt?.slice(0, 10) === day && o.filledUsd)
      .reduce((sum, o) => sum.plus(new Dec(o.filledUsd!)), new Dec(0))
      .toFixed(2);
  }

  async create(intent: string, policy: Policy, user: string): Promise<StandingOrder> {
    const errors = validatePolicy(policy);
    if (errors.length) throw new ExecError(`bad policy: ${errors.join("; ")}`, 400);
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new ExecError("user must be a 0x address", 400);
    if (this.list(user).some((o) => ACTIVE.includes(o.state))) throw new ExecError("this wallet already has an active standing order; cancel it first", 409);
    if (this.list().filter((o) => ACTIVE.includes(o.state)).length >= MAX_ACTIVE) throw new ExecError("this demo server is holding the most standing orders it rechecks; try again later", 503);
    const now = this.deps.now();
    const order: StandingOrder = {
      id: `so-${++this.seq}`,
      intent,
      policy,
      user: user.toLowerCase(),
      createdAt: now,
      state: "PARKED",
      lastDecisionHash: null,
      executionHash: null,
      expiresAt: null,
      filledUsd: null,
      filledAt: null,
      events: [],
    };
    await this.transition(order, "PARKED", "created", null);
    await this.recheck(order.id);
    return this.orders.get(order.id)!;
  }

  async cancel(id: string): Promise<StandingOrder> {
    const o = this.require(id);
    if (!ACTIVE.includes(o.state) || o.state === "SUBMITTED") throw new ExecError(`cannot cancel in ${o.state}`, 409);
    await this.transition(o, "CANCELLED", "cancelled by user", null);
    return o;
  }

  /** Decide from live data now; READY on ALLOW, otherwise PARKED. */
  async recheck(id: string): Promise<StandingOrder> {
    const o = this.require(id);
    if (o.state !== "PARKED" && o.state !== "READY") return o;
    const hash = await this.decideNow(o);
    const t = this.deps.store.get(hash)!.ticket;
    await this.transition(o, t.verdict === "ALLOW" ? "READY" : "PARKED", `${t.verdict} ${t.reasons.join(",")}`, hash);
    return o;
  }

  /** Human pressed Review: re-decide (the last decision may be 10 min old), then quote. */
  async review(id: string): Promise<StandingOrder> {
    const o = this.require(id);
    // AWAITING_SIGNATURE is allowed so a fresh review can follow a USDT approval.
    if (o.state !== "READY" && o.state !== "AWAITING_SIGNATURE") throw new ExecError(`order is ${o.state}, not READY`, 409);
    if (!this.deps.execution) throw new ExecError("execution unavailable: no wallet configured", 409);
    const hash = await this.decideNow(o);
    const t = this.deps.store.get(hash)!.ticket;
    if (t.verdict !== "ALLOW") {
      await this.transition(o, "PARKED", `review: ${t.verdict} ${t.reasons.join(",")}`, hash);
      return o;
    }
    const rec = await this.deps.execution.review(hash, o.user);
    if (rec.ticket.reasons.includes("APPROVAL_REQUIRED")) {
      o.executionHash = rec.ticket.hash;
      o.expiresAt = null;
      await this.transition(o, "AWAITING_SIGNATURE", "approve USDT in the wallet, then review again", rec.ticket.hash);
      return o;
    }
    if (rec.ticket.verdict !== "ALLOW") {
      await this.transition(o, "PARKED", `execution BLOCK ${rec.ticket.reasons.join(",")}`, rec.ticket.hash);
      return o;
    }
    o.executionHash = rec.ticket.hash;
    o.expiresAt = new Date(Date.parse(rec.quote.quotedAt) + o.policy.quoteTtlSec * 1000).toISOString();
    await this.transition(o, "AWAITING_SIGNATURE", "execution ALLOW; waiting for the human to sign", rec.ticket.hash);
    return o;
  }

  async submit(id: string, signature: string): Promise<StandingOrder> {
    const o = this.require(id);
    if (o.state !== "AWAITING_SIGNATURE" || !o.executionHash || !this.deps.execution) throw new ExecError(`order is ${o.state}`, 409);
    if (o.expiresAt && Date.parse(this.deps.now()) > Date.parse(o.expiresAt)) {
      await this.transition(o, "PARKED", "quote expired before signature", o.executionHash);
      throw new ExecError("quote expired; the order is parked again", 409);
    }
    const rec = await this.deps.execution.submit(o.executionHash, signature);
    await this.transition(o, "SUBMITTED", `submitted ${rec.submittedOrderId}`, o.executionHash);
    return o;
  }

  /** SWAP: the human's wallet sent the checked transaction. */
  async sent(id: string, txHash: string): Promise<StandingOrder> {
    const o = this.require(id);
    if (o.state !== "AWAITING_SIGNATURE" || !o.executionHash || !this.deps.execution) throw new ExecError(`order is ${o.state}`, 409);
    await this.deps.execution.sent(o.executionHash, txHash);
    await this.transition(o, "SUBMITTED", `sent ${txHash}`, o.executionHash);
    return o;
  }

  /** The 10-minute worker step. */
  async tick(): Promise<void> {
    const now = Date.parse(this.deps.now());
    for (const o of this.list()) {
      try {
        if (o.state === "AWAITING_SIGNATURE" && o.expiresAt && now > Date.parse(o.expiresAt)) {
          await this.transition(o, "PARKED", "quote expired before signature", o.executionHash);
        } else if (o.state === "SUBMITTED" && o.executionHash && this.deps.execution) {
          const rec = await this.deps.execution.refresh(o.executionHash);
          if (rec.status === "FILLED") {
            o.filledUsd = rec.ticket.amountInUsd;
            o.filledAt = rec.settledAt;
            await this.transition(o, "FILLED", `filled ${rec.submittedOrderId}`, o.executionHash);
          } else if (rec.status === "FAILED") {
            await this.transition(o, "PARKED", `fill failed ${rec.submittedOrderId}`, o.executionHash);
          }
        } else if (o.state === "PARKED" || o.state === "READY") {
          await this.recheck(o.id);
        }
      } catch (err) {
        o.events.push({ at: this.deps.now(), state: o.state, note: `tick error: ${String(err)}`, ticketHash: null });
      }
    }
  }

  private async decideNow(o: StandingOrder): Promise<string> {
    const market = await this.deps.market.forIntent(o.intent, o.policy);
    const ticker = market.views.length > 0 ? market.universe.find((r) => r.contractAddress.toLowerCase() === market.views[0]!.contractAddress)?.ticker : undefined;
    const input: DecideInput = {
      ...market,
      intent: o.intent,
      policy: o.policy,
      lastOfficialClose: ticker ? this.deps.snapshots().lastOfficialClose(ticker, market.asOf) : null,
      filledTodayUsd: this.filledTodayUsd(market.asOf, o.user),
    };
    const ticket = decide(input);
    await this.deps.store.put({ ticket, input });
    o.lastDecisionHash = ticket.hash;
    return ticket.hash;
  }

  private require(id: string): StandingOrder {
    const o = this.orders.get(id);
    if (!o) throw new ExecError("standing order not found", 404);
    return o;
  }

  /**
   * The order must belong to the wallet the caller names. This is not authentication (anyone
   * can name an address); it stops one visitor acting on another's order by id. Funds are
   * never at stake here: only the owner's wallet can sign.
   */
  assertOwner(id: string, user: string): void {
    if (this.require(id).user !== user.toLowerCase()) throw new ExecError("this standing order belongs to another wallet", 403);
  }

  private async transition(o: StandingOrder, state: StandingState, note: string, ticketHash: string | null): Promise<void> {
    o.state = state;
    if (state === "PARKED" || state === "READY") {
      o.executionHash = state === "READY" ? o.executionHash : null;
      o.expiresAt = null;
    }
    o.events.push({ at: this.deps.now(), state, note, ticketHash });
    this.orders.set(o.id, o);
    if (this.deps.path) await appendFile(this.deps.path, `${JSON.stringify(o)}\n`);
  }
}
