/**
 * The human's own wallet: Binance Wallet only. Other injected wallets (MetaMask, Rabby, ...)
 * are never picked, even when they sit on window.ethereum. Stamp never holds a key: the
 * wallet signs or sends, and Stamp only checks what it is asked to sign.
 *
 * Binance Wallet detection, per https://developers.binance.com/docs/binance-w3w/evm-compatible-provider
 *  - inside the Binance app's dApp browser: window.binancew3w.ethereum (or window.ethereum.isBinance)
 *  - EIP-6963 announcement with rdns "wallet.binance.com" / "com.binance.wallet" (extension)
 */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  isBinance?: boolean;
}

/**
 * Fired on window when the connected wallet changes account or network after a review
 * (Binance's provider docs: listen to accountsChanged and chainChanged). Any reviewed
 * transaction is then stale and has to be reviewed again.
 */
export const WALLET_CHANGED = "stamp:wallet-changed";
const watched = new WeakSet<object>();

function watch(p: Eip1193): void {
  if (watched.has(p) || typeof p.on !== "function") return;
  watched.add(p);
  p.on("accountsChanged", () => window.dispatchEvent(new CustomEvent(WALLET_CHANGED, { detail: "account" })));
  p.on("chainChanged", () => window.dispatchEvent(new CustomEvent(WALLET_CHANGED, { detail: "network" })));
}

/**
 * Right before anything is sent or signed: the wallet must still be on BSC and on the account
 * the execution ticket was checked for. A switch after review would otherwise send a checked
 * transaction from a different account or to a different chain.
 */
async function assertStillReviewed(p: Eip1193, user: string): Promise<void> {
  const accounts = (await p.request({ method: "eth_accounts" })) as string[];
  if (!accounts?.[0] || accounts[0].toLowerCase() !== user.toLowerCase()) {
    throw new Error(`Your wallet is now on a different account than the one reviewed (${user.slice(0, 8)}…). Switch back, or check the order again.`);
  }
  const chainId = String(await p.request({ method: "eth_chainId" })).toLowerCase();
  if (chainId !== "0x38") throw new Error("Your wallet left BNB Smart Chain after the review. Switch back to BSC (chain 56) to continue.");
}

interface Announced {
  info: { name: string; rdns: string; icon?: string };
  provider: Eip1193;
}

const BINANCE_RDNS = new Set(["wallet.binance.com", "com.binance.wallet"]);
const announced: Announced[] = [];

window.addEventListener("eip6963:announceProvider", (e) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (d?.provider && d?.info && !announced.some((a) => a.info.rdns === d.info.rdns)) announced.push(d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

type Found = { provider: Eip1193; name: string; binance: boolean };

export function findWallet(): Found | null {
  const w = window as unknown as { binancew3w?: { ethereum?: Eip1193 }; ethereum?: Eip1193 };
  if (w.binancew3w?.ethereum) return { provider: w.binancew3w.ethereum, name: "Binance Wallet", binance: true };
  const bin = announced.find((a) => BINANCE_RDNS.has(a.info.rdns));
  if (bin) return { provider: bin.provider, name: bin.info.name || "Binance Wallet", binance: true };
  if (w.ethereum?.isBinance) return { provider: w.ethereum, name: "Binance Wallet", binance: true };
  // Anything else (MetaMask, Rabby, ...) is not Binance Wallet: Stamp shows how to get it instead.
  return null;
}

/**
 * Link that reopens this page inside the Binance app's Web3 Wallet browser on BSC.
 * Same construction as getDeepLink() in @binance/w3w-utils 1.1.8 (reimplemented to avoid the dependency).
 */
export function binanceAppLink(url = location.href, chainId = 56): { bnc: string; http: string } {
  const startPagePath = btoa("/pages/browser/index");
  const startPageQuery = btoa(`url=${url}&defaultChainId=${chainId}`);
  const bnc = `bnc://app.binance.com/mp/app?appId=yFK5FCqYprrXDiVFbhyRx7&startPagePath=${startPagePath}&startPageQuery=${startPageQuery}`;
  return { bnc, http: `https://app.binance.com/en/download?_dp=${btoa(bnc)}` };
}

export async function connect(): Promise<{ user: string; provider: Eip1193; name: string }> {
  // Ask again in case the extension loaded after this page did.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const found = findWallet();
  if (!found) throw new Error("NO_WALLET");
  const accounts = (await found.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet returned no account.");
  const chainId = (await found.provider.request({ method: "eth_chainId" })) as string;
  if (String(chainId).toLowerCase() !== "0x38") {
    try {
      await found.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] });
    } catch {
      throw new Error("Switch the wallet to BNB Smart Chain (chain 56) to continue.");
    }
  }
  watch(found.provider);
  return { user: accounts[0], provider: found.provider, name: found.name };
}

/** RFQ mode: sign exactly the typed data the execution ticket was checked against. */
export async function signTypedData(p: Eip1193, user: string, typedData: unknown): Promise<string> {
  await assertStillReviewed(p, user);
  return (await p.request({ method: "eth_signTypedData_v4", params: [user, JSON.stringify(typedData)] })) as string;
}

/** SWAP mode and approvals: the wallet sends exactly the checked transaction. Returns the tx hash. */
export async function sendTx(p: Eip1193, tx: { from?: string | null; to: string; value?: string; data: string }, user: string): Promise<string> {
  await assertStillReviewed(p, user);
  const value = BigInt(tx.value ?? "0");
  return (await p.request({
    method: "eth_sendTransaction",
    params: [{ from: user, to: tx.to, data: tx.data, value: `0x${value.toString(16)}` }],
  })) as string;
}

/** Wait until the wallet's node reports the transaction mined; true on success. */
export async function waitReceipt(p: Eip1193, txHash: string, timeoutMs = 120_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = (await p.request({ method: "eth_getTransactionReceipt", params: [txHash] }).catch(() => null)) as { status?: string } | null;
    if (r?.status) return r.status === "0x1";
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error("Timed out waiting for the transaction. Check it in your wallet.");
}
