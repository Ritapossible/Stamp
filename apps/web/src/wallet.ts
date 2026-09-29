/** The human's own wallet (MetaMask, Rabby, Binance Wallet…). Stamp never holds a key. */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function provider(): Eip1193 | null {
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

export function hasWallet(): boolean {
  return provider() !== null;
}

export async function connect(): Promise<string> {
  const p = provider();
  if (!p) throw new Error("No browser wallet found. Install MetaMask or open this page in a wallet browser to sign.");
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet returned no account.");
  const chainId = (await p.request({ method: "eth_chainId" })) as string;
  if (chainId !== "0x38") {
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] });
    } catch {
      throw new Error("Switch the wallet to BNB Smart Chain (chain 56) to sign.");
    }
  }
  return accounts[0];
}

/** Signs exactly the typed data the execution ticket was checked against. */
export async function signTypedData(user: string, typedData: unknown): Promise<string> {
  const p = provider();
  if (!p) throw new Error("No browser wallet found.");
  return (await p.request({ method: "eth_signTypedData_v4", params: [user, JSON.stringify(typedData)] })) as string;
}
