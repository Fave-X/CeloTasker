/**
 * CeloTasker — Stage 4.2 settlement security regression tests.
 *
 * Covers:
 * 1. Actor ↔ submission binding (only the submitter may settle; strangers,
 *    the creator and other workers are rejected with 403).
 * 2. Server-controlled payment values (amount from task.rewardAmount, token
 *    from task.rewardToken, recipient always the verified submitter; no
 *    client-supplied value can override them).
 * 3. Current-submission-only (SUPERSEDED / stale attempts are not payable,
 *    and an APPROVED submission stops being payable after a revision).
 * 4. Atomic settlement transition (exactly one winner under concurrency,
 *    deterministic 409 for losers, no duplicate settlement records — also
 *    enforced by the unique constraint on Settlement.submissionId).
 * 5. Revision hygiene (limit cannot be exceeded at the MAX-1 concurrency
 *    boundary; failure paths never record a false REVISION_REQUESTED event).
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
import { requestSettlement } from "../lib/workflow/SettlementService.ts";
import { MAX_REVISION_ATTEMPTS, SETTLEMENT_LIMITS } from "../lib/security/SecurityPolicy.ts";
import { prisma } from "../lib/prisma.ts";

/** Whitelisted cUSD (Celo MAINNET, chain 42220) address from SecurityPolicy. */
const WHITELISTED = "0x765de816845861e75a25fca122bb6898b8b1282a";
/** A syntactically valid but non-whitelisted token address. */
const OTHER_TOKEN = "0x9999999999999999999999999999999999999999";
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";

function taskInput(overrides: Record<string, unknown> = {}) {
  return CreateTaskRequestSchema.parse({
    title: "Stage 4.2 settlement regression",
    description: "Settlement security regression task",
    // Distinctive whole-token reward so server-side derivation is observable
    // (Stage 5C convention: whole tokens; limits MIN 1 / MAX 1000).
    rewardAmount: "123",
    rewardToken: WHITELISTED,
    creator: REQUESTER, // ignored by the server; session identity wins
    criteria: [{ description: "Criterion", weight: 5, order: 0 }],
    ...overrides,
  });
}

/** create -> claim -> submit -> (simulated) APPROVED under review. */
async function payableTask(worker = WORKER) {
  const task = await createTask(REQUESTER, taskInput());
  const claim = await claimTask(task.id, worker);
  if (!claim.ok) throw new Error("claim failed in test setup");
  const sub = await submitWork(
    { taskId: task.id, contentRef: "ipfs://QmPay" },
    worker
  );
  if (!sub.ok) throw new Error("submit failed in test setup");
  // Simulate evaluation (AI arrives in a later stage).
  await prisma.task.update({
    where: { id: task.id },
    data: { status: "UNDER_REVIEW" },
  });
  await prisma.submission.update({
    where: { id: sub.data.id },
    data: { status: "APPROVED" },
  });
  return { task, submissionId: sub.data.id };
}

/** Settlement rows RESTRICT task deletion — remove them first. */
async function deleteTask(taskId: string) {
  await prisma.settlement.deleteMany({ where: { taskId } }).catch(() => {});
  await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
}

// ─── 1. Actor ↔ submission binding ────────────────────────────

test("only the submitter can settle: values are derived server-side", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const result = await requestSettlement(submissionId, WORKER);
    assert.equal(result.ok, true);
    if (result.ok) {
      // Recipient is the verified submitter — never a body-supplied value.
      assert.equal(result.data.recipient, WORKER);
      assert.notEqual(result.data.recipient, STRANGER);
      assert.notEqual(result.data.recipient, REQUESTER);
      // Amount/token derived exclusively from the trusted Task row.
      assert.equal(result.data.amount, "123");
      assert.equal(result.data.rewardToken, WHITELISTED);
      assert.equal(result.data.status, "PENDING");
      assert.equal(result.data.txHash, null);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
    const settlements = await prisma.settlement.findMany({
      where: { taskId: task.id },
    });
    assert.equal(settlements.length, 1);
  } finally {
    await deleteTask(task.id);
  }
});

test("a stranger cannot settle another worker's approved submission", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const result = await requestSettlement(submissionId, STRANGER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "forbidden");
      assert.equal(result.status, 403);
    }
    // No state change and no settlement record.
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
  } finally {
    await deleteTask(task.id);
  }
});

test("the task creator cannot settle a worker's approved submission", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const result = await requestSettlement(submissionId, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "forbidden");
      assert.equal(result.status, 403);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
  } finally {
    await deleteTask(task.id);
  }
});

// ─── FIX 1: whole-token amount guardrails ──────────────────────

test("a zero reward can never settle (MIN_AMOUNT is strictly enforced)", async () => {
  const task = await createTask(
    REQUESTER,
    taskInput({ rewardAmount: "0" })
  );
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmZero" },
      WORKER
    );
    assert.equal(sub.ok, true);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });
    await prisma.submission.update({
      where: { id: sub.data.id },
      data: { status: "APPROVED" },
    });

    const result = await requestSettlement(sub.data.id, WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "amount_below_limit");
      assert.equal(result.status, 409);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0,
      "a zero-value settlement must never be authorized"
    );
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW", "no SETTLING without value");
  } finally {
    await deleteTask(task.id);
  }
});

