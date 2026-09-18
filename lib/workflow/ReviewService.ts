/**
 * CeloTasker — Deterministic review-resolution layer (Stage 5B).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * The AI evaluation is UNTRUSTED and ADVISORY. This module is the
 * AUTHORIZE step: pure, deterministic code turns the model's recommendation
 * into the authoritative decision. An APPROVE recommendation never becomes
 * authoritative on its own — it must additionally satisfy the deterministic
 * approval policy (current PENDING submission, every rubric criterion
 * covered, every covered criterion satisfied, no unknown criteria).
 *
 * Authoritative outcomes (all applied via the existing state machine):
 * - APPROVED          → submission marked APPROVED; the task stays
 *                       UNDER_REVIEW so the hardened Stage 4.2 settlement
 *                       service remains the only UNDER_REVIEW → SETTLING path.
 * - REQUEST_REVISION  → delegated to the existing requestRevision workflow
 *                       (budget enforcement, superseding, audit).
 * - REJECTED          → guarded UNDER_REVIEW → REJECTED transition
 *                       (also used when the revision budget is exhausted).
 *
 * No blockchain execution, no private keys, no ERC-8021, no UI.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.ts";
import { recordTaskEvent } from "../audit/AuditLog.ts";
import { transitionTask, requestRevision } from "./TaskService.ts";
import { MAX_REVISION_ATTEMPTS, TIMEOUTS } from "../security/SecurityPolicy.ts";
import {
  resolveEvaluatorProvider,
  type EvaluatorProvider,
  type EvaluationInput,
} from "../evaluation/EvaluatorProvider.ts";
import {
  ModelEvaluationSchema,
  type ModelDecision,
  type ModelEvaluation,
} from "../evaluation/EvaluationSchemas.ts";

// ─── Pure deterministic resolution ─────────────────────────────

export type AuthoritativeDecision = "APPROVED" | "REQUEST_REVISION" | "REJECTED";

export interface PolicyCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string | null;
}

export interface DecisionResolution {
  /** What the SYSTEM decided — never merely what the model recommended. */
  decision: AuthoritativeDecision;
  /** Deterministic checks explaining why approval was or was not allowed. */
  policyChecks: PolicyCheck[];
  /** True when the deterministic policy overrode the model's recommendation. */
  downgraded: boolean;
  /** Stable machine reason for any override. */
  reason: string | null;
}

function policyCheck(
  id: string,
  label: string,
  passed: boolean,
  detail: string | null
): PolicyCheck {
  return { id, label, passed, detail };
}

/**
 * THE deterministic decision function. Pure: same input, same output.
 * The model's APPROVE is only honored when every deterministic approval
 * requirement holds; otherwise the outcome is downgraded (revision when the
 * budget allows, otherwise rejection).
 */
