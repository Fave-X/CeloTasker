/**
 * CeloTasker — Deterministic task workflow service.
 *
 * All state transitions go through the whitelisted state machine
 * (lib/workflow/TaskStatus.ts) via the single `transitionTask` helper, which
 * (1) asserts the move against LEGAL_TRANSITIONS and (2) performs a
 * conditional Prisma updateMany guarded on the current status — so concurrent
 * requests can never double-apply and no raw status writes exist. Identity is
 * passed in from the verified session (routes resolve it via
 * getAuthenticatedActor) — never from request bodies.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.ts";
import { recordTaskEvent } from "../audit/AuditLog.ts";
import {
  assertTransition,
  type TaskStatus,
} from "./TaskStatus.ts";
import { MAX_REVISION_ATTEMPTS } from "../security/SecurityPolicy.ts";
import type { CreateTaskRequest } from "../validation/ValidationSchemas.ts";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; status: number };

function isExpired(deadline: Date | null): boolean {
  return deadline !== null && deadline.getTime() <= Date.now();
}

/**
 * Prisma signals a transaction write conflict (e.g. SQLITE_BUSY under
 * contention, or serialization failures on other databases) with P2034.
 * Such races are deterministic conflicts, not internal errors: the caller
 * must receive a 409, never an uncaught 500.
 */
function isTransactionWriteConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034"
  );
}

/** Prisma predicate: the deadline is absent or still in the future. */
function deadlineNotPassedWhere(): Prisma.TaskWhereInput {
  return { OR: [{ deadline: null }, { deadline: { gt: new Date() } }] };
}

interface TransitionOptions {
  /** Extra task fields to set atomically together with the transition. */
  data?: {
    assignee?: string;
    revisionCountIncrement?: number;
  };
  /** Additional predicates that must hold for the transition to apply. */
  extraWhere?: Prisma.TaskWhereInput;
}

/**
 * THE single deterministic transition helper. Every production task status
 * write in this module — and in the settlement path (Stage 4.2) — goes
 * through here:
 * 1. it asserts the move against LEGAL_TRANSITIONS (whitelist), and
 * 2. it performs a conditional updateMany guarded on the current status (and
 *    any extra predicates), so exactly one concurrent caller can win.
 * Returns false when the guard did not match (raced or ineligible).
 */
export async function transitionTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  options: TransitionOptions = {}
): Promise<boolean> {
  assertTransition(from, to);
  const res = await tx.task.updateMany({
    where: { id: taskId, status: from, ...(options.extraWhere ?? {}) },
    data: {
      status: to,
      ...(options.data?.assignee !== undefined
        ? { assignee: options.data.assignee }
        : {}),
      ...(options.data?.revisionCountIncrement
        ? { revisionCount: { increment: options.data.revisionCountIncrement } }
        : {}),
    },
  });
  return res.count === 1;
}

/**
 * Deterministic lazy expiry: transition an expired task to EXPIRED (guarded,
 * so concurrent attempts apply exactly once) and record the audit event.
 * Called when an expired task is encountered — no scheduler needed.
 */
async function expireTask(
  taskId: string,
  from: TaskStatus,
  actor: string = "system"
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const done = await transitionTask(tx, taskId, from, "EXPIRED");
    if (!done) return false;
    await tx.taskEvent.create({
      data: {
        taskId,
        eventType: "TASK_EXPIRED",
        actor,
        payload: JSON.stringify({ fromStatus: from, toStatus: "EXPIRED" }),
      },
    });
    return true;
  });
}

// ─── 1. Task creation ────────────────────────────────────────