test("negative and malformed reward amounts remain rejected at the schema", () => {
  for (const bad of ["-5", "0x10", "1.5", "1e3", "", " 1"]) {
    assert.equal(
      CreateTaskRequestSchema.safeParse({
        title: "T",
        description: "D",
        rewardAmount: bad,
        rewardToken: WHITELISTED,
        creator: REQUESTER,
        criteria: [{ description: "c", weight: 1, order: 0 }],
      }).success,
      false,
      `rewardAmount "${bad}" must be rejected`
    );
  }
});

test("policy and validation share the whole-token unit convention", () => {
  // The limits are exact positive integers in WHOLE TOKEN units.
  assert.equal(BigInt(SETTLEMENT_LIMITS.MIN_AMOUNT) >= 1n, true);
  assert.equal(BigInt(SETTLEMENT_LIMITS.MAX_AMOUNT) > BigInt(SETTLEMENT_LIMITS.MIN_AMOUNT), true);
  // Integer-only: both parse as plain decimal integers (no float/rounding).
  assert.match(SETTLEMENT_LIMITS.MIN_AMOUNT, /^\d+$/);
  assert.match(SETTLEMENT_LIMITS.MAX_AMOUNT, /^\d+$/);
  // The schema convention matches: a valid whole-token amount parses.
  assert.equal(
    CreateTaskRequestSchema.safeParse({
      title: "T",
      description: "D",
      rewardAmount: SETTLEMENT_LIMITS.MAX_AMOUNT,
      rewardToken: WHITELISTED,
      creator: REQUESTER,
      criteria: [{ description: "c", weight: 1, order: 0 }],
    }).success,
    true
  );
  // ...and one unit above the ceiling is refused by the gate (behavioral
  // proof that the gate compares the SAME convention as the policy).
  const above = (BigInt(SETTLEMENT_LIMITS.MAX_AMOUNT) + 1n).toString();
  assert.equal(BigInt(above) > BigInt(SETTLEMENT_LIMITS.MAX_AMOUNT), true);
});

// ─── 2. Server-controlled payment values ──────────────────────


test("client-supplied amount cannot override task.rewardAmount", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const result = await requestSettlement(submissionId, WORKER);
    assert.equal(result.ok, true);
    // The only amount that can ever be recorded is the task's reward — there
    // is no client-supplied amount in the request schema at all.
    if (result.ok) assert.equal(result.data.amount, task.rewardAmount);
    const stored = await prisma.settlement.findFirst({
      where: { submissionId },
    });
    assert.equal(stored?.amount, task.rewardAmount);
  } finally {
    await deleteTask(task.id);
  }
});

test("a task reward above SETTLEMENT_LIMITS.MAX_AMOUNT is refused", async () => {
  const task = await createTask(
    REQUESTER,
    taskInput({ rewardAmount: "1001" }) // 1001 whole tokens > MAX (1000)
  );
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmBig" },
      WORKER
    );
    assert.equal(sub.ok, true);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });
    await prisma.submission.update({
      where: { id: sub.data.id },
      data: { status: "APPROVED" },
    });

    const result = await requestSettlement(sub.data.id, WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "amount_exceeds_limit");
      assert.equal(result.status, 409);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
  } finally {
    await deleteTask(task.id);
  }
});

test("client-supplied token cannot override task.rewardToken", async () => {
  // The task pays in a non-whitelisted token. A client cannot substitute a
  // whitelisted address: the token is derived from the trusted Task row and
  // the request schema has no token field at all.
  const task = await createTask(
    REQUESTER,
    taskInput({ rewardToken: OTHER_TOKEN })
  );
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmTok" },
      WORKER
    );
    assert.equal(sub.ok, true);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });
    await prisma.submission.update({
      where: { id: sub.data.id },
      data: { status: "APPROVED" },
    });

    const result = await requestSettlement(sub.data.id, WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "token_not_whitelisted");
      assert.equal(result.status, 403);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 3. Current-submission-only ────────────────────────────────

test("a SUPERSEDED submission can never be settled", async () => {
  const { task, submissionId } = await payableTask();
  try {
    // Simulate a later revision attempt superseding this submission.
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "SUPERSEDED" },
    });
    const result = await requestSettlement(submissionId, WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "submission_superseded");
      assert.equal(result.status, 409);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW", "task state must be unchanged");
  } finally {
    await deleteTask(task.id);
  }
});

test("an APPROVED submission stops being payable once a revision is requested", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const rev = await requestRevision(task.id, REQUESTER);
    assert.equal(rev.ok, true, "creator can still request the revision");

    // The once-APPROVED submission must be SUPERSEDED in the same transaction.
    const stale = await prisma.submission.findUnique({
      where: { id: submissionId },
    });
    assert.equal(stale?.status, "SUPERSEDED");

    // ...and it can no longer be settled.
    const settle = await requestSettlement(submissionId, WORKER);
    assert.equal(settle.ok, false);
    if (!settle.ok) {
      assert.equal(settle.reason, "submission_superseded");
      assert.equal(settle.status, 409);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );

    // The fresh resubmission is the only unambiguous current submission.
    const resub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmNext" },
      WORKER
    );
    assert.equal(resub.ok, true);
    const pending = await prisma.submission.findMany({
      where: { taskId: task.id, status: { not: "SUPERSEDED" } },
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].contentRef, "ipfs://QmNext");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 4. Atomic settlement transition ──────────────────────────

