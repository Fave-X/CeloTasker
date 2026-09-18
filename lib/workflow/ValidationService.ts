/**
 * CeloTasker — Deterministic validation service (Stage 5A).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * Runs the pure deterministic validator (lib/workflow/DeterministicValidator)
 * BEFORE any AI evaluation, and is the ONLY component allowed to move a task
 * from SUBMITTED into UNDER_REVIEW:
 *
 *   SUBMITTED → UNDER_VALIDATION → deterministic validator → UNDER_REVIEW
 *
 * Server-controlled behavior:
 * - Actor identity comes exclusively from the verified session; the route
 *   passes getAuthenticatedActor's address. Only the task creator may
 *   trigger validation (the requester-side gate, mirroring the revision ACL).
 * - Task, rubric and submission are loaded server-side; the current
 *   (non-SUPERSEDED) submission is DERIVED from the task, never selected by
 *   the client, so a stale submission can never become eligible for review.
 * - The state transitions are guarded `transitionTask` writes: concurrent
 *   validations produce exactly one winner; the loser gets a deterministic
 *   409 and no state is applied.
 * - An INVALID submission still moves to UNDER_REVIEW (the only legal exit
 *   from SUBMITTED in the frozen state machine): the submission is marked
 *   REJECTED and the structured result is recorded in the audit trail, so
 *   the creator can deterministically request a revision.
 * - The validator never approves content: content verification (human/AI)
 *   happens under UNDER_REVIEW. No LLM, no network, no randomness here.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.ts";
import { recordTaskEvent } from "../audit/AuditLog.ts";
import { transitionTask } from "./TaskService.ts";
import { validateSubmissionContent, type ValidationResult } from "./DeterministicValidator.ts";

export type ValidationOutcome =
  | { ok: true; data: ValidationResult }
  | { ok: false; reason: string; status: number };

/** Sentinel: the submission changed concurrently — roll everything back. */
class StaleSubmissionConflictError extends Error {
  constructor() {
    super("Submission changed concurrently; validation rolled back");
    this.name = "StaleSubmissionConflictError";
  }
}

export async function validateSubmission(
  taskId: string,
  actorAddress: string
): Promise<ValidationOutcome> {
  // Load the task (with its trusted rubric) server-side.
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { criteria: true },
  });
  if (!task) return { ok: false, reason: "not_found", status: 404 };

  // ACL: only the task creator may trigger deterministic validation.
  if (task.creator !== actorAddress) {
    return { ok: false, reason: "forbidden", status: 403 };
  }
  if (task.status !== "SUBMITTED") {
    return { ok: false, reason: `task_not_submitted:${task.status}`, status: 409 };
  }

  // Current-submission-only: derive the eligible submission from the task.
  // A SUPERSEDED (earlier revision attempt) submission can never be reviewed.
  const current = await prisma.submission.findFirst({
    where: { taskId, status: { not: "SUPERSEDED" } },
    orderBy: { createdAt: "desc" },
  });
  if (!current) {
    await recordTaskEvent({
      taskId,
      eventType: "VALIDATION_REJECTED",
      actor: actorAddress,
      metadata: { reason: "no_eligible_submission" },
    });
    return { ok: false, reason: "no_eligible_submission", status: 409 };
  }

  // PURE deterministic validation on server-loaded trusted data. Runs before
  // any AI evaluation; it never fetches, never signs, never approves content.
  const result = validateSubmissionContent(task, current);

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Guarded transition 1: SUBMITTED -> UNDER_VALIDATION. Exactly one
      // concurrent validator can win; losers get a deterministic 409.
      const moved = await transitionTask(tx, taskId, "SUBMITTED", "UNDER_VALIDATION");
      if (!moved) return { conflict: true } as const;

      // Guarded transition 2: UNDER_VALIDATION -> UNDER_REVIEW. If the guard
      // unexpectedly fails, roll back — never record a transition that did
      // not complete (audit/state consistency).
      const reviewed = await transitionTask(tx, taskId, "UNDER_VALIDATION", "UNDER_REVIEW");
      if (!reviewed) {
        throw new Error("Validation transition failed; transaction rolled back");
      }

      if (!result.valid) {
        // Deterministically reject the invalid submission, guarded on its
        // current status. If it changed concurrently, roll back rather than
        // recording a REJECTED outcome we did not apply.
        const rejected = await tx.submission.updateMany({
          where: { id: current.id, status: "PENDING" },
          data: { status: "REJECTED" },
        });
        if (rejected.count !== 1) {
          throw new StaleSubmissionConflictError();
        }
      }

      // Audit: the structured deterministic result, truthfully recorded.
      await tx.taskEvent.create({
        data: {
          taskId,
          eventType: "VALIDATION_STARTED",
          actor: actorAddress,
          payload: JSON.stringify({
            ...result,
            fromStatus: "SUBMITTED",
            toStatus: "UNDER_REVIEW",
            path: "SUBMITTED -> UNDER_VALIDATION -> UNDER_REVIEW",
          }),
        },
      });

      return { conflict: false, result } as const;
    });

    if (outcome.conflict) {
      await recordTaskEvent({
        taskId,
        eventType: "VALIDATION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict", submissionId: current.id },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }

    return { ok: true, data: outcome.result };
  } catch (err) {
    if (err instanceof StaleSubmissionConflictError) {
      await recordTaskEvent({
        taskId,
        eventType: "VALIDATION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "submission_changed_concurrently", submissionId: current.id },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034"
    ) {
      await recordTaskEvent({
        taskId,
        eventType: "VALIDATION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict", submissionId: current.id },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }
    console.error("validateSubmission failed:", err);
    return { ok: false, reason: "internal", status: 500 };
  }
}