export async function createTask(
  creatorAddress: string,
  data: CreateTaskRequest
) {
  // CREATED -> OPEN happens atomically; the client never chooses status.
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        title: data.title,
        description: data.description,
        rewardAmount: data.rewardAmount,
        rewardToken: data.rewardToken.toLowerCase(),
        status: "CREATED",
        creator: creatorAddress,
        assignee: data.assignee?.toLowerCase() ?? null,
        deadline: data.deadline ?? null,
        revisionCount: 0,
        criteria: {
          create: data.criteria.map((c) => ({
            description: c.description,
            weight: c.weight,
            order: c.order,
          })),
        },
      },
      include: { criteria: true },
    });

    const opened = await transitionTask(tx, created.id, "CREATED", "OPEN");
    if (!opened) {
      throw new Error("Failed to open newly created task");
    }

    await tx.taskEvent.create({
      data: {
        taskId: created.id,
        eventType: "TASK_CREATED",
        actor: creatorAddress,
        payload: JSON.stringify({
          title: created.title,
          rewardAmount: created.rewardAmount,
          criteriaCount: created.criteria.length,
        }),
      },
    });
    await tx.taskEvent.create({
      data: {
        taskId: created.id,
        eventType: "TASK_OPENED",
        actor: creatorAddress,
        payload: null,
      },
    });

    return { ...created, status: "OPEN" as TaskStatus };
  });

  return task;
}

// ─── 2. Task discovery ───────────────────────────────────────

/**
 * OPEN tasks available to workers. Serialized public fields only.
 * Deterministic lazy expiry: expired OPEN tasks are transitioned to EXPIRED
 * when encountered here, so dead work is never advertised indefinitely.
 */
export async function listOpenTasks() {
  const stale = await prisma.task.findMany({
    where: { status: "OPEN", deadline: { lte: new Date() } },
    select: { id: true },
  });
  for (const t of stale) {
    await expireTask(t.id, "OPEN");
  }
  return prisma.task.findMany({
    where: { status: "OPEN", ...deadlineNotPassedWhere() },
    include: { criteria: true },
    orderBy: { createdAt: "desc" },
  });
}
// ─── 3. Task claiming ────────────────────────────────────────

export async function claimTask(taskId: string, workerAddress: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false as const, reason: "not_found", status: 404 };

  // ACL on immutable fields: the creator can never claim their own task, and
  // a task with a pre-designated assignee can only be claimed by that worker.
  // (task.creator never changes; task.assignee only changes together with a
  // status change, which the guarded transition below re-checks.)
  if (task.creator === workerAddress) {
    return { ok: false as const, reason: "creator_cannot_claim", status: 403 };
  }
  if (task.status !== "OPEN") {
    return { ok: false as const, reason: "not_open", status: 409 };
  }
  if (task.assignee !== null && task.assignee !== workerAddress) {
    return { ok: false as const, reason: "already_assigned", status: 403 };
  }
  if (isExpired(task.deadline)) {
    // Deterministic lazy expiry: the task can never be advertised again.
    await expireTask(taskId, "OPEN", workerAddress);
    return { ok: false as const, reason: "expired", status: 410 };
  }

  try {
    const claimed = await prisma.$transaction(async (tx) => {
      // Atomic guard: only one claimant can flip OPEN -> ASSIGNED. The guard
      // re-checks the designated assignee AND the deadline inside the database,
      // so a check-then-write race cannot bypass either control.
      const won = await transitionTask(tx, taskId, "OPEN", "ASSIGNED", {
        data: { assignee: workerAddress },
        extraWhere: {
          OR: [{ assignee: null }, { assignee: workerAddress }],
          AND: [deadlineNotPassedWhere()],
        },
      });
      if (!won) {
        await tx.taskEvent.create({
          data: {
            taskId,
            eventType: "CLAIM_FAILED",
            actor: workerAddress,
            payload: JSON.stringify({ reason: "claim_guard_rejected" }),
          },
        });
        return null;
      }

      const started = await transitionTask(tx, taskId, "ASSIGNED", "IN_PROGRESS");
      if (!started) return null; // unreachable inside this transaction

      await tx.taskEvent.create({
        data: {
          taskId,
          eventType: "TASK_ASSIGNED",
          actor: workerAddress,
          payload: JSON.stringify({ fromStatus: "OPEN", toStatus: "ASSIGNED" }),
        },
      });
      await tx.taskEvent.create({
        data: {
          taskId,
          eventType: "WORK_STARTED",
          actor: workerAddress,
          payload: JSON.stringify({ fromStatus: "ASSIGNED", toStatus: "IN_PROGRESS" }),
        },
      });

      return tx.task.findUnique({ where: { id: taskId } });
    });

    if (!claimed) {
      return { ok: false as const, reason: "already_claimed", status: 409 };
    }
    return { ok: true as const, data: claimed };
  } catch (err) {
    console.error("claimTask failed:", err);
    return { ok: false as const, reason: "internal", status: 500 };
  }
}