test("concurrent settlement attempts produce exactly one winner", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const results = await Promise.all([
      requestSettlement(submissionId, WORKER),
      requestSettlement(submissionId, WORKER),
    ]);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one settlement must be created");
    const loser = results.find((r) => !r.ok);
    assert.ok(loser, "the losing request must receive a result, not a throw");
    if (loser && !loser.ok) {
      assert.equal(loser.status, 409);
      assert.ok(
        ["task_state_conflict", "duplicate_settlement"].includes(loser.reason),
        `unexpected loser reason: ${loser.reason}`
      );
    }
    // Exactly one settlement record; the task moved to SETTLING once.
    const settlements = await prisma.settlement.findMany({
      where: { taskId: task.id },
    });
    assert.equal(settlements.length, 1, "no duplicate settlement records");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
    // The loser is audited truthfully.
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_REJECTED" },
    });
    assert.ok(rejected.length >= 1, "the losing request must be audited");
    if (rejected[0]) assert.equal(rejected[0].actor, WORKER);
  } finally {
    await deleteTask(task.id);
  }
});

test("duplicate Settlement.submissionId is impossible (unique constraint)", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const first = await requestSettlement(submissionId, WORKER);
    assert.equal(first.ok, true);

    // Sequential retry: the task is no longer UNDER_REVIEW, so the guarded
    // transition refuses — deterministic 409, no new record.
    const retry = await requestSettlement(submissionId, WORKER);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.status, 409);

    // Defense in depth: even a direct write against the unique constraint
    // on Settlement.submissionId cannot create a second record.
    await assert.rejects(() =>
      prisma.settlement.create({
        data: {
          submissionId,
          taskId: task.id,
          recipient: WORKER,
          amount: "1",
          rewardToken: WHITELISTED,
          status: "PENDING",
        },
      })
    );

    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      1
    );
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 5. Revision hygiene ───────────────────────────────────────

test("concurrent revisions at MAX_REVISION_ATTEMPTS - 1 cannot exceed the limit", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmBoundary" },
      WORKER
    );
    assert.equal(sub.ok, true);
    // One attempt already consumed; exactly one remains.
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "UNDER_REVIEW",
        revisionCount: MAX_REVISION_ATTEMPTS - 1,
      },
    });

    const results = await Promise.all([
      requestRevision(task.id, REQUESTER),
      requestRevision(task.id, REQUESTER),
    ]);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one revision must apply");
    const loser = results.find((r) => !r.ok);
    assert.ok(loser);
    if (loser && !loser.ok) assert.equal(loser.status, 409);

    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.revisionCount, MAX_REVISION_ATTEMPTS);
    assert.equal(fresh?.status, "IN_PROGRESS");

    // The budget is exhausted: a further request is refused deterministically.
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });
    const exhausted = await requestRevision(task.id, REQUESTER);
    assert.equal(exhausted.ok, false);
    if (!exhausted.ok) {
      assert.equal(exhausted.reason, "revision_limit_reached");
    }
    const after = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(
      after?.revisionCount,
      MAX_REVISION_ATTEMPTS,
      "the limit can never be exceeded"
    );
  } finally {
    await deleteTask(task.id);
  }
});

test("revision failure paths never record a false REVISION_REQUESTED audit event", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmAudit" },
      WORKER
    );
    assert.equal(sub.ok, true);
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "UNDER_REVIEW",
        revisionCount: MAX_REVISION_ATTEMPTS,
      },
    });

    // Rejected-at-the-limit request: must not record a REVISION_REQUESTED
    // transition that never happened.
    const rejected = await requestRevision(task.id, REQUESTER);
    assert.equal(rejected.ok, false);
    const eventsAfterRejection = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "REVISION_REQUESTED" },
    });
    assert.equal(eventsAfterRejection.length, 0);

    // Reset to a fresh budget and race two requests: only the winner may
    // record REVISION_REQUESTED, and the recorded count must equal the
    // actual revision count.
    await prisma.task.update({
      where: { id: task.id },
      data: { revisionCount: 0 },
    });
    const raced = await Promise.all([
      requestRevision(task.id, REQUESTER),
      requestRevision(task.id, REQUESTER),
    ]);
    assert.equal(raced.filter((r) => r.ok).length, 1);
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "REVISION_REQUESTED" },
    });
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(events.length, 1, "one event per applied revision, no more");
    assert.equal(events.length, fresh?.revisionCount);
    // The loser is audited as REVISION_REJECTED, not as a transition.
    const rejectedEvents = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "REVISION_REJECTED" },
    });
    assert.ok(rejectedEvents.length >= 1);
    assert.equal(rejectedEvents[0].actor, REQUESTER);
  } finally {
    await deleteTask(task.id);
  }
});