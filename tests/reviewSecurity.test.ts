/**
 * CeloTasker — Stage 5B AI evaluation/review tests.
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * Covers:
 * 1. The pure deterministic resolution layer (approve policy, downgrades,
 *    budget exhaustion, malformed/partial/missing/unknown criteria).
 * 2. The review service: APPROVE / REQUEST_REVISION / REJECT outcomes,
 *    malformed AI output (never an implicit approve), provider unavailability,
 *    superseded submissions, creator-only ACL, concurrency (one authoritative
 *    outcome), and truthful audit records (recommendation AND decision).
 * 3. Regression: the review outcomes compose correctly with the existing
 *    revision workflow and the Stage 4.2 settlement authorization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
} from "../lib/workflow/TaskService.ts";
import { validateSubmission } from "../lib/workflow/ValidationService.ts";
import {
  reviewSubmission,
  resolveAuthoritativeDecision,
} from "../lib/workflow/ReviewService.ts";
import { requestSettlement } from "../lib/workflow/SettlementService.ts";
import { confirmApproval } from "../lib/workflow/ConfirmationService.ts";
import { StaticEvaluatorProvider } from "../lib/evaluation/EvaluatorProvider.ts";
import { MAX_REVISION_ATTEMPTS } from "../lib/security/SecurityPolicy.ts";
import type { RubricCriteria } from "@prisma/client";
import { prisma } from "../lib/prisma.ts";

/** Whitelisted cUSD (Celo MAINNET, chain 42220) address from SecurityPolicy. */
const WHITELISTED = "0x765de816845861e75a25fca122bb6898b8b1282a";
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const GOOD_CID = `Qm${"a".repeat(44)}`;

function taskInput(overrides: Record<string, unknown> = {}) {
  return CreateTaskRequestSchema.parse({
    title: "Stage 5B review regression",
    description: "AI evaluation review regression task",
    rewardAmount: "5",
    rewardToken: WHITELISTED,
    creator: REQUESTER, // ignored by the server; session identity wins
    criteria: [
      { description: "Criterion A", weight: 5, order: 0 },
      { description: "Criterion B", weight: 5, order: 1 },
    ],
    ...overrides,
  });
}

/** create -> claim -> submit -> deterministic validation -> UNDER_REVIEW. */
async function underReviewTask() {
  const task = await createTask(REQUESTER, taskInput());
  const claim = await claimTask(task.id, WORKER);
  if (!claim.ok) throw new Error("claim failed in test setup");
  const sub = await submitWork(
    { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
    WORKER
  );
  if (!sub.ok) throw new Error("submit failed in test setup");
  const validation = await validateSubmission(task.id, REQUESTER);
  if (!validation.ok) throw new Error("validation failed in test setup");
  const criteria = await prisma.rubricCriteria.findMany({
    where: { taskId: task.id },
    orderBy: { order: "asc" },
  });
  return { task, submissionId: sub.data.id, criteria };
}

/** Settlement rows RESTRICT task deletion — remove them first. */
async function deleteTask(taskId: string) {
  await prisma.settlement.deleteMany({ where: { taskId } }).catch(() => {});
  await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
}

/** A full-pass APPROVE payload for the given rubric. */
function approvePayload(criteria: RubricCriteria[], overrides: Record<string, unknown> = {}) {
  return {
    decision: "APPROVE",
    criterionResults: criteria.map((c) => ({
      criterionId: c.id,
      satisfied: true,
      score: 100,
      reasoning: "Satisfies the criterion",
    })),
    overallFeedback: "All criteria satisfied",
    ...overrides,
  };
}

function providerFor(raw: unknown) {
  return new StaticEvaluatorProvider("test-stub", "test-model", raw);
}

// ─── 1. Pure deterministic resolution layer ────────────────────

const RUBRIC = [{ id: "c1" }, { id: "c2" }];

function fullResults(satisfied: boolean[] = [true, true]) {
  return RUBRIC.map((c, i) => ({
    criterionId: c.id,
    satisfied: satisfied[i] ?? true,
  }));
}

test("resolution: a fully-supported APPROVE becomes APPROVED", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults(),
    submissionStatus: "PENDING",
    revisionCount: 0,
  });
  assert.equal(r.decision, "APPROVED");
  assert.equal(r.downgraded, false);
  assert.equal(r.reason, null);
  assert.equal(r.policyChecks.every((c) => c.passed), true);
});