export function resolveAuthoritativeDecision(input: {
  modelDecision: ModelDecision;
  rubricCriteria: Array<{ id: string }>;
  criterionResults: Array<{ criterionId: string; satisfied: boolean }>;
  submissionStatus: string;
  revisionCount: number;
}): DecisionResolution {
  const rubricIds = new Set(input.rubricCriteria.map((c) => c.id));
  const knownResults = input.criterionResults.filter((r) =>
    rubricIds.has(r.criterionId)
  );
  const missingCriteria = [...rubricIds].filter(
    (id) => !knownResults.some((r) => r.criterionId === id)
  );
  const covered = rubricIds.size > 0 && missingCriteria.length === 0;
  const allSatisfied = covered && knownResults.every((r) => r.satisfied);
  const hasUnknownCriteria =
    input.criterionResults.length !== knownResults.length;
  const isPending = input.submissionStatus === "PENDING";
  const budgetRemaining = input.revisionCount < MAX_REVISION_ATTEMPTS;

  const policyChecks: PolicyCheck[] = [
    policyCheck(
      "submission_is_pending",
      "The current submission is PENDING (not previously approved/rejected)",
      isPending,
      isPending ? null : `submission_status:${input.submissionStatus}`
    ),
    policyCheck(
      "all_criteria_covered",
      "Every rubric criterion has a model result",
      covered,
      covered ? null : `missing:${missingCriteria.join(",")}`
    ),
    policyCheck(
      "all_criteria_satisfied",
      "Every rubric criterion result is satisfied",
      allSatisfied,
      allSatisfied
        ? null
        : knownResults.some((r) => !r.satisfied)
          ? "criterion_unsatisfied"
          : "not_covered"
    ),
    policyCheck(
      "no_unknown_criteria",
      "The model only reported criteria from the task rubric",
      !hasUnknownCriteria,
      hasUnknownCriteria ? "unknown_criteria_reported" : null
    ),
  ];

  if (input.modelDecision === "REJECT") {
    return { decision: "REJECTED", policyChecks, downgraded: false, reason: null };
  }

  if (input.modelDecision === "APPROVE") {
    // Deterministic approval requirements — the recommendation alone is
    // NEVER sufficient.
    const approvalAllowed =
      isPending && covered && allSatisfied && !hasUnknownCriteria;
    if (approvalAllowed) {
      return { decision: "APPROVED", policyChecks, downgraded: false, reason: null };
    }
    if (budgetRemaining) {
      return {
        decision: "REQUEST_REVISION",
        policyChecks,
        downgraded: true,
        reason: "approval_policy_denied",
      };
    }
    return {
      decision: "REJECTED",
      policyChecks,
      downgraded: true,
      reason: "revision_budget_exhausted",
    };
  }

  // REQUEST_REVISION recommendation.
  if (budgetRemaining) {
    return { decision: "REQUEST_REVISION", policyChecks, downgraded: false, reason: null };
  }
  return {
    decision: "REJECTED",
    policyChecks,
    downgraded: true,
    reason: "revision_budget_exhausted",
  };
}

// ─── Review orchestration (workflow integration) ──────────────

/** Sentinel: the submission/task changed concurrently — roll everything back. */
class ReviewConflictError extends Error {
  constructor() {
    super("Review state changed concurrently; rolled back");
    this.name = "ReviewConflictError";
  }
}

/** Sentinel: the evaluation provider exceeded its hard timeout. */
export class EvaluationTimeoutError extends Error {
  constructor() {
    super("AI evaluation provider timed out");
    this.name = "EvaluationTimeoutError";
  }
}

export type ReviewOutcome =
  | {
      ok: true;
      data: {
        recommendation: ModelDecision;
        decision:
          | AuthoritativeDecision
          | "PENDING_HUMAN_CONFIRMATION";
        downgraded: boolean;
        reason: string | null;
        submissionId: string;
        taskId: string;
        outcome:
          | "SUBMISSION_APPROVED"
          | "REVISION_REQUESTED"
          | "TASK_REJECTED"
          | "PENDING_HUMAN_CONFIRMATION";
        policyChecks: PolicyCheck[];
      };
    }
  | { ok: false; reason: string; status: number };

/** Truthful audit payload: records the recommendation AND the decision. */
function evaluationPayload(
  provider: EvaluatorProvider,
  evaluation: ModelEvaluation,
  resolution: DecisionResolution,
  submissionId: string,
  outcome: string
) {
  return JSON.stringify({
    providerId: provider.providerId,
    modelId: provider.modelId,
    recommendation: evaluation.decision,
    decision: resolution.decision,
    downgraded: resolution.downgraded,
    reason: resolution.reason,
    policyChecks: resolution.policyChecks,
    criterionResults: evaluation.criterionResults,
    overallFeedback: evaluation.overallFeedback,
    extractedData: evaluation.extractedData ?? null,
    submissionId,
    outcome,
  });
}