// ─── 4. Task submission ──────────────────────────────────────

export async function submitWork(
  input: { taskId: string; contentRef: string },
  workerAddress: string
) {
  const task = await prisma.task.findUnique({ where: { id: input.taskId } });
  if (!task) return { ok: false as const, reason: "not_found", status: 404 };

  const reject = async (reason: string, status: number) => {
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SUBMISSION_REJECTED",
      actor: workerAddress,
      metadata: { reason },
    });
    return { ok: false as const, reason, status };
  };

  if (task.status !== "IN_PROGRESS") {
    return reject(`task_not_in_progress:${task.status}`, 409);
  }
  // Non-assignees can never submit.
  if (task.assignee !== workerAddress) {
    return reject("not_assignee", 403);
  }
  // Deadline enforcement (read path). The guarded transition below re-checks
  // the deadline inside the database, so a race between this read and the
  // write can never land a late submission.
  if (isExpired(task.deadline)) {
    await expireTask(task.id, "IN_PROGRESS", workerAddress);
    return reject("deadline_passed", 410);
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Guarded transition FIRST: the submission row is only created after the
      // task has deterministically moved IN_PROGRESS -> SUBMITTED, so a lost
      // race leaves no partial records.
      const moved = await transitionTask(tx, task.id, "IN_PROGRESS", "SUBMITTED", {
        extraWhere: deadlineNotPassedWhere(),
      });
      if (!moved) return { conflict: true } as const;

      const created = await tx.submission.create({
        data: {
          taskId: task.id,
          submitter: workerAddress,
          contentRef: input.contentRef,
          status: "PENDING",
        },
      });

      await tx.taskEvent.create({
        data: {
          taskId: task.id,
          eventType: "SUBMISSION_RECEIVED",
          actor: workerAddress,
          payload: JSON.stringify({
            submissionId: created.id,
            fromStatus: "IN_PROGRESS",
            toStatus: "SUBMITTED",
          }),
        },
      });

      return { conflict: false, created } as const;
    });

    if (outcome.conflict) {
      // Distinguish a deadline race from a status race (without leaking
      // internal error details): if the task is still IN_PROGRESS but the
      // deadline has passed, the deadline guard rejected the write.
      const fresh = await prisma.task.findUnique({
        where: { id: task.id },
        select: { status: true, deadline: true },
      });
      if (fresh && fresh.status === "IN_PROGRESS" && isExpired(fresh.deadline)) {
        await expireTask(task.id, "IN_PROGRESS", workerAddress);
        return reject("deadline_passed", 410);
      }
      return reject("task_state_conflict", 409);
    }

    return { ok: true as const, data: outcome.created };
  } catch (err) {
    if (isTransactionWriteConflict(err)) {
      // The transaction rolled back — no partial records exist.
      return reject("task_state_conflict", 409);
    }
    console.error("submitWork failed:", err);
    return { ok: false as const, reason: "internal", status: 500 };
  }
}

// ─── 5. Revision loop ────────────────────────────────────────

/**
 * Request a revision: UNDER_REVIEW -> REVISION_REQUESTED -> IN_PROGRESS,
 * incrementing the revision count. Enforces MAX_REVISION_ATTEMPTS.
 * ACL: ONLY the task creator may call this (identity from the verified
 * session; the AI evaluator integration arrives in a later stage).
 */
