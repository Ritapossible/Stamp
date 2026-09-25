import { Dec, type ExecutionTicket, prepareExecution, type QuoteView } from "@stamp/engine";
import { BSC_USDT, type OrderStatus, type StockWallet } from "@stamp/sources";
import type { TicketStore } from "./tickets.js";

/** One Review → sign → submit → fill cycle. The server never holds a key. */
export interface ExecRecord {
  ticket: ExecutionTicket;
  quote: QuoteView;
  /** RFQ payload handed to the human's wallet, exactly as the ticket's typedDataHash covers. */
  typedData: unknown | null;
  tx: unknown | null;
  orderId: string | null;
  user: string;
  submittedOrderId: string | null;
  status: OrderStatus | null;
  settledAt: string | null;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Binance quotes expire in about 30 s; a signature after that is refused before submitting. */
const SUBMIT_WINDOW_SEC = 30;

export class ExecutionService {
  private readonly records = new Map<string, ExecRecord>();

  constructor(
    private readonly deps: {
      wallet: StockWallet;
      store: TicketStore;
      now?: () => string;
      quoteAsset?: string;
    },
  ) {}

  get walletName(): string {
    return this.deps.wallet.name;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /** Quote against a stored ALLOW decision and produce the execution ticket. Never submits. */
  async review(decisionHash: string, user: string): Promise<ExecRecord> {
    if (!ADDRESS.test(user)) throw new ExecError("user must be a 0x address", 400);
    const stored = this.deps.store.get(decisionHash);
    if (!stored) throw new ExecError("decision not found", 404);
    const decision = stored.ticket;
    if (decision.verdict !== "ALLOW" || !decision.chosen || !decision.notionalUsd) {
      throw new ExecError(`decision is ${decision.verdict} (${decision.reasons.join(", ")}); only ALLOW can be signed`, 409);
    }
    const quoteAsset = this.deps.quoteAsset ?? BSC_USDT;
    const amountInRaw = new Dec(decision.notionalUsd).mul(new Dec(10).pow(18)).toFixed(0);

    let quote: QuoteView;
    let prepared;
    try {
      quote = await this.deps.wallet.quote({ fromToken: quoteAsset, toToken: decision.chosen.contractAddress, amountInRaw, user });
      prepared = await this.deps.wallet.prepare(quote, user, stored.input.policy.maxSlippageBps);
    } catch (err) {
      throw new ExecError(`wallet: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    const approvalSimulation = prepared.approvalTx ? await this.deps.wallet.simulate(prepared.approvalTx, user) : null;
    const swapSimulation = prepared.mode === "SWAP" && prepared.tx ? await this.deps.wallet.simulate(prepared.tx, user) : null;

    const ticket = prepareExecution({
      decision,
      policy: stored.input.policy,
      asOf: this.now(),
      user,
      quoteAsset,
      quote,
      typedData: prepared.typedData,
      swapSimulation,
      approvalSimulation,
    });
    const rec: ExecRecord = {
      ticket,
      quote,
      typedData: prepared.typedData,
      tx: prepared.tx,
      orderId: prepared.orderId,
      user: user.toLowerCase(),
      submittedOrderId: null,
      status: null,
      settledAt: null,
    };
    this.records.set(ticket.hash, rec);
    return rec;
  }

  get(hash: string): ExecRecord | null {
    return this.records.get(hash) ?? null;
  }

  /** Forward the human's signature. Refused unless the execution ticket is ALLOW and the quote is still live. */
  async submit(hash: string, signature: string): Promise<ExecRecord> {
    const rec = this.records.get(hash);
    if (!rec) throw new ExecError("execution not found", 404);
    if (rec.ticket.verdict !== "ALLOW") throw new ExecError(`execution is ${rec.ticket.verdict} (${rec.ticket.reasons.join(", ")})`, 409);
    if (rec.submittedOrderId) throw new ExecError("already submitted", 409);
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new ExecError("signature must be 0x hex", 400);
    const age = (Date.parse(this.now()) - Date.parse(rec.quote.quotedAt)) / 1000;
    if (age > SUBMIT_WINDOW_SEC) throw new ExecError(`quote is ${Math.floor(age)} s old; review again`, 409);
    if (!rec.orderId) throw new ExecError("no order id to submit (SWAP mode is signed and broadcast by the wallet)", 409);
    try {
      const { orderId } = await this.deps.wallet.submit({ quote: rec.quote, orderId: rec.orderId, signature });
      rec.submittedOrderId = orderId;
      rec.status = "PENDING";
    } catch (err) {
      throw new ExecError(`wallet: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    return rec;
  }

  async refresh(hash: string): Promise<ExecRecord> {
    const rec = this.records.get(hash);
    if (!rec) throw new ExecError("execution not found", 404);
    if (rec.submittedOrderId && rec.status === "PENDING") {
      rec.status = await this.deps.wallet.status(rec.submittedOrderId);
      if (rec.status !== "PENDING") rec.settledAt = this.now();
    }
    return rec;
  }
}