export async function reviewSubmission(
  taskId: string,
  actorAddress: string,
  provider: EvaluatorProvider | null = resolveEvaluatorProvider(),
  evaluationTimeoutMs: number = TIMEOUTS.EVALUATION_TIMEOUT_MS
): Promise<ReviewOutcome> {
  // Load the task (with its trusted rubric) server-side.
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { criteria: true },
  });
  if (!task) return { ok: false, reason: "not_found", status: 404 };

  // ACL: the existing creator-only review gate. The AI never authenticates.
  if (task.creator !== actorAddress) {
    return { ok: false, reason: "forbidden", status: 403 };
  }
  if (task.status !== "UNDER_REVIEW") {
    return { ok: false, reason: `task_not_under_review:${task.status}`, status: 409 };
  }

  // Only the current, non-superseded submission may ever be evaluated.
  const current = await prisma.submission.findFirst({
    where: { taskId, status: { not: "SUPERSEDED" } },
    orderBy: { createdAt: "desc" },
  });
  if (!current) {
    await recordTaskEvent({
      taskId,
      eventType: "EVALUATION_REJECTED",
      actor: actorAddress,
      metadata: { reason: "no_eligible_submission" },
    });
    return { ok: false, reason: "no_eligible_submission", status: 409 };
  }

  // Fail safe: with no configured provider there is NO evaluation and NO
  // state change — never an implicit approval.
  if (!provider) {
    await recordTaskEvent({
      taskId,
      eventType: "EVALUATION_REJECTED",
      actor: actorAddress,
      metadata: { reason: "evaluation_unavailable" },
    });
    return { ok: false, reason: "evaluation_unavailable", status: 503 };
  }

  // Trusted, minimal input — no addresses, rewards or tokens are disclosed.
  const input: EvaluationInput = {
    taskId,
    submissionId: current.id,
    taskTitle: task.title,
    taskDescription: task.description,
    criteria: task.criteria
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((c) => ({
        id: c.id,
        description: c.description,
        weight: c.weight,
        order: c.order,
      })),
    contentRef: current.contentRef, // opaque reference — never fetched
  };

  let raw: unknown;
  try {
    // Hard timeout on the provider call: the evaluation FAILS CLOSED — no
    // state change, no implicit approve, structured 504. The losing provider
    // promise is detached with a no-op catch so it can never hold the HTTP
    // request or crash the process with an unhandled rejection. (The provider
    // interface has no cancellation channel yet; an AbortSignal parameter can
    // be added to EvaluatorProvider later without changing this policy.)
    const evaluation = provider.evaluate(input);
    evaluation.catch(() => {}); // detach: never let a late rejection crash us
    raw = await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new EvaluationTimeoutError()), evaluationTimeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof EvaluationTimeoutError) {
      await recordTaskEvent({
        taskId,
        eventType: "EVALUATION_REJECTED",
        actor: actorAddress,
        metadata: {
          reason: "evaluation_timeout",
          providerId: provider.providerId,
          timeoutMs: evaluationTimeoutMs,
          submissionId: current.id,
        },
      });
      return { ok: false, reason: "evaluation_timeout", status: 504 };
    }
    console.error("evaluation provider failed:", err);
    await recordTaskEvent({
      taskId,
      eventType: "EVALUATION_REJECTED",
      actor: actorAddress,
      metadata: {
        reason: "evaluation_provider_error",
        providerId: provider.providerId,
      },
    });
    return { ok: false, reason: "evaluation_provider_error", status: 502 };
  }

  // Strict parse of UNTRUSTED model output. Malformed → reject, no fallback.
  const parsed = ModelEvaluationSchema.safeParse(raw);
  if (!parsed.success) {
    await recordTaskEvent({
      taskId,
      eventType: "EVALUATION_REJECTED",
      actor: actorAddress,
      metadata: {
        reason: "malformed_model_output",
        providerId: provider.providerId,
        submissionId: current.id,
      },
    });
    return { ok: false, reason: "malformed_model_output", status: 502 };
  }
  const evaluation = parsed.data;

  // DETERMINISTIC CODE AUTHORIZES: the recommendation is only a recommendation.
  const resolution = resolveAuthoritativeDecision({
    modelDecision: evaluation.decision,
    rubricCriteria: task.criteria.map((c) => ({ id: c.id })),
    criterionResults: evaluation.criterionResults,
    submissionStatus: current.status,
    revisionCount: task.revisionCount,
  });

  const result = (
    recommendation: ModelDecision,
    decision:
      | AuthoritativeDecision
      | "PENDING_HUMAN_CONFIRMATION",
    outcome:
      | "SUBMISSION_APPROVED"
      | "REVISION_REQUESTED"
      | "TASK_REJECTED"
      | "PENDING_HUMAN_CONFIRMATION"
  ) => ({
    ok: true as const,
    data: {
      recommendation,
      decision,
      downgraded: resolution.downgraded,
      reason: resolution.reason,
      submissionId: current.id,
      taskId,
      outcome,
      policyChecks: resolution.policyChecks,
    },
  });

  try {
    if (resolution.decision === "APPROVED") {
      // HUMAN CONFIRMATION GATE: the AI review NEVER authorizes payment.
      // A policy-passed APPROVE recommendation is recorded as
      // PENDING_HUMAN_CONFIRMATION; only the separate creator confirmation
      // (lib/workflow/ConfirmationService) may mark the submission APPROVED.
      // No task/submission state changes here — the review is advisory.
      await prisma.$transaction(async (tx) => {
        await tx.taskEvent.create({
          data: {
            taskId,
            eventType: "EVALUATION_COMPLETED",
            actor: actorAddress,
            payload: evaluationPayload(
              provider,
              evaluation,
              resolution,
              current.id,
              "PENDING_HUMAN_CONFIRMATION"
            ),
          },
        });
      });
      return result(evaluation.decision, "PENDING_HUMAN_CONFIRMATION", "PENDING_HUMAN_CONFIRMATION");
    }

    if (resolution.decision === "REJECTED") {
      const outcome = await prisma.$transaction(async (tx) => {
        // Guarded task transition: exactly one concurrent reviewer/revision
        // can win the UNDER_REVIEW exit.
        const moved = await transitionTask(tx, taskId, "UNDER_REVIEW", "REJECTED");
        if (!moved) return { conflict: true } as const;
        // Mark the current submission REJECTED (never a SUPERSEDED one).
        const rejectedSub = await tx.submission.updateMany({
          where: { id: current.id, status: { not: "SUPERSEDED" } },
          data: { status: "REJECTED" },
        });
        if (rejectedSub.count !== 1) throw new ReviewConflictError();
        await tx.taskEvent.create({
          data: {
            taskId,
            eventType: "EVALUATION_COMPLETED",
            actor: actorAddress,
            payload: evaluationPayload(
              provider,
              evaluation,
              resolution,
              current.id,
              "TASK_REJECTED"
            ),
          },
        });
        return { conflict: false } as const;
      });
      if (outcome.conflict) {
        await recordTaskEvent({
          taskId,
          eventType: "EVALUATION_REJECTED",
          actor: actorAddress,
          metadata: { reason: "task_state_conflict", submissionId: current.id },
        });
        return { ok: false, reason: "task_state_conflict", status: 409 };
      }
      return result(evaluation.decision, "REJECTED", "TASK_REJECTED");
    }

    // REQUEST_REVISION: delegate to the EXISTING revision workflow —
    // budget enforcement, superseding and audit are not duplicated here.
    const revision = await requestRevision(taskId, task.creator);
    if (!revision.ok) {
      await recordTaskEvent({
        taskId,
        eventType: "EVALUATION_REJECTED",
        actor: actorAddress,
        metadata: {
          reason: `revision_conflict:${revision.reason}`,
          submissionId: current.id,
        },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }
    await recordTaskEvent({
      taskId,
      eventType: "EVALUATION_COMPLETED",
      actor: actorAddress,
      metadata: JSON.parse(
        evaluationPayload(
          provider,
          evaluation,
          resolution,
          current.id,
          "REVISION_REQUESTED"
        )
      ),
    });
    return result(evaluation.decision, "REQUEST_REVISION", "REVISION_REQUESTED");
  } catch (err) {
    if (err instanceof ReviewConflictError) {
      await recordTaskEvent({
        taskId,
        eventType: "EVALUATION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict", submissionId: current.id },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034"
    ) {
      await recordTaskEvent({
        taskId,
        eventType: "EVALUATION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict", submissionId: current.id },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }
    console.error("reviewSubmission failed:", err);
    return { ok: false, reason: "internal", status: 500 };
  }
}