export async function requestRevision(taskId: string, actorAddress: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return { ok: false as const, reason: "not_found", status: 404 };

  // Authorization: unrelated authenticated users (including the assigned
  // worker) are rejected before any state inspection.
  if (task.creator !== actorAddress) {
    return { ok: false as const, reason: "forbidden", status: 403 };
  }
  if (task.status !== "UNDER_REVIEW") {
    return { ok: false as const, reason: `task_not_under_review:${task.status}`, status: 409 };
  }
  if (task.revisionCount >= MAX_REVISION_ATTEMPTS) {
    await recordTaskEvent({
      taskId,
      eventType: "REVISION_LIMIT_REACHED",
      actor: actorAddress,
      metadata: { revisionCount: task.revisionCount },
    });
    return { ok: false as const, reason: "revision_limit_reached", status: 409 };
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Deterministic increment + first transition, guarded on the current
      // status AND the remaining revision budget, so concurrent requests can
      // never exceed MAX_REVISION_ATTEMPTS.
      const moved = await transitionTask(
        tx,
        taskId,
        "UNDER_REVIEW",
        "REVISION_REQUESTED",
        {
          data: { revisionCountIncrement: 1 },
          extraWhere: { revisionCount: { lt: MAX_REVISION_ATTEMPTS } },
        }
      );
      if (!moved) return { conflict: true } as const;

      const started = await transitionTask(tx, taskId, "REVISION_REQUESTED", "IN_PROGRESS");
      if (!started) {
        // Unreachable by construction inside this transaction, but if the
        // guard ever fails we must NOT continue: superseding submissions and
        // writing a REVISION_REQUESTED audit event for a transition that did
        // not complete would corrupt state/audit consistency. Throw so the
        // whole transaction rolls back (no partial transition, no event).
        throw new Error("Revision transition failed; transaction rolled back");
      }

      // Submission versioning: submissions from earlier revision attempts are
      // marked SUPERSEDED atomically in the same transaction, so only the
      // latest submission can ever be treated as the valid one. Both PENDING
      // and APPROVED rows are covered: an APPROVED submission from an earlier
      // revision must not remain payable after a revision (Stage 4.2).
      const superseded = await tx.submission.updateMany({
        where: { taskId, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "SUPERSEDED" },
      });

      const fresh = await tx.task.findUnique({ where: { id: taskId } });

      await tx.taskEvent.create({
        data: {
          taskId,
          eventType: "REVISION_REQUESTED",
          actor: actorAddress,
          payload: JSON.stringify({
            revisionCount: fresh?.revisionCount ?? null,
            supersededSubmissions: superseded.count,
            path: "UNDER_REVIEW -> REVISION_REQUESTED -> IN_PROGRESS",
          }),
        },
      });

      return { conflict: false, task: fresh } as const;
    });

    if (outcome.conflict) {
      await recordTaskEvent({
        taskId,
        eventType: "REVISION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict" },
      });
      return { ok: false as const, reason: "task_state_conflict", status: 409 };
    }
    if (!outcome.task) {
      return { ok: false as const, reason: "internal", status: 500 };
    }
    return { ok: true as const, data: outcome.task };
  } catch (err) {
    if (isTransactionWriteConflict(err)) {
      // The transaction rolled back — no partial records exist.
      await recordTaskEvent({
        taskId,
        eventType: "REVISION_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict" },
      });
      return { ok: false as const, reason: "task_state_conflict", status: 409 };
    }
    console.error("requestRevision failed:", err);
    return { ok: false as const, reason: "internal", status: 500 };
  }
}

// ─── 6. Task retrieval ───────────────────────────────────────

/** Detail access control: only the creator or the assignee. */
export async function getTaskForActor(taskId: string, actorAddress: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { criteria: true },
  });
  if (!task) return { ok: false as const, reason: "not_found", status: 404 };
  if (task.creator !== actorAddress && task.assignee !== actorAddress) {
    return { ok: false as const, reason: "forbidden", status: 403 };
  }
  // Deterministic recovery for expired in-flight work: an ASSIGNED or
  // IN_PROGRESS task past its deadline is transitioned to EXPIRED on first
  // encounter by an authorized reader instead of remaining permanently stuck.
  if (
    (task.status === "ASSIGNED" || task.status === "IN_PROGRESS") &&
    isExpired(task.deadline)
  ) {
    const expired = await expireTask(taskId, task.status as TaskStatus);
    if (expired) {
      return { ok: true as const, data: { ...task, status: "EXPIRED" as const } };
    }
  }
  return { ok: true as const, data: task };
}

/** Tasks relevant to the authenticated user (created by or assigned to). */
export async function listMyTasks(actorAddress: string) {
  return prisma.task.findMany({
    where: {
      OR: [{ creator: actorAddress }, { assignee: actorAddress }],
    },
    include: { criteria: true },
    orderBy: { createdAt: "desc" },
  });
}

