import { type DecideInput, decide, type DecisionTicket, parseIntent, ticketHash } from "@stamp/engine";
import type { MarketInputs, SnapshotStore } from "@stamp/sources";
import { Hono } from "hono";
import { replayAll } from "./replay.js";
import { effectivePolicy, TicketRequest, VerifyRequest } from "./schema.js";
import { type TicketStore, TicketTamperedError } from "./tickets.js";
import type { Policy } from "@stamp/engine";
import type { Context } from "hono";
import { ExecError, type ExecRecord, type ExecutionService } from "./execution.js";
import type { StandingService } from "./standing.js";
import { z } from "zod";

export interface MarketSource {
  forIntent(intent: string, policy: Policy): Promise<MarketInputs>;
}

export interface AppDeps {
  market: MarketSource;
  store: TicketStore;
  snapshots: () => SnapshotStore;
  fixturesDir: string;
  /** requests per minute per client; 0 disables */
  rateLimitPerMin?: number;
  /** null when no wallet is configured: execution routes answer 501 instead of pretending */
  execution?: ExecutionService | null;
  standing?: StandingService | null;
  /** live figures for the web page (universe counts); omitted in tests that do not need it */
  summary?: () => Promise<unknown>;
}

const NO_WALLET =
  "execution unavailable: no wallet configured (set STAMP_TRADING_API_KEY and STAMP_TRADING_API_SECRET, or STAMP_FAKE_WALLET=1 for a labelled demo)";

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const ExecutionRequest = z.object({ decisionHash: z.string().regex(/^[0-9a-f]{64}$/), user: Address }).strict();
const SubmitRequest = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(1000) }).strict();
const StandingRequest = z.object({ intent: z.string().min(1).max(200), policy: z.record(z.string(), z.unknown()).optional(), user: Address }).strict();

/** What the browser needs to show the ticket and hand the exact typed data to the wallet. */
function execView(rec: ExecRecord) {
  const allow = rec.ticket.verdict === "ALLOW";
  return {
    ticket: rec.ticket,
    // Only what the wallet may act on: the checked payload on ALLOW, the approval when that is the blocker.
    typedData: allow ? rec.typedData : null,
    tx: allow && rec.ticket.executionMode === "SWAP" ? rec.tx : null,
    approvalTx: rec.ticket.reasons.includes("APPROVAL_REQUIRED") ? rec.approvalTx : null,
    submittedOrderId: rec.submittedOrderId,
    txHash: rec.txHash,
    status: rec.status,
    settledAt: rec.settledAt,
  };
}

