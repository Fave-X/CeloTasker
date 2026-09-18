/**
 * CeloTasker — Human confirmation gate (Stage 5C remediation, FIX 5).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → HUMAN CONFIRMATION MUST AUTHORIZE REAL-MONEY RELEASE → BLOCKCHAIN MUST
 * CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * The AI review endpoint can no longer mark a submission APPROVED. A
 * policy-passed APPROVE recommendation is recorded by the review service as
 * PENDING_HUMAN_CONFIRMATION; ONLY this module — an explicit, authenticated
 * action by the task creator — may transition the current submission
 * PENDING → APPROVED. Payment parameters are never accepted from the client:
 * recipient, token and amount remain derived by the unchanged Stage 4.2
 * settlement gate.
 *
 * No new task state is introduced: the task stays UNDER_REVIEW (the frozen
 * state machine is untouched); confirmation is a separate authoritative,
 * audited action on the submission.
 */
import { prisma } from "../prisma.ts";
import { recordTaskEvent } from "../audit/AuditLog.ts";

export type ConfirmationResult =
  | {
      ok: true;
      data: {
        submissionId: string;
        taskId: string;
        status: "APPROVED" | "ALREADY_CONFIRMED";
      };
    }
  | { ok: false; reason: string; status: number };

interface EvaluationRecord {
  submissionId: string;
  decision: string;
  reason: string | null;
  downgraded: boolean;
  policyChecks: Array<{ id: string; passed: boolean }>;
  providerId: string;
  recommendation: string;
}

/** Find the latest policy-passed PENDING_HUMAN_CONFIRMATION evaluation. */
async function findConfirmableEvaluation(
  taskId: string,
  submissionId: string
): Promise<EvaluationRecord | null> {
  const events = await prisma.taskEvent.findMany({
    where: { taskId, eventType: "EVALUATION_COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  for (const event of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload ?? "{}");
    } catch {
      continue;
    }
    if (payload.submissionId !== submissionId) continue;
    // Only a policy-passed APPROVE recommendation awaiting human
    // confirmation is confirmable (the truthful audit records
    // decision "APPROVED" = the deterministic policy verdict, with outcome
    // PENDING_HUMAN_CONFIRMATION = what the system did).
    if (payload.outcome !== "PENDING_HUMAN_CONFIRMATION") continue;
    if (payload.decision !== "APPROVED") continue;
    if (payload.recommendation !== "APPROVE") continue;
    return {
      submissionId: String(payload.submissionId),
      decision: String(payload.decision),
      reason: (payload.reason as string | null) ?? null,
      downgraded: Boolean(payload.downgraded),
      policyChecks: (payload.policyChecks as EvaluationRecord["policyChecks"]) ?? [],
      providerId: String(payload.providerId ?? "unknown"),
      recommendation: String(payload.recommendation ?? "APPROVE"),
    };
  }
  return null;
}

/**
 * Creator-only human confirmation of an AI-recommended approval. Everything
 * is verified server-side from trusted records; no client-supplied payment
 * parameter exists anywhere in this flow.
 */
export async function confirmApproval(
  taskId: string,
  actorAddress: string
): Promise<ConfirmationResult> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false, reason: "not_found", status: 404 };

  // ACL: ONLY the task creator may confirm real-money release.
  if (task.creator !== actorAddress) {
    return { ok: false, reason: "forbidden", status: 403 };
  }
  if (task.status !== "UNDER_REVIEW") {
    return {
      ok: false,
      reason: `task_not_under_review:${task.status}`,
      status: 409,
    };
  }

  // The current submission is DERIVED server-side (never client-selected).
  const current = await prisma.submission.findFirst({
    where: { taskId, status: { not: "SUPERSEDED" } },
    orderBy: { createdAt: "desc" },
  });
  if (!current) {
    return { ok: false, reason: "no_eligible_submission", status: 409 };
  }

  // Idempotent re-confirmation: already approved with a recorded
  // confirmation is a safe no-op (never a second payment path).
  if (current.status === "APPROVED") {
    const confirmedEvent = await prisma.taskEvent.findFirst({
      where: { taskId, eventType: "APPROVAL_CONFIRMED" },
    });
    if (confirmedEvent) {
      return {
        ok: true,
        data: { submissionId: current.id, taskId, status: "ALREADY_CONFIRMED" },
      };
    }
    // APPROVED without a recorded human confirmation is not confirmable.
    return { ok: false, reason: "not_confirmable", status: 409 };
  }
  if (current.status !== "PENDING") {
    return {
      ok: false,
      reason: `submission_not_pending:${current.status}`,
      status: 409,
    };
  }

  // The AI evaluation must exist, be for THIS submission (stale evaluations
  // cannot confirm a newer submission), and have passed the deterministic
  // approval policy without any downgrade.
  const evaluation = await findConfirmableEvaluation(taskId, current.id);
  if (!evaluation) {
    await recordTaskEvent({
      taskId,
      eventType: "EVALUATION_REJECTED",
      actor: actorAddress,
      metadata: {
        reason: "confirmation_without_ai_approval",
        submissionId: current.id,
      },
    }).catch(() => {});
    return { ok: false, reason: "no_ai_evaluation", status: 409 };
  }
  if (
    evaluation.downgraded ||
    evaluation.reason !== null ||
    !evaluation.policyChecks.every((c) => c.passed)
  ) {
    return { ok: false, reason: "ai_evaluation_not_approved", status: 409 };
  }

  // GUARDED confirmation: exactly one concurrent confirmation wins; a
  // concurrent revision/supersede fails this cleanly (the submission is no
  // longer PENDING) and no stale evaluation can confirm a newer submission.
  const confirmed = await prisma
    .$transaction(async (tx) => {
      const updated = await tx.submission.updateMany({
        where: { id: current.id, status: "PENDING" },
        data: { status: "APPROVED" },
      });
      if (updated.count !== 1) return false;
      await tx.taskEvent.create({
        data: {
          taskId,
          eventType: "APPROVAL_CONFIRMED",
          actor: actorAddress,
          payload: JSON.stringify({
            submissionId: current.id,
            taskId,
            confirmedBy: actorAddress,
            recommendation: evaluation.recommendation,
            providerId: evaluation.providerId,
            note: "Human confirmation of an AI-recommended, policy-passed approval",
          }),
        },
      });
      return true;
    })
    .catch(() => false);

  if (!confirmed) {
    return { ok: false, reason: "task_state_conflict", status: 409 };
  }

  return {
    ok: true,
    data: { submissionId: current.id, taskId, status: "APPROVED" },
  };
}