/**
 * CeloTasker — Zod validation schemas (Stage 1A)
 *
 * Basic request-shape validation for future API route handlers.
 * Extend these schemas — do not bypass them.
 */
import { z } from "zod";

/** Hex-encoded EVM address. */
const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address");

/** Hex-encoded transaction hash. */
const txHash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash");

/** Positive integer weight for rubric criteria. */
const weight = z.number().int().min(1).max(100);

// ─── Task creation ───────────────────────────────────────────

export const RubricCriteriaInputSchema = z.object({
  description: z.string().min(1).max(500),
  weight,
  order: z.number().int().min(0).default(0),
});

export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  /** Reward in token smallest units, as decimal string (avoid float issues). */
  rewardAmount: z.string().regex(/^\d+$/, "Must be a decimal integer string"),
  rewardToken: evmAddress,
  creator: evmAddress,
  assignee: evmAddress.optional(),
  deadline: z.coerce.date().optional(),
  criteria: z.array(RubricCriteriaInputSchema).min(1).max(20),
});

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

// ─── Submission ──────────────────────────────────────────────

export const CreateSubmissionRequestSchema = z.object({
  taskId: z.string().min(1),
  submitter: evmAddress,
  /** URI or content hash of the submitted work. */
  contentRef: z.string().min(1).max(2048),
});

export type CreateSubmissionRequest = z.infer<
  typeof CreateSubmissionRequestSchema
>;

// ─── Settlement ──────────────────────────────────────────────

/**
 * Settlement request (Stage 4.2 hardening). ONLY the submission id is
 * accepted from the client. Recipient, amount, reward token and task id are
 * all derived server-side from the trusted Submission/Task records; a body
 * address, amount or token can never override them.
 */
export const CreateSettlementRequestSchema = z.object({
  submissionId: z.string().min(1),
});

export type CreateSettlementRequest = z.infer<
  typeof CreateSettlementRequestSchema
>;

export { evmAddress, txHash };
