import { Dec, type QuoteView, type SimulationResult } from "@stamp/engine";

/** BSC USDT (18 decimals). The only asset v1 pays with. */
export const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";

export interface QuoteRequest {
  toToken: string;
  fromToken: string;
  amountInRaw: string;
  user: string;
}

export interface PreparedOrder {
  mode: "RFQ" | "SWAP";
  /** RFQ: the EIP-712 payload the user signs, exactly as returned. */
  typedData: unknown | null;
  /** SWAP: the unsigned transaction. */
  tx: unknown | null;
  /** RFQ: rfq.orderId, passed back on submit as `quoteId`. */
  orderId: string | null;
  /** Present when the USDT allowance is short. */
  approvalTx: unknown | null;
}

export type OrderStatus = "PENDING" | "FILLED" | "FAILED";

/**
 * The boundary between Stamp and anything that can move money. Implementations never sign:
 * the human's wallet signs the typed data, and `submit` only forwards that signature.
 */
export interface StockWallet {
  readonly name: string;
  quote(req: QuoteRequest): Promise<QuoteView>;
  prepare(quote: QuoteView, user: string, slippageBps: number): Promise<PreparedOrder>;
  simulate(tx: unknown, user: string): Promise<SimulationResult>;
  submit(i: { quote: QuoteView; orderId: string; signature: string }): Promise<{ orderId: string }>;
  status(orderId: string): Promise<OrderStatus>;
}

/**
 * FAKE wallet for tests and key-less demos. It quotes at a fixed per-token price, returns
 * typed data in a plausible RFQ shape, and "fills" on submit. Tickets made with it say
 * `vendor: "fake"`, and nothing it returns ever reaches a chain.
 */
export class FakeWallet implements StockWallet {
  readonly name = "fake";
  private seq = 0;
  private readonly filled = new Set<string>();

  constructor(
    private readonly priceUsd: (token: string) => string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly slipBps = 5,
  ) {}

  async quote(req: QuoteRequest): Promise<QuoteView> {
    const price = new Dec(this.priceUsd(req.toToken)).mul(new Dec(1).plus(new Dec(this.slipBps).div(10000)));
    const out = new Dec(req.amountInRaw).div(price).floor();
    return {
      quoteId: `fake-q-${++this.seq}`,
      quotedAt: this.now(),
      executionMode: "RFQ",
      vendor: "fake",
      fromToken: req.fromToken.toLowerCase(),
      toToken: req.toToken.toLowerCase(),
      amountInRaw: req.amountInRaw,
      amountOutRaw: out.toFixed(0),
      fromDecimals: 18,
      toDecimals: 18,
    };
  }

  async prepare(quote: QuoteView, user: string): Promise<PreparedOrder> {
    return {
      mode: "RFQ",
      typedData: {
        domain: { name: "FakeRFQ", version: "1", chainId: 56, verifyingContract: "0x000000000000000000000000000000000000fa4e" },
        primaryType: "Order",
        types: { Order: [{ name: "maker", type: "address" }] },
        message: {
          maker: "0x000000000000000000000000000000000000fa4e",
          taker: user.toLowerCase(),
          makerAsset: quote.toToken,
          takerAsset: quote.fromToken,
          makerAmount: quote.amountOutRaw,
          takerAmount: quote.amountInRaw,
          quoteId: quote.quoteId,
        },
      },
      tx: null,
      orderId: `fake-o-${quote.quoteId}`,
      approvalTx: null,
    };
  }

  async simulate(): Promise<SimulationResult> {
    return { ok: true, error: null };
  }

  async submit(i: { quote: QuoteView; orderId: string; signature: string }): Promise<{ orderId: string }> {
    this.filled.add(i.orderId);
    return { orderId: i.orderId };
  }

  async status(orderId: string): Promise<OrderStatus> {
    return this.filled.has(orderId) ? "FILLED" : "PENDING";
  }
}
