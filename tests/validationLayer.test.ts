/**
 * CeloTasker — Stage 5A deterministic validation layer tests.
 *
 * Covers:
 * 1. The pure validator (DeterministicValidator): valid/invalid content,
 *    missing/empty content, size bounds, scheme whitelist, well-formedness,
 *    submitter/deadline/rubric consistency, determinism, and the rule that
 *    a bare URL is NEVER treated as proof of evidence.
 * 2. The validation service (ValidationService): the SUBMITTED →
 *    UNDER_VALIDATION → UNDER_REVIEW flow, creator-only ACL, stale/superseded
 *    submissions, concurrency (exactly one winner), audit records, the
 *    deterministic REJECTED marking of invalid submissions, and the revision
 *    recovery loop.
 * 3. Regression: the validated flow remains compatible with the Stage 4.2
 *    settlement path and the Stage 4/4.1 revision invariants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RubricCriteria, Submission, Task } from "@prisma/client";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
  requestRevision,
} from "../lib/workflow/TaskService.ts";
import { validateSubmission } from "../lib/workflow/ValidationService.ts";
import { validateSubmissionContent } from "../lib/workflow/DeterministicValidator.ts";
import { requestSettlement } from "../lib/workflow/SettlementService.ts";
import { prisma } from "../lib/prisma.ts";

/** Whitelisted cUSD (Celo MAINNET, chain 42220) address from SecurityPolicy. */
const WHITELISTED = "0x765de816845861e75a25fca122bb6898b8b1282a";
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
/** CIDv0-shaped: "Qm" + 44 base58 characters. */
const GOOD_CID = `Qm${"a".repeat(44)}`;

function taskInput(overrides: Record<string, unknown> = {}) {
  return CreateTaskRequestSchema.parse({
    title: "Stage 5A validation regression",
    description: "Deterministic validation regression task",
    rewardAmount: "5",
    rewardToken: WHITELISTED,
    creator: REQUESTER, // ignored by the server; session identity wins
    criteria: [{ description: "Criterion", weight: 5, order: 0 }],
    ...overrides,
  });
}

/** create -> claim -> submit, returning the task and its submission id. */
async function submittedTask(contentRef: string) {
  const task = await createTask(REQUESTER, taskInput());
  const claim = await claimTask(task.id, WORKER);
  if (!claim.ok) throw new Error("claim failed in test setup");
  const sub = await submitWork({ taskId: task.id, contentRef }, WORKER);
  if (!sub.ok) throw new Error("submit failed in test setup");
  return { task, submissionId: sub.data.id };
}

/** Settlement rows RESTRICT task deletion — remove them first. */
async function deleteTask(taskId: string) {
  await prisma.settlement.deleteMany({ where: { taskId } }).catch(() => {});
  await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
}

// ─── 1. Pure deterministic validator (unit level) ─────────────

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeCriterion(overrides: Partial<RubricCriteria> = {}): RubricCriteria {
  return {
    id: "c1",
    taskId: "task-1",
    description: "criterion",
    weight: 5,
    order: 0,
    ...overrides,
  } as RubricCriteria;
}

function makeTask(
  overrides: Partial<Task> = {},
  criteria: RubricCriteria[] = [makeCriterion()]
): Task & { criteria: RubricCriteria[] } {
  return {
    id: "task-1",
    title: "T",
    description: "D",
    rewardAmount: "1",
    rewardToken: WHITELISTED,
    status: "SUBMITTED",
    creator: REQUESTER,
    assignee: WORKER,
    revisionCount: 0,
    deadline: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    criteria,
  } as Task & { criteria: RubricCriteria[] };
}

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1",
    taskId: "task-1",
    submitter: WORKER,
    contentRef: `ipfs://${GOOD_CID}`,
    status: "PENDING",
    score: null,
    createdAt: NOW,
    ...overrides,
  } as Submission;
}