test("resolution: APPROVE with a missing criterion is downgraded", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults().slice(0, 1),
    submissionStatus: "PENDING",
    revisionCount: 0,
  });
  assert.equal(r.decision, "REQUEST_REVISION");
  assert.equal(r.downgraded, true);
  assert.equal(r.reason, "approval_policy_denied");
  assert.ok(!r.policyChecks.find((c) => c.id === "all_criteria_covered")!.passed);
});

test("resolution: APPROVE with a partially-satisfied criterion is downgraded", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults([true, false]),
    submissionStatus: "PENDING",
    revisionCount: 0,
  });
  assert.equal(r.decision, "REQUEST_REVISION");
  assert.equal(r.downgraded, true);
  assert.ok(!r.policyChecks.find((c) => c.id === "all_criteria_satisfied")!.passed);
});

test("resolution: APPROVE with unknown criteria is downgraded", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: [...fullResults(), { criterionId: "bogus", satisfied: true }],
    submissionStatus: "PENDING",
    revisionCount: 0,
  });
  assert.equal(r.decision, "REQUEST_REVISION");
  assert.ok(!r.policyChecks.find((c) => c.id === "no_unknown_criteria")!.passed);
});

test("resolution: APPROVE of a non-PENDING submission is downgraded", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults(),
    submissionStatus: "APPROVED",
    revisionCount: 0,
  });
  assert.equal(r.decision, "REQUEST_REVISION");
  assert.ok(!r.policyChecks.find((c) => c.id === "submission_is_pending")!.passed);
});

test("resolution: REQUEST_REVISION with an exhausted budget becomes REJECTED", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "REQUEST_REVISION",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults(),
    submissionStatus: "PENDING",
    revisionCount: MAX_REVISION_ATTEMPTS,
  });
  assert.equal(r.decision, "REJECTED");
  assert.equal(r.reason, "revision_budget_exhausted");
  assert.equal(r.downgraded, true);

  // A fully-supported APPROVE needs no revision budget: it is still APPROVED.
  const approve = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults(),
    submissionStatus: "PENDING",
    revisionCount: MAX_REVISION_ATTEMPTS,
  });
  assert.equal(approve.decision, "APPROVED");

  // But a policy-denied APPROVE with no budget left cannot downgrade to a
  // revision — it deterministically becomes REJECTED.
  const denied = resolveAuthoritativeDecision({
    modelDecision: "APPROVE",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults([true, false]),
    submissionStatus: "PENDING",
    revisionCount: MAX_REVISION_ATTEMPTS,
  });
  assert.equal(denied.decision, "REJECTED");
  assert.equal(denied.reason, "revision_budget_exhausted");
});

test("resolution: REJECT is honored as REJECTED without downgrade", () => {
  const r = resolveAuthoritativeDecision({
    modelDecision: "REJECT",
    rubricCriteria: RUBRIC,
    criterionResults: fullResults(),
    submissionStatus: "PENDING",
    revisionCount: 0,
  });
  assert.equal(r.decision, "REJECTED");
  assert.equal(r.downgraded, false);
  assert.equal(r.reason, null);
});

test("resolution: pure and deterministic — identical input, identical output", () => {
  const input = {
    modelDecision: "APPROVE" as const,
    rubricCriteria: RUBRIC,
    criterionResults: fullResults(),
    submissionStatus: "PENDING",
    revisionCount: 0,
  };
  assert.deepEqual(
    resolveAuthoritativeDecision(input),
    resolveAuthoritativeDecision(input)
  );
});

