/**
 * A thin wrapper over the Binance Agentic Wallet CLI (`baw`, npm `@binance/agentic-wallet`).
 * Stamp never holds the wallet's session: `baw` keeps it on the person's machine after they
 * sign in with the Binance App (`baw auth signin`). Every call passes arguments as an array
 * (no shell) and appends `--json`; a `success: false` answer is thrown with the CLI's own
 * error name and message, never reworded.
 */
import { execFile } from "node:child_process";
import type { AgenticQuoteView } from "@stamp/engine";

export type BawRunner = (args: string[]) => Promise<unknown>;

export class AgenticWalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgenticWalletError";
  }
}

/** Runs the real CLI. `bin` defaults to `baw` on PATH. */
export function bawRunner(bin = process.env.BAW_BIN ?? "baw", timeoutMs = 60_000): BawRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...args, "--json"], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => {
        const text = String(stdout ?? "").trim();
        if (text) {
          try {
            return resolve(JSON.parse(text));
          } catch {
            // fall through: not JSON
          }
        }
        reject(new AgenticWalletError("CLI_ERROR", err ? String(err.message) : `baw printed no JSON: ${text.slice(0, 200)}`));
      });
    });
}

export interface AgenticOrder {
  orderId: string;
  status: "PENDING" | "FINISHED" | "FAILED";
  txHash: string | null;
  toToken: string | null;
}

export class AgenticWallet {
  constructor(
    private readonly run: BawRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async data<T>(args: string[]): Promise<T> {
    const out = (await this.run(args)) as { success?: boolean; data?: T; error?: { name?: string; code?: unknown; message?: string } };
    if (!out || out.success !== true) {
      throw new AgenticWalletError(String(out?.error?.name ?? out?.error?.code ?? "UNKNOWN"), String(out?.error?.message ?? "baw returned success: false"));
    }
    return out.data as T;
  }

  async connected(): Promise<boolean> {
    return (await this.data<{ status: string }>(["wallet", "status"])).status === "CONNECTED";
  }

  async bscAddress(): Promise<string> {
    const d = await this.data<{ addresses: Array<{ binanceChainId: string; address: string }> }>(["wallet", "address"]);
    const a = d.addresses.find((x) => x.binanceChainId === "56")?.address;
    if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new AgenticWalletError("NO_BSC_ADDRESS", "the Agentic Wallet reported no BSC address");
    return a.toLowerCase();
  }

  private orderArgs(o: { usd: string; fromToken: string; toToken: string; slippagePct: string }): string[] {
    return ["--fromTokenQty", o.usd, "--fromToken", o.fromToken, "--toToken", o.toToken, "--binanceChainId", "56", "--slippage", o.slippagePct];
  }

  async quote(o: { usd: string; fromToken: string; toToken: string; slippagePct: string }): Promise<AgenticQuoteView> {
    const quotedAt = this.now().toISOString();
    const d = await this.data<{ fromCoinSymbol: string; fromCoinAmount: string; toCoinSymbol: string; toCoinAmount: string }>(["market-order", "quote", ...this.orderArgs(o)]);
    return { quotedAt, fromCoinSymbol: String(d.fromCoinSymbol), fromCoinAmount: String(d.fromCoinAmount), toCoinSymbol: String(d.toCoinSymbol), toCoinAmount: String(d.toCoinAmount) };
  }

  /** Submits the swap. An orderId is not a fill; poll `order()` to a terminal state. */
  async swap(o: { usd: string; fromToken: string; toToken: string; slippagePct: string }): Promise<string> {
    const d = await this.data<{ orderId: string }>(["market-order", "swap", ...this.orderArgs(o), "--mev", "true"]);
    return String(d.orderId);
  }

  async order(orderId: string): Promise<AgenticOrder> {
    const d = await this.data<{ list: Array<{ orderId: string; status: string; txHash: string | null; toToken?: string }> }>(["market-order", "list", "--orderId", orderId]);
    const o = d.list.find((x) => String(x.orderId) === orderId);
    if (!o) throw new AgenticWalletError("ORDER_NOT_FOUND", `order ${orderId} not in market-order list`);
    const status = o.status === "FINISHED" || o.status === "FAILED" ? o.status : "PENDING";
    return { orderId, status, txHash: o.txHash ?? null, toToken: o.toToken ? o.toToken.toLowerCase() : null };
  }
}