test("validator: a well-formed ipfs submission is valid, with all checks passing", () => {
  const result = validateSubmissionContent(makeTask(), makeSubmission());
  assert.equal(result.valid, true);
  assert.deepEqual(result.failureReasons, []);
  assert.equal(result.checks.every((c) => c.passed), true);
  assert.equal(result.checks.length, 7);
  assert.equal(result.submissionId, "sub-1");
  assert.equal(result.taskId, "task-1");
  assert.ok(result.validatedAt.length > 0);
});

test("validator: a well-formed https submission is valid", () => {
  const result = validateSubmissionContent(
    makeTask(),
    makeSubmission({ contentRef: "https://example.com/work.zip" })
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.failureReasons, []);
});

test("validator: whitespace-only content fails deterministically", () => {
  const result = validateSubmissionContent(makeTask(), makeSubmission({ contentRef: "   " }));
  assert.equal(result.valid, false);
  assert.ok(result.failureReasons.includes("content_ref_present"));
  const failed = result.checks.find((c) => c.id === "content_ref_present");
  assert.equal(failed?.detail, "content_ref_missing");
});

test("validator: oversized content fails the size bound", () => {
  const result = validateSubmissionContent(
    makeTask(),
    makeSubmission({ contentRef: "a".repeat(2049) })
  );
  assert.equal(result.valid, false);
  assert.ok(result.failureReasons.includes("content_ref_size"));
});

test("validator: disallowed schemes are rejected", () => {
  for (const ref of ["ftp://example.com/x", "file:///etc/passwd", "not-a-uri"]) {
    const result = validateSubmissionContent(makeTask(), makeSubmission({ contentRef: ref }));
    assert.equal(result.valid, false, ref);
    assert.ok(result.failureReasons.includes("content_ref_scheme_allowed"), ref);
  }
});

test("validator: malformed references fail well-formedness", () => {
  // NOTE: "https:///path" is intentionally NOT listed — the WHATWG URL
  // parser skips extra slashes and treats it as host "path", so it is a
  // syntactically valid URL and passes structural validation.
  for (const ref of ["ipfs://not-a-cid", "ipfs://", "https://", "https://[invalid"]) {
    const result = validateSubmissionContent(makeTask(), makeSubmission({ contentRef: ref }));
    assert.equal(result.valid, false, ref);
    assert.ok(result.failureReasons.includes("content_ref_well_formed"), ref);
  }
});

test("validator: submitter/deadline/rubric consistency is enforced", () => {
  // Wrong submitter (defense in depth — the workflow also enforces this).
  const submitter = validateSubmissionContent(
    makeTask(),
    makeSubmission({ submitter: STRANGER })
  );
  assert.equal(submitter.valid, false);
  assert.ok(submitter.failureReasons.includes("submitter_is_assignee"));

  // Submitted after the deadline.
  const late = validateSubmissionContent(
    makeTask({ deadline: NOW }),
    makeSubmission({ createdAt: new Date("2026-01-02T00:00:00.000Z") })
  );
  assert.equal(late.valid, false);
  assert.ok(late.failureReasons.includes("submitted_within_deadline"));

  // Missing rubric and malformed rubric (weight out of bounds).
  const rubric = validateSubmissionContent(makeTask({}, []), makeSubmission());
  assert.equal(rubric.valid, false);
  assert.ok(rubric.failureReasons.includes("rubric_present"));
  const badRubric = validateSubmissionContent(
    makeTask({}, [makeCriterion({ weight: 0 })]),
    makeSubmission()
  );
  assert.equal(badRubric.valid, false);
  assert.ok(badRubric.failureReasons.includes("rubric_present"));
});

test("validator: a bare URL is NEVER proof of evidence (contentProven is always false)", () => {
  const validUrl = validateSubmissionContent(
    makeTask(),
    makeSubmission({ contentRef: "https://evidence.example.com/proof.png" })
  );
  // Structural validation passes, but the validator explicitly records that
  // the content is unproven — verification belongs to the review stage.
  assert.equal(validUrl.valid, true);
  assert.equal(validUrl.contentProven, false);
  // No check ever claims the referenced content exists or matches the rubric.
  assert.equal(validUrl.checks.some((c) => c.id.includes("content_verified")), false);
  const invalid = validateSubmissionContent(makeTask(), makeSubmission({ contentRef: " " }));
  assert.equal(invalid.contentProven, false);
});