// ─── 2. Review service (workflow integration) ──────────────────

test("APPROVE review is advisory: PENDING_HUMAN_CONFIRMATION, then creator confirmation and settlement", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    const review = await reviewSubmission(
      task.id,
      REQUESTER,
      providerFor(approvePayload(criteria))
    );
    assert.equal(review.ok, true);
    if (review.ok) {
      // The AI review can NEVER authorize payment directly.
      assert.equal(review.data.decision, "PENDING_HUMAN_CONFIRMATION");
      assert.equal(review.data.outcome, "PENDING_HUMAN_CONFIRMATION");
      assert.equal(review.data.downgraded, false);
      assert.equal(review.data.recommendation, "APPROVE");
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING", "review does not approve");

    // REGRESSION: the settlement gate refuses an unconfirmed submission —
    // the AI review endpoint cannot release funds by itself.
    const premature = await requestSettlement(submissionId, WORKER);
    assert.equal(premature.ok, false);
    if (!premature.ok) {
      assert.equal(premature.status, 409);
      assert.ok(premature.reason.startsWith("submission_not_approved:"));
    }

    // Truthful audit: recommendation AND decision AND provider identifiers.
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_COMPLETED" },
    });
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payload ?? "{}");
    assert.equal(payload.recommendation, "APPROVE");
    // The truthful audit: the deterministic policy verdict is APPROVED; the
    // system outcome is PENDING_HUMAN_CONFIRMATION (no submission write).
    assert.equal(payload.decision, "APPROVED");
    assert.equal(payload.outcome, "PENDING_HUMAN_CONFIRMATION");
    assert.equal(payload.providerId, "test-stub");
    assert.equal(payload.modelId, "test-model");
    assert.equal(payload.submissionId, submissionId);
    assert.equal(payload.criterionResults.length, criteria.length);
    assert.equal(events[0].actor, REQUESTER);

    // HUMAN CONFIRMATION: only the creator's explicit action approves.
    const confirmation = await confirmApproval(task.id, REQUESTER);
    assert.equal(confirmation.ok, true);
    if (confirmation.ok) {
      assert.equal(confirmation.data.status, "APPROVED");
      assert.equal(confirmation.data.submissionId, submissionId);
    }
    const confirmedSub = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(confirmedSub?.status, "APPROVED");
    const confirmedEvents = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "APPROVAL_CONFIRMED" },
    });
    assert.equal(confirmedEvents.length, 1);
    assert.equal(confirmedEvents[0].actor, REQUESTER);

    // Regression: the hardened Stage 4.2 settlement path still authorizes
    // after human confirmation (server-derived recipient/amount).
    const settlement = await requestSettlement(submissionId, WORKER);
    assert.equal(settlement.ok, true);
    if (settlement.ok) {
      assert.equal(settlement.data.recipient, WORKER);
      assert.equal(settlement.data.amount, "5");
    }
    const settled = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(settled?.status, "SETTLING");
  } finally {
    await deleteTask(task.id);
  }
});

test("REQUEST_REVISION: delegates to the existing revision workflow", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    const payload = approvePayload(criteria, { decision: "REQUEST_REVISION" });
    const review = await reviewSubmission(task.id, REQUESTER, providerFor(payload));
    assert.equal(review.ok, true);
    if (review.ok) {
      assert.equal(review.data.decision, "REQUEST_REVISION");
      assert.equal(review.data.outcome, "REVISION_REQUESTED");
      assert.equal(review.data.downgraded, false);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "IN_PROGRESS");
    assert.equal(fresh?.revisionCount, 1);
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "SUPERSEDED");
    const revisionEvents = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "REVISION_REQUESTED" },
    });
    assert.equal(revisionEvents.length, 1, "existing workflow audited it");
    const evalEvents = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_COMPLETED" },
    });
    assert.equal(evalEvents.length, 1);
    assert.equal(JSON.parse(evalEvents[0].payload ?? "{}").outcome, "REVISION_REQUESTED");

    // Regression through the existing workflow: resubmit and re-validate.
    const resub = await submitWork(
      { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
      WORKER
    );
    assert.equal(resub.ok, true);
    const validation = await validateSubmission(task.id, REQUESTER);
    assert.equal(validation.ok, true);
  } finally {
    await deleteTask(task.id);
  }
});

