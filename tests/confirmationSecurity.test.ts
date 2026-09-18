/**
 * CeloTasker — Human confirmation gate + evaluation timeout tests
 * (Stage 5C remediation, FIX 4 & FIX 5).
 *
 * FIX 5: the AI review NEVER authorizes payment. A policy-passed APPROVE is
 * recorded as PENDING_HUMAN_CONFIRMATION; only the creator's explicit,
 * authenticated confirmation (confirmApproval) marks the submission APPROVED,
 * after which the unchanged Stage 4.2 gate authorizes settlement.
 *
 * FIX 4: a hanging AI provider fails closed with a structured 504 — no state
 * change, no implicit approve, truthfully audited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
  requestRevision,
} from "../lib/workflow/TaskService.ts";
import { validateSubmission } from "../lib/workflow/ValidationService.ts";
import { reviewSubmission } from "../lib/workflow/ReviewService.ts";
import { confirmApproval } from "../lib/workflow/ConfirmationService.ts";
import { requestSettlement } from "../lib/workflow/SettlementService.ts";
import { StaticEvaluatorProvider } from "../lib/evaluation/EvaluatorProvider.ts";
import type { EvaluatorProvider } from "../lib/evaluation/EvaluatorProvider.ts";
import { SETTLEMENT_TOKEN_WHITELIST, CHAIN_IDS } from "../lib/security/SecurityPolicy.ts";
import { prisma } from "../lib/prisma.ts";

const WHITELISTED = SETTLEMENT_TOKEN_WHITELIST[CHAIN_IDS.CELO_MAINNET][0];
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const GOOD_CID = `Qm${"a".repeat(44)}`;

function taskInput(overrides: Record<string, unknown> = {}) {
  return CreateTaskRequestSchema.parse({
    title: "Stage 5C remediation regression",
    description: "Human confirmation gate regression task",
    rewardAmount: "7",
    rewardToken: WHITELISTED,
    creator: REQUESTER,
    criteria: [
      { description: "Criterion A", weight: 5, order: 0 },
      { description: "Criterion B", weight: 5, order: 1 },
    ],
    ...overrides,
  });
}

/** Approve payload for the task's real rubric. */
async function approvePayloadFor(taskId: string) {
  const criteria = await prisma.rubricCriteria.findMany({
    where: { taskId },
    orderBy: { order: "asc" },
  });
  return {
    decision: "APPROVE",
    criterionResults: criteria.map((c) => ({
      criterionId: c.id,
      satisfied: true,
      score: 100,
      reasoning: "Satisfies the criterion",
    })),
    overallFeedback: "All criteria satisfied",
  };
}

/** create -> claim -> submit -> validate -> review(APPROVE) — awaiting confirmation. */
async function pendingConfirmationTask() {
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
  const review = await reviewSubmission(
    task.id,
    REQUESTER,
    new StaticEvaluatorProvider(
      "test-stub",
      "test-model",
      await approvePayloadFor(task.id)
    )
  );
  if (!review.ok) throw new Error("review failed in test setup");
  return { task, submissionId: sub.data.id };
}

async function deleteTask(taskId: string) {
  await prisma.settlement.deleteMany({ where: { taskId } }).catch(() => {});
  await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
}

// ─── FIX 5: human confirmation gate ─────────────────────────────

test("creator confirmation succeeds and settlement remains correctly authorized", async () => {
  const { task, submissionId } = await pendingConfirmationTask();
  try {
    const confirmation = await confirmApproval(task.id, REQUESTER);
    assert.equal(confirmation.ok, true);
    if (confirmation.ok) {
      assert.equal(confirmation.data.status, "APPROVED");
      assert.equal(confirmation.data.submissionId, submissionId);
      assert.equal(confirmation.data.taskId, task.id);
    }
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "APPROVED");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW", "no new task state was invented");
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "APPROVAL_CONFIRMED" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, REQUESTER);
    const payload = JSON.parse(events[0].payload ?? "{}");
    assert.equal(payload.confirmedBy, REQUESTER);
    assert.equal(payload.recommendation, "APPROVE");

    // The client can never alter payment parameters: everything below is
    // server-derived by the unchanged Stage 4.2 gate.
    const settlement = await requestSettlement(submissionId, WORKER);
    assert.equal(settlement.ok, true);
    if (settlement.ok) {
      assert.equal(settlement.data.recipient, WORKER);
      assert.equal(settlement.data.amount, "7");
      assert.equal(settlement.data.rewardToken, WHITELISTED);
    }
  } finally {
    await deleteTask(task.id);
  }
});

test("the worker cannot confirm; a stranger cannot confirm", async () => {
  const { task, submissionId } = await pendingConfirmationTask();
  try {
    for (const actor of [WORKER, STRANGER]) {
      const result = await confirmApproval(task.id, actor);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "forbidden");
        assert.equal(result.status, 403);
      }
    }
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING", "nothing changed");
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "APPROVAL_CONFIRMED" },
    });
    assert.equal(events.length, 0);
  } finally {
    await deleteTask(task.id);
  }
});

