/**
 * CeloTasker — Evaluator provider interface (Stage 5B).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * Everything a provider returns is UNTRUSTED, ADVISORY output. Providers:
 * - never mutate authoritative state (they cannot — they only return data);
 * - are behind this small interface so the model/provider can be swapped
 *   (Gemini etc.) without touching the deterministic review layer;
 * - must NOT fetch the submission contentRef — it is passed as an OPAQUE
 *   reference only. The deterministic layer never fetches evidence URLs.
 *
 * The evaluation INPUT is built exclusively from trusted server-side data
 * (task title/description/rubric and the current validated submission).
 * It deliberately contains no addresses, rewards or tokens.
 */
import { createGeminiEvaluatorProvider } from "./GeminiEvaluator.ts";

/** Trusted, server-built input handed to a provider. */
export interface EvaluationInput {
  taskId: string;
  submissionId: string;
  taskTitle: string;
  taskDescription: string;
  criteria: Array<{
    id: string;
    description: string;
    weight: number;
    order: number;
  }>;
  /**
   * Opaque content reference (e.g. "ipfs://…"). Providers must treat it as
   * an identifier, NOT as something to fetch — no arbitrary URL fetching.
   */
  contentRef: string;
}

/**
 * An AI evaluator provider. `evaluate` returns RAW, UNTRUSTED output which
 * the deterministic review layer parses with a strict Zod schema before a
 * recommendation is even considered. Malformed output is rejected — there
 * is never an implicit APPROVE.
 */
export interface EvaluatorProvider {
  /** Stable provider identifier for the audit trail (never a secret). */
  readonly providerId: string;
  /** Stable model identifier for the audit trail (never a secret). */
  readonly modelId: string;
  /** Produce a raw (untrusted) evaluation for the given trusted input. */
  evaluate(input: EvaluationInput): Promise<unknown>;
}

/**
 * Deterministic static provider: always returns the configured raw payload.
 * Used by tests and deterministic local setups. The production provider
 * (Gemini, Stage 6) implements the same interface in `./GeminiEvaluator.ts`.
 */
export class StaticEvaluatorProvider implements EvaluatorProvider {
  readonly providerId: string;
  readonly modelId: string;
  private readonly raw: unknown;

  constructor(providerId: string, modelId: string, raw: unknown) {
    this.providerId = providerId;
    this.modelId = modelId;
    this.raw = raw;
  }

  async evaluate(): Promise<unknown> {
    return this.raw;
  }
}

/**
 * Resolve the configured production evaluator (Stage 6 / M-3).
 *
 * Returns the server-side Gemini provider when `GEMINI_API_KEY` is configured.
 * When it is absent — or when the configuration cannot be resolved — this
 * returns null so that review fails SAFE with `evaluation_unavailable` (503)
 * and no state is mutated. There is never an implicit fallback evaluation.
 *
 * The provider is advisory only: everything it returns is still parsed by the
 * strict ModelEvaluationSchema, resolved by the deterministic decision layer,
 * and gated behind explicit human confirmation before any payment.
 */
export function resolveEvaluatorProvider(): EvaluatorProvider | null {
  try {
    return createGeminiEvaluatorProvider();
  } catch {
    // Any configuration/runtime problem fails SAFE: no provider, no implicit
    // evaluation, and the review layer returns `evaluation_unavailable` (503).
    return null;
  }
}