/**
 * CeloTasker — Whitelist-based API response serializers.
 *
 * Responses expose ONLY explicitly whitelisted fields. Database internals,
 * internal counts, and any environment/secret material can never leak,
 * because serializers omit everything not listed.
 */
import type { Task, Submission, Settlement, RubricCriteria, TaskEvent } from "@prisma/client";

export type PublicTask = Pick<
  Task,
  | "id"
  | "title"
  | "description"
  | "rewardAmount"
  | "rewardToken"
  | "status"
  | "creator"
  | "assignee"
  | "deadline"
  | "createdAt"
> & {
  criteria: Array<Pick<RubricCriteria, "id" | "description" | "weight" | "order">>;
};

export type PublicSubmission = Pick<
  Submission,
  "id" | "taskId" | "submitter" | "contentRef" | "status" | "score" | "createdAt"
>;

export type PublicSettlement = Pick<
  Settlement,
  "id" | "submissionId" | "taskId" | "recipient" | "amount" | "rewardToken" | "status" | "createdAt"
>;

export function serializeTask(
  task: Task & { criteria?: RubricCriteria[] }
): PublicTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    rewardAmount: task.rewardAmount,
    rewardToken: task.rewardToken,
    status: task.status,
    creator: task.creator,
    assignee: task.assignee,
    deadline: task.deadline,
    createdAt: task.createdAt,
    criteria: (task.criteria ?? []).map((c) => ({
      id: c.id,
      description: c.description,
      weight: c.weight,
      order: c.order,
    })),
  };
}

export function serializeSubmission(submission: Submission): PublicSubmission {
  return {
    id: submission.id,
    taskId: submission.taskId,
    submitter: submission.submitter,
    contentRef: submission.contentRef,
    status: submission.status,
    score: submission.score,
    createdAt: submission.createdAt,
  };
}

export function serializeSettlement(settlement: Settlement): PublicSettlement {
  return {
    id: settlement.id,
    submissionId: settlement.submissionId,
    taskId: settlement.taskId,
    recipient: settlement.recipient,
    amount: settlement.amount,
    rewardToken: settlement.rewardToken,
    status: settlement.status,
    createdAt: settlement.createdAt,
  };
}

// ─── Audit events (read-only whitelisted view) ───────────────

export type PublicTaskEvent = Pick<
  TaskEvent,
  "id" | "eventType" | "actor" | "payload" | "createdAt"
>;

export function serializeTaskEvent(event: TaskEvent): PublicTaskEvent {
  return {
    id: event.id,
    eventType: event.eventType,
    actor: event.actor,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

// ─── Task-state bundle (read-only task detail surface) ───────

/** Whitelisted shape of a stored deterministic-validation result payload. */
export interface PublicValidation {
  submissionId: string;
  taskId: string;
  valid: boolean;
  checks: Array<{ id: string; label: string; passed: boolean; detail: string | null }>;
  failureReasons: string[];
  contentProven: boolean;
  validatedAt: string;
}

/** Whitelisted summary of a stored AI-evaluation audit payload. */
export interface PublicEvaluation {
  providerId: string;
  modelId: string;
  recommendation: string;
  decision: string;
  downgraded: boolean;
  reason: string | null;
  policyChecks: Array<{ id: string; label: string; passed: boolean }>;
  criterionResults: Array<{
    criterionId: string;
    satisfied: boolean;
    score?: number;
    reasoning: string;
  }>;
  overallFeedback: string;
  outcome: string;
  submissionId: string;
}

/** Everything the Task Detail screen needs, ACL'd and whitelist-serialized. */
export interface PublicTaskState {
  task: PublicTask;
  submission: PublicSubmission | null;
  validation: PublicValidation | null;
  evaluation: PublicEvaluation | null;
  settlement: PublicSettlement | null;
}

/**
 * Whitelist-parse a stored VALIDATION_STARTED audit payload. Returns null for
 * absent/malformed payloads — never invents validation facts.
 */
export function serializeValidationPayload(
  payload: string | null
): PublicValidation | null {
  if (!payload) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const v = raw as Record<string, unknown>;
  if (
    typeof v.submissionId !== "string" ||
    typeof v.taskId !== "string" ||
    typeof v.valid !== "boolean" ||
    !Array.isArray(v.checks) ||
    !Array.isArray(v.failureReasons) ||
    typeof v.validatedAt !== "string"
  ) {
    return null;
  }
  const checks = v.checks.filter(
    (c): c is { id: string; label: string; passed: boolean; detail: string | null } =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { label?: unknown }).label === "string" &&
      typeof (c as { passed?: unknown }).passed === "boolean"
  ) as PublicValidation["checks"];
  return {
    submissionId: v.submissionId,
    taskId: v.taskId,
    valid: v.valid,
    checks,
    failureReasons: v.failureReasons.filter((r): r is string => typeof r === "string"),
    contentProven: v.contentProven === true,
    validatedAt: v.validatedAt,
  };
}

/**
 * Whitelist-parse a stored EVALUATION_COMPLETED audit payload. Returns null
 * for absent/malformed payloads — the AI recommendation is advisory data and
 * is never synthesized here.
 */
export function serializeEvaluationPayload(
  payload: string | null
): PublicEvaluation | null {
  if (!payload) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const e = raw as Record<string, unknown>;
  if (
    typeof e.providerId !== "string" ||
    typeof e.modelId !== "string" ||
    typeof e.recommendation !== "string" ||
    typeof e.decision !== "string" ||
    typeof e.downgraded !== "boolean" ||
    !Array.isArray(e.policyChecks) ||
    typeof e.overallFeedback !== "string" ||
    typeof e.submissionId !== "string" ||
    typeof e.outcome !== "string"
  ) {
    return null;
  }
  const policyChecks = e.policyChecks.filter(
    (c): c is { id: string; label: string; passed: boolean } =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { label?: unknown }).label === "string" &&
      typeof (c as { passed?: unknown }).passed === "boolean"
  ) as PublicEvaluation["policyChecks"];
  const criterionResults = Array.isArray(e.criterionResults)
    ? (e.criterionResults.filter(
        (c): c is NonNullable<PublicEvaluation["criterionResults"]>[number] =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { criterionId?: unknown }).criterionId === "string" &&
          typeof (c as { satisfied?: unknown }).satisfied === "boolean" &&
          typeof (c as { reasoning?: unknown }).reasoning === "string"
      ) as PublicEvaluation["criterionResults"])
    : [];
  return {
    providerId: e.providerId,
    modelId: e.modelId,
    recommendation: e.recommendation,
    decision: e.decision,
    downgraded: e.downgraded,
    reason: typeof e.reason === "string" ? e.reason : null,
    policyChecks,
    criterionResults,
    overallFeedback: e.overallFeedback,
    outcome: e.outcome,
    submissionId: e.submissionId,
  };
}
