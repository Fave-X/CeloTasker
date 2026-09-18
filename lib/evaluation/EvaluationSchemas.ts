/**
 * CeloTasker — Strict Zod schema for AI evaluation output (Stage 5B).
 *
 * Model output is UNTRUSTED. Anything that does not parse against this
 * schema is rejected outright (`malformed_model_output`); there is never an
 * implicit APPROVE and never a "best effort" partial parse.
 */
import { z } from "zod";

/** Per-criterion result the model must return for each rubric criterion. */
export const CriterionResultSchema = z.object({
  criterionId: z.string().min(1).max(64),
  satisfied: z.boolean(),
  /** Optional 0–100 score (advisory only — never authoritative). */
  score: z.number().min(0).max(100).optional(),
  /** Concise reasoning per criterion. */
  reasoning: z.string().min(1).max(2000),
});

/** Overall structured evaluation the model must return. */
export const ModelEvaluationSchema = z.object({
  decision: z.enum(["APPROVE", "REQUEST_REVISION", "REJECT"]),
  criterionResults: z.array(CriterionResultSchema).min(1).max(20),
  overallFeedback: z.string().min(1).max(4000),
  /** Optional structured data the model extracted (advisory only). */
  extractedData: z.record(z.string(), z.unknown()).optional(),
});

export type ModelEvaluation = z.infer<typeof ModelEvaluationSchema>;
export type ModelDecision = ModelEvaluation["decision"];
export type CriterionResult = z.infer<typeof CriterionResultSchema>;