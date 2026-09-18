/**
 * CeloTasker — Task lifecycle states and legal transitions (deterministic).
 * Server module; import only from server-side code.
 */
import { MAX_REVISION_ATTEMPTS } from "../security/SecurityPolicy.ts";

export const TASK_STATUSES = [
  "CREATED",
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "SUBMITTED",
  "UNDER_VALIDATION",
  "UNDER_REVIEW",
  "REVISION_REQUESTED",
  "SETTLING",
  "SETTLED",
  "COMPLETED",
  "REJECTED",
  "PAYMENT_FAILED",
  "EXPIRED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Submission lifecycle statuses. SUPERSEDED marks submissions from earlier
 * revision attempts: they can never be treated as the latest/valid submission
 * for settlement — only the most recent PENDING submission is current.
 */
export const SUBMISSION_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export type TaskEventType =
  | "TASK_CREATED"
  | "TASK_OPENED"
  | "TASK_ASSIGNED"
  | "WORK_STARTED"
  | "SUBMISSION_RECEIVED"
  | "VALIDATION_STARTED"
  | "REVIEW_STARTED"
  | "REVISION_REQUESTED"
  | "REVISION_LIMIT_REACHED"
  | "REVISION_REJECTED"
  | "APPROVAL_CONFIRMED"
  | "SETTLEMENT_REJECTED"
  | "VALIDATION_REJECTED"
  | "EVALUATION_COMPLETED"
  | "EVALUATION_REJECTED"
  | "CLAIM_FAILED"
  | "SUBMISSION_REJECTED"
  | "TASK_APPROVED"
  | "TASK_REJECTED"
  | "SETTLEMENT_STARTED"
  | "SETTLEMENT_COMPLETED"
  | "SETTLEMENT_BROADCAST"
  | "PAYMENT_FAILED"
  | "TASK_EXPIRED"
  | "TASK_COMPLETED";

/**
 * Legal transitions. Transition labels distinguish the reason an
 * UNDER_REVIEW task leaves review (revision / approval / rejection).
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  CREATED: ["OPEN"],
  OPEN: ["ASSIGNED", "EXPIRED"],
  ASSIGNED: ["IN_PROGRESS", "EXPIRED"],
  IN_PROGRESS: ["SUBMITTED", "EXPIRED"],
  SUBMITTED: ["UNDER_VALIDATION"],
  UNDER_VALIDATION: ["UNDER_REVIEW"],
  UNDER_REVIEW: ["REVISION_REQUESTED", "SETTLING", "REJECTED"],
  REVISION_REQUESTED: ["IN_PROGRESS"],
  SETTLING: ["SETTLED", "PAYMENT_FAILED"],
  SETTLED: ["COMPLETED"],
  COMPLETED: [],
  REJECTED: [],
  PAYMENT_FAILED: [],
  EXPIRED: [],
};

/** Reason an UNDER_REVIEW task exits review, mapped to its target state. */
export type ReviewDecision = "REQUEST_REVISION" | "APPROVED" | "REJECTED";

export const REVIEW_DECISION_TARGET: Readonly<
  Record<ReviewDecision, TaskStatus>
> = {
  REQUEST_REVISION: "REVISION_REQUESTED",
  APPROVED: "SETTLING",
  REJECTED: "REJECTED",
};

export class IllegalTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Deterministic check: returns true only for whitelisted transitions. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Deterministic transition; throws IllegalTransitionError on illegal moves. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/**
 * Resolve a review decision to its target state, enforcing the maximum
 * revision attempts. Throws when the revision budget is exhausted.
 */
export function resolveReviewDecision(
  currentRevisionCount: number,
  decision: ReviewDecision
): TaskStatus {
  const target = REVIEW_DECISION_TARGET[decision];
  if (decision === "REQUEST_REVISION") {
    if (currentRevisionCount >= MAX_REVISION_ATTEMPTS) {
      throw new Error(
        `Revision limit reached (${MAX_REVISION_ATTEMPTS}); no further revisions allowed`
      );
    }
  }
  assertTransition("UNDER_REVIEW", target);
  return target;
}

/** Narrow a stored DB status string into a TaskStatus, rejecting unknowns. */
export function toTaskStatus(value: string): TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown task status: ${value}`);
  }
  return value as TaskStatus;
}