test("validator: pure and deterministic — identical input yields identical output", () => {
  const task = makeTask();
  const submission = makeSubmission();
  const first = validateSubmissionContent(task, submission);
  const second = validateSubmissionContent(task, submission);
  assert.deepEqual(first.checks, second.checks);
  assert.deepEqual(first.failureReasons, second.failureReasons);
  assert.equal(first.valid, second.valid);
});

// ─── 2. Validation service (workflow integration) ──────────────

test("valid submission: SUBMITTED -> UNDER_VALIDATION -> UNDER_REVIEW with audit", async () => {
  const { task, submissionId } = await submittedTask(`ipfs://${GOOD_CID}`);
  try {
    const result = await validateSubmission(task.id, REQUESTER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.valid, true);
      assert.deepEqual(result.data.failureReasons, []);
      assert.equal(result.data.submissionId, submissionId);
      assert.equal(result.data.taskId, task.id);
      assert.equal(result.data.contentProven, false);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING", "validation never approves content");

    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "VALIDATION_STARTED" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, REQUESTER);
    const payload = JSON.parse(events[0].payload ?? "{}");
    assert.equal(payload.valid, true);
    assert.equal(payload.submissionId, submissionId);
    assert.equal(payload.path, "SUBMITTED -> UNDER_VALIDATION -> UNDER_REVIEW");
    assert.equal(payload.checks.length, 7);
    assert.equal(payload.contentProven, false);
  } finally {
    await deleteTask(task.id);
  }
});

test("invalid submission: deterministic REJECTED marking and truthful audit", async () => {
  const { task, submissionId } = await submittedTask("   ");
  try {
    const result = await validateSubmission(task.id, REQUESTER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.valid, false);
      assert.ok(result.data.failureReasons.includes("content_ref_present"));
    }
    // The only legal exit from SUBMITTED is UNDER_REVIEW (frozen machine);
    // the invalid submission is deterministically REJECTED inside it.
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "REJECTED");
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "VALIDATION_STARTED" },
    });
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payload ?? "{}");
    assert.equal(payload.valid, false);
    assert.ok(payload.failureReasons.includes("content_ref_present"));
  } finally {
    await deleteTask(task.id);
  }
});

test("disallowed scheme submission is rejected by the service flow", async () => {
  const { task, submissionId } = await submittedTask("ftp://example.com/x");
  try {
    const result = await validateSubmission(task.id, REQUESTER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.valid, false);
      assert.ok(result.data.failureReasons.includes("content_ref_scheme_allowed"));
    }
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "REJECTED");
  } finally {
    await deleteTask(task.id);
  }
});

test("unauthorized actors cannot trigger validation and mutate nothing", async () => {
  const { task } = await submittedTask(`ipfs://${GOOD_CID}`);
  try {
    for (const actor of [STRANGER, WORKER]) {
      const result = await validateSubmission(task.id, actor);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "forbidden");
        assert.equal(result.status, 403);
      }
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SUBMITTED", "task state must be unchanged");
    // The 403 path writes no audit events — strangers cannot pollute the trail.
    const events = await prisma.taskEvent.findMany({
      where: {
        taskId: task.id,
        eventType: { in: ["VALIDATION_STARTED", "VALIDATION_REJECTED"] },
      },
    });
    assert.equal(events.length, 0);
  } finally {
    await deleteTask(task.id);
  }
});

