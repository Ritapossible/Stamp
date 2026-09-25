import { DEFAULT_POLICY, type Policy, validatePolicy } from "@stamp/engine";
import { z } from "zod";

const decimal = z.string().regex(/^\d+(\.\d+)?$/, "decimal string");

/** Callers may override policy fields; the result is always re-validated by the engine's rules. */
const PolicyPatch = z
  .object({
    issuer: z.enum(["ondo", "xstock", "bstock"]).nullable(),
    noiseBandBps: z.number().int().min(0),
    maxRegularPremiumBps: z.number().int().min(0),
    maxClosedPremiumBps: z.number().int().min(0),
    implausibleAbsBps: z.number().int().min(0),
    maxSlippageBps: z.number().int().min(0),
    quoteTtlSec: z.number().int().min(1).max(30),
    maxOrderUsd: decimal,
    maxDayUsd: decimal,
  })
  .partial()
  .strict();

export const TicketRequest = z
  .object({
    intent: z.string().min(1).max(200),
    policy: PolicyPatch.optional(),
  })
  .strict();

export type TicketRequest = z.infer<typeof TicketRequest>;

export function effectivePolicy(patch: z.infer<typeof PolicyPatch> | undefined): { policy: Policy; errors: string[] } {
  const policy = { ...DEFAULT_POLICY, ...(patch ?? {}) } as Policy;
  return { policy, errors: validatePolicy(policy) };
}

/** Loose shape check for /v1/verify: the engine itself rejects anything malformed. */
export const VerifyRequest = z.object({
  input: z
    .object({
      intent: z.string().max(200),
      policy: z.record(z.string(), z.unknown()),
      asOf: z.string(),
      universe: z.array(z.record(z.string(), z.unknown())).max(5000),
      views: z.array(z.record(z.string(), z.unknown())).max(100),
      venue: z.record(z.string(), z.unknown()).nullable(),
      lastOfficialClose: z.record(z.string(), z.unknown()).nullable(),
      filledTodayUsd: z.string(),
    })
    .passthrough(),
  ticket: z.record(z.string(), z.unknown()).optional(),
});