test("REJECT: task and submission are terminally REJECTED", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    const payload = approvePayload(criteria, { decision: "REJECT" });
    const review = await reviewSubmission(task.id, REQUESTER, providerFor(payload));
    assert.equal(review.ok, true);
    if (review.ok) {
      assert.equal(review.data.decision, "REJECTED");
      assert.equal(review.data.outcome, "TASK_REJECTED");
      assert.equal(review.data.downgraded, false);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "REJECTED");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "REJECTED");
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_COMPLETED" },
    });
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].payload ?? "{}").outcome, "TASK_REJECTED");
  } finally {
    await deleteTask(task.id);
  }
});

test("malformed AI output: nothing is applied, never an implicit approve", async () => {
  const { task, submissionId } = await underReviewTask();
  try {
    const review = await reviewSubmission(
      task.id,
      REQUESTER,
      providerFor({ nonsense: true, decision: "APPROVE" })
    );
    assert.equal(review.ok, false);
    if (!review.ok) {
      assert.equal(review.reason, "malformed_model_output");
      assert.equal(review.status, 502);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING");
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_REJECTED" },
    });
    assert.equal(rejected.length, 1);
    const payload = JSON.parse(rejected[0].payload ?? "{}");
    assert.equal(payload.reason, "malformed_model_output");
    assert.equal(payload.providerId, "test-stub");
  } finally {
    await deleteTask(task.id);
  }
});

test("AI APPROVE with a missing criterion is downgraded, never approved", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    const payload = approvePayload(criteria);
    payload.criterionResults = payload.criterionResults.slice(0, 1);
    const review = await reviewSubmission(task.id, REQUESTER, providerFor(payload));
    assert.equal(review.ok, true);
    if (review.ok) {
      assert.equal(review.data.recommendation, "APPROVE");
      assert.equal(review.data.decision, "REQUEST_REVISION");
      assert.equal(review.data.downgraded, true);
      assert.equal(review.data.reason, "approval_policy_denied");
    }
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.notEqual(submission?.status, "APPROVED");
  } finally {
    await deleteTask(task.id);
  }
});

test("AI APPROVE with a partially-satisfied criterion is downgraded", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    const payload = approvePayload(criteria);
    (payload.criterionResults[1] as { satisfied: boolean }).satisfied = false;
    const review = await reviewSubmission(task.id, REQUESTER, providerFor(payload));
    assert.equal(review.ok, true);
    if (review.ok) {
      assert.equal(review.data.decision, "REQUEST_REVISION");
      assert.equal(review.data.reason, "approval_policy_denied");
    }
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.notEqual(submission?.status, "APPROVED");
  } finally {
    await deleteTask(task.id);
  }
});

test("REQUEST_REVISION with an exhausted budget deterministically becomes REJECTED", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    await prisma.task.update({
      where: { id: task.id },
      data: { revisionCount: MAX_REVISION_ATTEMPTS },
    });
    const payload = approvePayload(criteria, { decision: "REQUEST_REVISION" });
    const review = await reviewSubmission(task.id, REQUESTER, providerFor(payload));
    assert.equal(review.ok, true);
    if (review.ok) {
      assert.equal(review.data.decision, "REJECTED");
      assert.equal(review.data.reason, "revision_budget_exhausted");
      assert.equal(review.data.downgraded, true);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "REJECTED");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "REJECTED");
  } finally {
    await deleteTask(task.id);
  }
});