test("confirmation without an AI approval fails", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
      WORKER
    );
    assert.equal(sub.ok, true);
    const validation = await validateSubmission(task.id, REQUESTER);
    assert.equal(validation.ok, true);

    const result = await confirmApproval(task.id, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_ai_evaluation");
      assert.equal(result.status, 409);
    }
    const submission = await prisma.submission.findUnique({ where: { id: sub.data.id } });
    assert.equal(submission?.status, "PENDING");
  } finally {
    await deleteTask(task.id);
  }
});

test("a stale evaluation can never confirm a newer submission", async () => {
  const { task, submissionId } = await pendingConfirmationTask();
  try {
    // The creator requests a revision: the evaluated submission is superseded
    // and the worker submits a NEW current submission.
    const rev = await requestRevision(task.id, REQUESTER);
    assert.equal(rev.ok, true);
    const stale = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(stale?.status, "SUPERSEDED");
    const resub = await submitWork(
      { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
      WORKER
    );
    assert.equal(resub.ok, true);
    await validateSubmission(task.id, REQUESTER);

    // The policy-passed APPROVE evaluation exists, but it is not for the
    // CURRENT submission — confirmation must refuse.
    const result = await confirmApproval(task.id, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_ai_evaluation");
      assert.equal(result.status, 409);
    }
    const current = await prisma.submission.findUnique({ where: { id: resub.data.id } });
    assert.equal(current?.status, "PENDING");
  } finally {
    await deleteTask(task.id);
  }
});

test("duplicate confirmation is idempotent and writes exactly one event", async () => {
  const { task, submissionId } = await pendingConfirmationTask();
  try {
    const first = await confirmApproval(task.id, REQUESTER);
    assert.equal(first.ok, true);
    const second = await confirmApproval(task.id, REQUESTER);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.data.status, "ALREADY_CONFIRMED");
      assert.equal(second.data.submissionId, submissionId);
    }
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "APPROVAL_CONFIRMED" },
    });
    assert.equal(events.length, 1, "exactly one authoritative record");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "APPROVED");
  } finally {
    await deleteTask(task.id);
  }
});

test("a policy-denied (downgraded) AI evaluation can never be confirmed", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
      WORKER
    );
    assert.equal(sub.ok, true);
    await validateSubmission(task.id, REQUESTER);
    const full = await approvePayloadFor(task.id);
    // APPROVE with one unsatisfied criterion → downgraded to REQUEST_REVISION.
    (full.criterionResults[1] as { satisfied: boolean }).satisfied = false;
    const review = await reviewSubmission(
      task.id,
      REQUESTER,
      new StaticEvaluatorProvider("test-stub", "test-model", full)
    );
    assert.equal(review.ok, true);
    if (review.ok) {
      assert.notEqual(review.data.decision, "PENDING_HUMAN_CONFIRMATION");
    }

    const result = await confirmApproval(task.id, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      // The downgrade consumed the revision workflow: the task is now
      // IN_PROGRESS, so confirmation is refused at the status gate — the
      // downgraded evaluation can never reach human confirmation.
      assert.ok(result.reason.startsWith("task_not_under_review:"), result.reason);
      assert.equal(result.status, 409);
    }
    const submission = await prisma.submission.findUnique({ where: { id: sub.data.id } });
    assert.notEqual(submission?.status, "APPROVED");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── FIX 4: evaluation timeout fails closed ─────────────────────

test("a hanging AI provider fails closed with a structured timeout", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
      WORKER
    );
    assert.equal(sub.ok, true);
    await validateSubmission(task.id, REQUESTER);

    const hangingProvider: EvaluatorProvider = {
      providerId: "hanging-stub",
      modelId: "hang-model",
      // NEVER resolves.
      evaluate: () => new Promise<unknown>(() => {}),
    };

    const started = Date.now();
    const review = await reviewSubmission(
      task.id,
      REQUESTER,
      hangingProvider,
      50 // short injected timeout for the test
    );
    const elapsed = Date.now() - started;
    assert.equal(review.ok, false);
    if (!review.ok) {
      assert.equal(review.reason, "evaluation_timeout");
      assert.equal(review.status, 504);
    }
    assert.ok(elapsed < 5000, "the request must not hang");

    // FAIL CLOSED: no state change, no implicit approve.
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const submission = await prisma.submission.findUnique({ where: { id: sub.data.id } });
    assert.equal(submission?.status, "PENDING");
    // Truthful audit of the timeout.
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "EVALUATION_REJECTED" },
    });
    assert.equal(rejected.length, 1);
    const payload = JSON.parse(rejected[0].payload ?? "{}");
    assert.equal(payload.reason, "evaluation_timeout");
    assert.equal(payload.providerId, "hanging-stub");
  } finally {
    await deleteTask(task.id);
  }
});