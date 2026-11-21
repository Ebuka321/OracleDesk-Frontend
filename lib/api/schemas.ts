import { z } from "zod";

/** Decimal-string raw amount. JSON numbers are rejected: precision may already be lost. */
export const rawAmount = z.string().regex(/^\d{1,39}$/, "expected a decimal-string raw amount");

/** Decimal-string u64 id (at most 2^64 - 1). */
export const u64Id = z
  .string()
  .regex(/^\d{1,20}$/, "expected a decimal-string u64 id")
  .refine((value) => BigInt(value) < 1n << 64n, "u64 id out of range");

const strkey = z.string().regex(/^[GC][A-Z2-7]{55}$/, "expected a Stellar address");

export const AuthChallengeSchema = z.object({
  transaction: z.string().min(1),
  networkPassphrase: z.string().min(1),
  expiresAt: z.string(),
});

export const CopyTradePayloadSchema = z.object({
  contractId: strkey,
  onChainMarketId: u64Id,
  outcome: z.enum(["Yes", "No"]),
  collateralInRaw: rawAmount,
  userWallet: strkey,
  traceReference: z.string().nullable().default(null),
});

export const CopyTradeInitSchema = z.object({
  copyTradeId: z.string().min(1),
  transactionPayload: CopyTradePayloadSchema,
  instructions: z.string(),
});

export const GuardianTxSchema = z.object({
  xdr: z.string().min(1),
  networkPassphrase: z.string().min(1),
  validUntil: z.string(),
  guardian: strkey,
  kind: z.enum(["cancel_proposal", "guardian_void_market"]),
  onChainMarketId: u64Id,
});

export const DisputeReviewSchema = z.object({
  id: z.string().min(1),
  onChainMarketId: u64Id,
  proposedOutcome: z.string().nullable(),
  verdict: z.enum(["PENDING", "AGREE", "DISAGREE", "INSUFFICIENT", "ERROR"]),
  independentOutcome: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  evidenceHash: z.string().nullable().optional(),
  windowEndsAt: z.union([z.string(), z.number()]).nullable().optional(),
  windowRemainingSecs: z.number().nullable().optional(),
  acknowledgedBy: z.string().nullable().optional(),
  acknowledgedAt: z.string().nullable().optional(),
  resolvedAs: z.enum(["FINALIZED", "CANCELLED"]).nullable().optional(),
});

export type GuardianTx = z.infer<typeof GuardianTxSchema>;
export type DisputeReview = z.infer<typeof DisputeReviewSchema>;
