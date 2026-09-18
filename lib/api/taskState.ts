/**
 * CeloTasker — read-only task-state bundle (UI Step 1).
 *
 * Lives in lib/ (not the route) so it is testable through Node's test runner —
 * matching the existing convention: services in lib/, routes are thin
 * transport wrappers.
 *
 * Decision (per the existing whitelist-serialization architecture): a DEDICATED
 * state surface instead of enriching GET /api/tasks/[id], so the existing
 * list/detail serializers and their consumers stay untouched. The bundle
 * assembles ONLY whitelisted, server-derived facts:
 * - task (existing PublicTask serializer)
 * - current (non-SUPERSEDED) submission
 * - latest deterministic validation result (from the append-only audit trail)
 * - latest AI evaluation summary for THE CURRENT submission (advisory)
 * - settlement for the current submission
 *
 * No client input influences any of these — everything is derived server-side,
 * and the ACL is identical to the detail endpoint (creator or assignee only).
 */
import { prisma } from "../prisma.ts";
import { getTaskForActor } from "../workflow/TaskService.ts";
import {
  serializeTask,
  serializeSubmission,
  serializeSettlement,
  serializeValidationPayload,
  serializeEvaluationPayload,
  type PublicTaskState,
} from "./serialize.ts";

export type TaskStateResult =
  | { ok: true; data: { state: PublicTaskState } }
  | { ok: false; reason: "not_found" | "forbidden" | "invalid_id"; status: number };

/**
 * Assemble the read-only task-state bundle for an authenticated actor.
 * Returns a structured refusal (never a partial bundle) when the actor may not
 * read the task.
 */
export async function getTaskStateForActor(
  taskId: string,
  actorAddress: string
): Promise<TaskStateResult> {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 64) {
    return { ok: false, reason: "invalid_id", status: 400 };
  }

  const result = await getTaskForActor(taskId, actorAddress);
  if (!result.ok) {
    // The detail endpoint's exact ACL semantics: only a genuinely missing task
    // is a 404; everything else is an access refusal.
    const reason = result.reason === "not_found" ? "not_found" : "forbidden";
    return { ok: false, reason, status: result.status };
  }
  const task = result.data;

  // Current (non-superseded) submission — derived, never client-selected.
  const submission = await prisma.submission.findFirst({
    where: { taskId: task.id, status: { not: "SUPERSEDED" } },
    orderBy: { createdAt: "desc" },
  });

  // Latest deterministic validation from the append-only audit trail.
  const validationEvent = await prisma.taskEvent.findFirst({
    where: { taskId: task.id, eventType: "VALIDATION_STARTED" },
    orderBy: { createdAt: "desc" },
  });
  const validation = serializeValidationPayload(validationEvent?.payload ?? null);
  // A validation belongs to a specific submission; hide stale results.
  const currentValidation =
    validation && submission && validation.submissionId === submission.id
      ? validation
      : null;

  // Latest AI evaluation summary — advisory, and only for the CURRENT
  // submission (stale evaluations from earlier revisions are never shown).
  const evaluationEvent = await prisma.taskEvent.findFirst({
    where: { taskId: task.id, eventType: "EVALUATION_COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  const evaluation = serializeEvaluationPayload(evaluationEvent?.payload ?? null);
  const currentEvaluation =
    evaluation && submission && evaluation.submissionId === submission.id
      ? evaluation
      : null;

  // Settlement for the current submission (at most one exists).
  const settlement = submission
    ? await prisma.settlement.findUnique({ where: { submissionId: submission.id } })
    : null;

  const state: PublicTaskState = {
    task: serializeTask(task),
    submission: submission ? serializeSubmission(submission) : null,
    validation: currentValidation,
    evaluation: currentEvaluation,
    settlement: settlement ? serializeSettlement(settlement) : null,
  };

  return { ok: true, data: { state } };
}