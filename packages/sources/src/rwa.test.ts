import { describe, expect, it } from "vitest";
import { RWA_HEADERS, RwaClient, type CallRecord } from "./rwa.js";

type Reply = { status?: number; body?: unknown; throws?: Error; notJson?: boolean };

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; headers: unknown }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers });
    const r = replies.shift();
    if (!r) throw new Error("no more replies");
    if (r.throws) throw r.throws;
    return {
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      json: async () => {
        if (r.notJson) throw new SyntaxError("bad json");
        return r.body;
      },
    } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const ok = (data: unknown) => ({ body: { code: "000000", success: true, data, message: null } });

describe("RwaClient", () => {
  it("sends the skill headers and returns data", async () => {
    const f = fakeFetch([ok([{ symbol: "NVDAon" }])]);
    const res = await new RwaClient({ fetchFn: f.fn, retryDelayMs: 0 }).list();
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.data).toEqual([{ symbol: "NVDAon" }]);
    expect(f.calls[0]!.headers).toEqual(RWA_HEADERS);
    expect(f.calls[0]!.url).toMatch(/\/v1\/.*\/stock\/detail\/list\/ai$/);
  });

  it("retries once on data: null and succeeds", async () => {
    const f = fakeFetch([ok(null), ok({ symbol: "NVDAx" })]);
    const res = await new RwaClient({ fetchFn: f.fn, retryDelayMs: 0 }).dynamic("0xabc");
    expect(res).toMatchObject({ ok: true, attempts: 2, error: null });
    expect(f.calls[0]!.url).toContain("/v2/");
    expect(f.calls[0]!.url).toContain("chainId=56&contractAddress=0xabc");
  });

  it("gives up after two data: null replies and never invents data", async () => {
    const f = fakeFetch([ok(null), ok(null)]);
    const res = await new RwaClient({ fetchFn: f.fn, retryDelayMs: 0 }).dynamic("0xabc");
    expect(res).toMatchObject({ ok: false, data: null, attempts: 2, error: "data: null" });
    expect(res.body?.success).toBe(true);
  });

  it.each([
    [{ status: 451, body: { code: "0", success: false, data: null, message: "restricted" } }, "HTTP 451"],
    [{ body: { code: "100001", success: false, data: null, message: "x" } }, "success=false code=100001"],
    [{ notJson: true }, "response is not JSON"],
    [{ throws: new TypeError("fetch failed") }, "TypeError: fetch failed"],
  ])("reports failure %#", async (reply, error) => {
    const f = fakeFetch([reply, reply]);
    const res = await new RwaClient({ fetchFn: f.fn, retryDelayMs: 0 }).venueStatus();
    expect(res).toMatchObject({ ok: false, error, attempts: 2 });
  });

  it("reports every call with latency for the DEVEX log", async () => {
    const records: CallRecord[] = [];
    let t = 0;
    const f = fakeFetch([ok({ a: 1 })]);
    const client = new RwaClient({ fetchFn: f.fn, retryDelayMs: 0, onCall: (c) => records.push(c), now: () => (t += 120) });
    await client.meta("0xabc");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: true, latencyMs: 120, attempts: 1, httpStatus: 200 });
  });
});