test("a superseded submission is never evaluated", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "SUPERSEDED" },
    });
    const review = await reviewSubmission(
      task.id,
      REQUESTER,
      providerFor(approvePayload(criteria))
    );
    assert.equal(review.ok, false);
    if (!review.ok) {
      assert.equal(review.reason, "no_eligible_submission");
      assert.equal(review.status, 409);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_REJECTED" },
    });
    assert.equal(rejected.length, 1);
    assert.equal(JSON.parse(rejected[0].payload ?? "{}").reason, "no_eligible_submission");
  } finally {
    await deleteTask(task.id);
  }
});

test("unauthorized reviewers cannot review and mutate nothing", async () => {
  const { task, criteria } = await underReviewTask();
  try {
    for (const actor of [STRANGER, WORKER]) {
      const review = await reviewSubmission(
        task.id,
        actor,
        providerFor(approvePayload(criteria))
      );
      assert.equal(review.ok, false);
      if (!review.ok) {
        assert.equal(review.reason, "forbidden");
        assert.equal(review.status, 403);
      }
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    // The 403 path writes no audit events.
    const events = await prisma.taskEvent.findMany({
      where: {
        taskId: task.id,
        eventType: { in: ["EVALUATION_COMPLETED", "EVALUATION_REJECTED"] },
      },
    });
    assert.equal(events.length, 0);
  } finally {
    await deleteTask(task.id);
  }
});

test("concurrent reviews are advisory; confirmation is the single authority", async () => {
  const { task, submissionId, criteria } = await underReviewTask();
  try {
    const provider = providerFor(approvePayload(criteria));
    // Both concurrent reviews may record their (identical, advisory)
    // evaluations — neither can approve anything.
    const results = await Promise.all([
      reviewSubmission(task.id, REQUESTER, provider),
      reviewSubmission(task.id, REQUESTER, provider),
    ]);
    for (const r of results) {
      if (r.ok) {
        assert.equal(r.data.decision, "PENDING_HUMAN_CONFIRMATION");
      } else {
        assert.equal(r.status, 409);
      }
    }
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING", "no review can approve");

    // The SINGLE authoritative outcome is the guarded human confirmation.
    const confirmations = await Promise.all([
      confirmApproval(task.id, REQUESTER),
      confirmApproval(task.id, REQUESTER),
    ]);
    const winners = confirmations.filter((c) => c.ok && c.data.status === "APPROVED");
    const already = confirmations.filter((c) => c.ok && c.data.status === "ALREADY_CONFIRMED");
    const losers = confirmations.filter((c) => !c.ok);
    assert.equal(
      winners.length + already.length + losers.length,
      2,
      "exactly one winner (the other is idempotent or a clean conflict)"
    );
    const confirmed = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(confirmed?.status, "APPROVED", "approved exactly once");
    const confirmedEvents = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "APPROVAL_CONFIRMED" },
    });
    assert.equal(confirmedEvents.length, 1, "one authoritative confirmation record");
  } finally {
    await deleteTask(task.id);
  }
});

test("no provider configured: review fails safe with no state change", async () => {
  const { task, submissionId } = await underReviewTask();
  try {
    const review = await reviewSubmission(task.id, REQUESTER, null);
    assert.equal(review.ok, false);
    if (!review.ok) {
      assert.equal(review.reason, "evaluation_unavailable");
      assert.equal(review.status, 503);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING");
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_REJECTED" },
    });
    assert.equal(rejected.length, 1);
    assert.equal(JSON.parse(rejected[0].payload ?? "{}").reason, "evaluation_unavailable");
  } finally {
    await deleteTask(task.id);
  }
});

test("a task that is not UNDER_REVIEW cannot be reviewed", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const review = await reviewSubmission(task.id, REQUESTER, providerFor({}));
    assert.equal(review.ok, false);
    if (!review.ok) {
      assert.equal(review.status, 409);
      assert.ok(review.reason.startsWith("task_not_under_review:"));
    }
  } finally {
    await deleteTask(task.id);
  }
});