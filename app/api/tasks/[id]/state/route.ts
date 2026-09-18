import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import {
  serializeTask,
  serializeSubmission,
  serializeSettlement,
  serializeValidationPayload,
  serializeEvaluationPayload,
  type PublicTaskState,
} from "@/lib/api/serialize";
import { getTaskForActor } from "@/lib/workflow/TaskService";

/**
 * GET /api/tasks/[id]/state — read-only task-state bundle (authenticated,
 * same ACL as the detail endpoint: creator or assignee only).
 *
 * Decision (per the existing whitelist-serialization architecture): a DEDICATED
 * state endpoint instead of enriching GET /api/tasks/[id], so the existing
 * list/detail serializers and their consumers stay untouched. The bundle
 * assembles ONLY whitelisted, server-derived facts:
 * - task (existing PublicTask serializer)
 * - current (non-SUPERSEDED) submission
 * - latest deterministic validation result (from the append-only audit trail)
 * - latest AI evaluation summary for THE CURRENT submission (advisory)
 * - settlement for the current submission
 * No client input influences any of these — everything is derived server-side.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "GET /api/tasks/[id]/state"),
    { limit: 60, windowMs: 60_000 }
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const actor = await getAuthenticatedActor(request);
  if (!actor.authenticated || !actor.address) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  const result = await getTaskForActor(id, actor.address);
  if (!result.ok) {
    const message =
      result.reason === "not_found" ? "Task not found" : "Access denied";
    return NextResponse.json({ error: message }, { status: result.status });
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
    ? await prisma.settlement.findUnique({
        where: { submissionId: submission.id },
      })
    : null;

  const state: PublicTaskState = {
    task: serializeTask(task),
    submission: submission ? serializeSubmission(submission) : null,
    validation: currentValidation,
    evaluation: currentEvaluation,
    settlement: settlement ? serializeSettlement(settlement) : null,
  };

  return NextResponse.json({ state }, { status: 200 });
}