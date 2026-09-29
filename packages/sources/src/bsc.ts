/**
 * Minimal BSC JSON-RPC over a public node: read an ERC-20 allowance, and build the exact
 * approve() calldata. No key, no signing: the human's wallet sends any approval itself.
 */
export const BSC_RPC = "https://bsc-dataseed.bnbchain.org";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const pad32 = (hexNo0x: string) => hexNo0x.padStart(64, "0");

export function approveCalldata(spender: string, amountRaw: string): string {
  if (!ADDRESS.test(spender) || !/^\d+$/.test(amountRaw)) throw new Error("bad approve arguments");
  return `0x095ea7b3${pad32(spender.slice(2).toLowerCase())}${pad32(BigInt(amountRaw).toString(16))}`;
}

export async function erc20Allowance(token: string, owner: string, spender: string, opts: { rpc?: string; fetchFn?: typeof fetch } = {}): Promise<bigint> {
  if (![token, owner, spender].every((a) => ADDRESS.test(a))) throw new Error("bad address");
  const data = `0xdd62ed3e${pad32(owner.slice(2).toLowerCase())}${pad32(spender.slice(2).toLowerCase())}`;
  const res = await (opts.fetchFn ?? fetch)(opts.rpc ?? BSC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (typeof json.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(json.result)) throw new Error(`allowance call failed: ${json.error?.message ?? "no result"}`);
  return json.result === "0x" ? 0n : BigInt(json.result);
}