test("a task that is not SUBMITTED cannot be validated", async () => {
  const { task } = await submittedTask(`ipfs://${GOOD_CID}`);
  try {
    const first = await validateSubmission(task.id, REQUESTER);
    assert.equal(first.ok, true);
    const second = await validateSubmission(task.id, REQUESTER);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.status, 409);
      assert.ok(second.reason.startsWith("task_not_submitted:"));
    }
    assert.equal(
      (await prisma.taskEvent.findMany({
        where: { taskId: task.id, eventType: "VALIDATION_STARTED" },
      })).length,
      1,
      "no second validation may be recorded"
    );
  } finally {
    await deleteTask(task.id);
  }
});

test("a superseded submission is never eligible for review", async () => {
  const { task, submissionId } = await submittedTask(`ipfs://${GOOD_CID}`);
  try {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "SUPERSEDED" },
    });
    const result = await validateSubmission(task.id, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_eligible_submission");
      assert.equal(result.status, 409);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SUBMITTED", "no transition may be applied");
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "VALIDATION_REJECTED" },
    });
    assert.equal(rejected.length, 1);
    assert.equal(JSON.parse(rejected[0].payload ?? "{}").reason, "no_eligible_submission");
  } finally {
    await deleteTask(task.id);
  }
});

test("concurrent validations produce exactly one authoritative result", async () => {
  const { task, submissionId } = await submittedTask(`ipfs://${GOOD_CID}`);
  try {
    const results = await Promise.all([
      validateSubmission(task.id, REQUESTER),
      validateSubmission(task.id, REQUESTER),
    ]);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one validation must apply");
    const loser = results.find((r) => !r.ok);
    assert.ok(loser, "the losing request must receive a result, not a throw");
    if (loser && !loser.ok) {
      assert.equal(loser.status, 409);
      assert.equal(loser.reason, "task_state_conflict");
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    const started = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "VALIDATION_STARTED" },
    });
    assert.equal(started.length, 1, "one authoritative validation record");
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "VALIDATION_REJECTED" },
    });
    assert.ok(rejected.length >= 1, "the loser is audited");
    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    assert.equal(submission?.status, "PENDING");
  } finally {
    await deleteTask(task.id);
  }
});

test("invalid -> revision -> resubmit -> valid: the deterministic recovery loop", async () => {
  const { task, submissionId } = await submittedTask("   ");
  try {
    const invalid = await validateSubmission(task.id, REQUESTER);
    assert.equal(invalid.ok, true);
    if (invalid.ok) assert.equal(invalid.data.valid, false);

    // The creator requests a revision; the worker resubmits valid content.
    const rev = await requestRevision(task.id, REQUESTER);
    assert.equal(rev.ok, true);
    const stale = await prisma.submission.findUnique({ where: { id: submissionId } });
    // The invalid submission was already REJECTED by deterministic validation
    // — a terminal, non-payable state, so revision leaves it untouched (only
    // PENDING/APPROVED attempts are superseded).
    assert.equal(stale?.status, "REJECTED");

    const resub = await submitWork(
      { taskId: task.id, contentRef: `ipfs://${GOOD_CID}` },
      WORKER
    );
    assert.equal(resub.ok, true);

    const valid = await validateSubmission(task.id, REQUESTER);
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.data.valid, true);
      assert.equal(valid.data.submissionId, resub.data.id);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    assert.equal(fresh?.revisionCount, 1, "revision invariants preserved");
  } finally {
    await deleteTask(task.id);
  }
});

test("regression: a validated submission remains settleable via the Stage 4.2 path", async () => {
  const { task, submissionId } = await submittedTask(`ipfs://${GOOD_CID}`);
  try {
    const validation = await validateSubmission(task.id, REQUESTER);
    assert.equal(validation.ok, true);
    // Deterministic validation NEVER approves — simulate the (later) review
    // approval, then confirm the hardened settlement path still authorizes.
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "APPROVED" },
    });
    const settlement = await requestSettlement(submissionId, WORKER);
    assert.equal(settlement.ok, true);
    if (settlement.ok) {
      assert.equal(settlement.data.recipient, WORKER);
      assert.equal(settlement.data.amount, "5");
      assert.equal(settlement.data.status, "PENDING");
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
  } finally {
    await deleteTask(task.id);
  }
});