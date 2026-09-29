import { readFileSync } from "node:fs";
import { Dec, type DecisionTicket } from "@stamp/engine";
import { AgenticWallet, type BscReceipt } from "@stamp/sources";
import { describe, expect, it } from "vitest";
import { type AgenticDeps, NotSignedInError, runAgenticBuy } from "./agentic.js";

const golden = (name: string): DecisionTicket => JSON.parse(readFileSync(new URL(`../fixtures/golden/${name}.json`, import.meta.url), "utf8")).ticket;
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const USER = "0x1111111111111111111111111111111111111111";
const POOL = "0x9999999999999999999999999999999999999999";
const TX = `0x${"cd".repeat(32)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const raw = (d: Dec) => `0x${BigInt(d.mul(new Dec(10).pow(18)).floor().toFixed(0)).toString(16)}`;

/** A scripted `baw`: records every call and answers like the CLI's --json output. */
function fakeBaw(over: { connected?: boolean; quoteSymbol?: string; orderStatus?: string } = {}) {
  const calls: string[][] = [];
  const decision = golden("nvda-usd-ondo");
  const tokens = new Dec(20).div(new Dec(decision.tokenPriceUsd!).mul("1.0005"));
  const run = async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (key === "wallet status") return { success: true, data: { status: over.connected === false ? "UNCONNECTED" : "CONNECTED" } };
    if (key === "wallet address") return { success: true, data: { addresses: [{ binanceChainId: "CT_501", address: "So1" }, { binanceChainId: "56", address: USER }] } };
    if (key === "market-order quote") return { success: true, data: { fromCoinSymbol: "USDT", fromCoinAmount: "20", toCoinSymbol: over.quoteSymbol ?? "NVDAon", toCoinAmount: tokens.toFixed(18), slippage: 0.005 } };
    if (key === "market-order swap") return { success: true, data: { orderId: "777" } };
    if (key === "market-order list") return { success: true, data: { list: [{ orderId: "777", status: over.orderStatus ?? "FINISHED", txHash: TX }] } };
    return { success: false, error: { name: "UNKNOWN_COMMAND", message: key } };
  };
  const receipt: BscReceipt = {
    status: "success",
    logs: [
      { address: USDT, topics: [TRANSFER, pad(USER), pad(POOL)], data: raw(new Dec(20)) },
      { address: decision.chosen!.contractAddress, topics: [TRANSFER, pad(POOL), pad(USER)], data: raw(tokens) },
    ],
  };
  return { calls, run, receipt, decision };
}

function deps(f: ReturnType<typeof fakeBaw>, ticket: DecisionTicket, confirm = true): AgenticDeps {
  return {
    wallet: new AgenticWallet(f.run, () => new Date(Date.parse(ticket.asOf) + 20_000)),
    fetchTicket: async () => ticket,
    receipt: async () => f.receipt,
    decimals: async () => 18,
    confirm: async () => confirm,
    now: () => new Date(Date.parse(ticket.asOf) + 30_000),
    sleep: async () => {},
    log: () => {},
  };
}

describe("runAgenticBuy: Stamp in front of the Agentic Wallet", () => {
  it("never calls baw when the decision is not ALLOW", async () => {
    const f = fakeBaw();
    const run = await runAgenticBuy("Buy 1 NFLX", {}, deps(f, golden("nflx-bare-one")));
    expect(run.stoppedAt).toBe("decision");
    expect(f.calls).toEqual([]);
  });

  it("decides, quotes, checks, swaps with the policy's slippage, and verifies the fill", async () => {
    const f = fakeBaw();
    const run = await runAgenticBuy("Buy $20 of NVIDIA", {}, deps(f, f.decision));
    expect(run.execution?.verdict).toBe("ALLOW");
    expect(run.fill?.verified).toBe(true);
    const swap = f.calls.find((c) => c[1] === "swap")!;
    expect(swap).toEqual(expect.arrayContaining(["--toToken", f.decision.chosen!.contractAddress, "--fromTokenQty", "20.00", "--slippage", "0.5", "--binanceChainId", "56"]));
  });

  it("does not swap when the quote names another issuer's token", async () => {
    const f = fakeBaw({ quoteSymbol: "NVDAB" });
    const run = await runAgenticBuy("Buy $20 of NVIDIA", {}, deps(f, f.decision));
    expect(run.execution?.reasons).toEqual(["ISSUER_MISMATCH"]);
    expect(f.calls.some((c) => c[1] === "swap")).toBe(false);
  });

  it("does not swap on --dry-run or without a yes", async () => {
    for (const [opts, confirm, stop] of [[{ dryRun: true }, true, "dry-run"], [{}, false, "declined"]] as const) {
      const f = fakeBaw();
      const run = await runAgenticBuy("Buy $20 of NVIDIA", opts, deps(f, f.decision, confirm));
      expect(run.stoppedAt).toBe(stop);
      expect(f.calls.some((c) => c[1] === "swap")).toBe(false);
    }
  });

  it("reports a failed order as not filled, and asks for sign-in when unconnected", async () => {
    const f = fakeBaw({ orderStatus: "FAILED" });
    const run = await runAgenticBuy("Buy $20 of NVIDIA", {}, deps(f, f.decision));
    expect(run.fill?.reasons).toEqual(["FILL_FAILED"]);
    const g = fakeBaw({ connected: false });
    await expect(runAgenticBuy("Buy $20 of NVIDIA", {}, deps(g, g.decision))).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("passes the CLI's own error through unchanged", async () => {
    const w = new AgenticWallet(async () => ({ success: false, error: { code: 10003000, name: "NOT_LOGGED_IN", message: "Not logged in" } }));
    await expect(w.connected()).rejects.toMatchObject({ code: "NOT_LOGGED_IN", message: "Not logged in" });
  });
});