async function guarded(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ExecError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const limit = deps.rateLimitPerMin ?? 60;
  const buckets = new Map<string, { tokens: number; at: number }>();

  app.use("/v1/*", async (c, next) => {
    if (limit > 0) {
      const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
      const now = Date.now();
      const b = buckets.get(key) ?? { tokens: limit, at: now };
      b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60_000) * limit);
      b.at = now;
      if (b.tokens < 1) return c.json({ error: "rate limited" }, 429);
      b.tokens -= 1;
      buckets.set(key, b);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, tickets: deps.store.size, wallet: deps.execution?.walletName ?? null }));

  app.get("/v1/summary", async (c) => {
    if (!deps.summary) return c.json({ error: "summary unavailable" }, 501);
    try {
      return c.json(await deps.summary());
    } catch (err) {
      return c.json({ error: "Binance data unavailable", detail: String(err) }, 503);
    }
  });

  app.post("/v1/tickets", async (c) => {
    const body = TicketRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
    const { policy, errors } = effectivePolicy(body.data.policy);
    if (errors.length > 0) return c.json({ error: "bad policy", issues: errors }, 400);

    let market: MarketInputs;
    try {
      market = await deps.market.forIntent(body.data.intent, policy);
    } catch (err) {
      return c.json({ error: "Binance data unavailable", detail: String(err) }, 503);
    }
    const chosenTicker = market.views.length > 0 ? market.universe.find((r) => r.contractAddress.toLowerCase() === market.views[0]!.contractAddress)?.ticker : undefined;
    const input: DecideInput = {
      ...market,
      intent: body.data.intent,
      policy,
      lastOfficialClose: chosenTicker ? deps.snapshots().lastOfficialClose(chosenTicker, market.asOf) : null,
      filledTodayUsd: "0",
    };
    const ticket = decide(input);
    // Store trimmed inputs only if they still reproduce the exact ticket.
    const small = slim(input, ticket);
    await deps.store.put({ ticket, input: decide(small).hash === ticket.hash ? small : input });
    return c.json({ ticket, verify: `/v1/tickets/${ticket.hash}` });
  });

  // Reads an order with the engine's own grammar and nothing else: no Binance call, nothing
  // stored. The paid agent route calls it before any payment, so an order Stamp can't read is
  // refused for free instead of charged.
  app.post("/v1/intent", async (c) => {
    const body = z.object({ intent: z.string().max(200) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
    const parsed = parseIntent(body.data.intent);
    return c.json(parsed.ok ? { ok: true, intent: parsed.intent } : { ok: false, problem: parsed.problem });
  });

  app.get("/v1/tickets/:hash", (c) => {
    try {
      const rec = deps.store.get(c.req.param("hash"));
      return rec ? c.json(rec) : c.json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof TicketTamperedError) return c.json({ error: err.message }, 500);
      throw err;
    }
  });

  app.post("/v1/verify", async (c) => {
    const body = VerifyRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
    let recomputed: DecisionTicket;
    try {
      recomputed = decide(body.data.input as unknown as DecideInput);
    } catch (err) {
      return c.json({ error: "input rejected by the engine", detail: String(err) }, 400);
    }
    const given = body.data.ticket as unknown as DecisionTicket | undefined;
    return c.json({
      hash: recomputed.hash,
      verdict: recomputed.verdict,
      reasons: recomputed.reasons,
      matches: given ? given.hash === recomputed.hash && ticketHash(given as unknown as Record<string, unknown>) === given.hash : null,
      ticket: recomputed,
    });
  });

  // Replay recomputes every recorded ticket; the fixtures only change on deploy, so cache a minute.
  let replayCache: { at: number; body: unknown } | null = null;
  app.get("/v1/replay", async (c) => {
    if (!replayCache || Date.now() - replayCache.at > 60_000) {
      const rows = await replayAll(deps.fixturesDir);
      replayCache = { at: Date.now(), body: { ok: rows.every((r) => r.ok), count: rows.length, drifted: rows.filter((r) => !r.ok).length, rows } };
    }
    return c.json(replayCache.body);
  });

  // - execution: Review → sign in your own wallet → submit → fill -
  app.post("/v1/execution", (c) =>
    guarded(c, async () => {
      if (!deps.execution) return c.json({ error: NO_WALLET }, 501);
      const body = ExecutionRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
      const rec = await deps.execution.review(body.data.decisionHash, body.data.user);
      return c.json({ wallet: deps.execution.walletName, ...execView(rec) });
    }),
  );

  app.post("/v1/execution/:hash/submit", (c) =>
    guarded(c, async () => {
      if (!deps.execution) return c.json({ error: NO_WALLET }, 501);
      const body = SubmitRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
      return c.json(execView(await deps.execution.submit(c.req.param("hash"), body.data.signature)));
    }),
  );

  app.post("/v1/execution/:hash/sent", (c) =>
    guarded(c, async () => {
      if (!deps.execution) return c.json({ error: NO_WALLET }, 501);
      const body = z.object({ txHash: z.string() }).strict().safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
      return c.json(execView(await deps.execution.sent(c.req.param("hash"), body.data.txHash)));
    }),
  );

  /** Binance's raw responses behind an execution ticket (quote, swap, approve). No secrets. */
  app.get("/v1/execution/:hash/raw", (c) => {
    if (!deps.execution) return c.json({ error: NO_WALLET }, 501);
    const rec = deps.execution.get(c.req.param("hash"));
    return rec ? c.json({ ticket: rec.ticket, raw: rec.raw }) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/execution/:hash", (c) =>
    guarded(c, async () => {
      if (!deps.execution) return c.json({ error: NO_WALLET }, 501);
      return c.json(execView(await deps.execution.refresh(c.req.param("hash"))));
    }),
  );

  // - the one standing order -
  app.get("/v1/standing", (c) => (deps.standing ? c.json({ orders: deps.standing.list(), filledTodayUsd: deps.standing.filledTodayUsd() }) : c.json({ error: "standing orders disabled" }, 501)));

  app.post("/v1/standing", (c) =>
    guarded(c, async () => {
      if (!deps.standing) return c.json({ error: "standing orders disabled" }, 501);
      const body = StandingRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
      const patch = TicketRequest.shape.policy.safeParse(body.data.policy);
      if (!patch.success) return c.json({ error: "bad request", issues: patch.error.issues }, 400);
      const { policy, errors } = effectivePolicy(patch.data);
      if (errors.length > 0) return c.json({ error: "bad policy", issues: errors }, 400);
      return c.json(await deps.standing.create(body.data.intent, policy, body.data.user));
    }),
  );

  for (const action of ["recheck", "review", "cancel"] as const) {
    app.post(`/v1/standing/:id/${action}`, (c) =>
      guarded(c, async () => {
        if (!deps.standing) return c.json({ error: "standing orders disabled" }, 501);
        return c.json(await deps.standing[action](c.req.param("id")));
      }),
    );
  }

  app.post("/v1/standing/:id/sent", (c) =>
    guarded(c, async () => {
      if (!deps.standing) return c.json({ error: "standing orders disabled" }, 501);
      const body = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
      return c.json(await deps.standing.sent(c.req.param("id"), body.data.txHash));
    }),
  );

  app.post("/v1/standing/:id/submit", (c) =>
    guarded(c, async () => {
      if (!deps.standing) return c.json({ error: "standing orders disabled" }, 501);
      const body = SubmitRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad request", issues: body.error.issues }, 400);
      return c.json(await deps.standing.submit(c.req.param("id"), body.data.signature));
    }),
  );

  return app;
}

/**
 * Keeps only what the decision could depend on: the chosen instrument and its siblings
 * (views and BSC universe rows), plus any row whose symbol or ticker equals the query.
 * The caller checks the trimmed input still reproduces the same hash before storing it.
 */
function slim(input: DecideInput, ticket: DecisionTicket): DecideInput {
  const keep = new Set(ticket.rejected.map((r) => r.contractAddress));
  if (ticket.chosen) keep.add(ticket.chosen.contractAddress);
  const q = "query" in ticket.intent ? ticket.intent.query.toUpperCase() : null;
  const universe = input.universe.filter(
    (r) => r.chainId === "56" && (keep.has(r.contractAddress.toLowerCase()) || (q !== null && (r.symbol.toUpperCase() === q || r.ticker.toUpperCase() === q))),
  );
  const views = input.views.filter((v) => keep.has(v.contractAddress.toLowerCase()));
  return { ...input, universe, views };
}
