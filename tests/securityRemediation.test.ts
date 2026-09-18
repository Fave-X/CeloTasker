/**
 * CeloTasker — Stage 4.1 security remediation regression tests.
 *
 * Covers:
 * 1. Revision authorization (creator-only; strangers and workers get 403).
 * 2. Directed task claiming (designated worker wins; others and the creator
 *    are rejected; atomic double-claim protection preserved).
 * 3. Deadline enforcement inside the database guards + deterministic lazy
 *    expiry of OPEN / ASSIGNED / IN_PROGRESS tasks (no scheduler).
 * 4. Deterministic 409 conflict handling for concurrent submission/revision
 *    with no partial records.
 * 5. State-machine enforcement through the service (no illegal transitions).
 * 6. Submission versioning: earlier submissions are SUPERSEDED atomically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
  requestRevision,
  getTaskForActor,
  listOpenTasks,
} from "../lib/workflow/TaskService.ts";
import { MAX_REVISION_ATTEMPTS } from "../lib/security/SecurityPolicy.ts";
import { prisma } from "../lib/prisma.ts";

const ADDR = "0x874069fa1eb16d44d622f2e0ca254a81a1e0c679";
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const OTHER_WORKER = "0x4444444444444444444444444444444444444444";

function taskInput(overrides: Record<string, unknown> = {}) {
  return CreateTaskRequestSchema.parse({
    title: "Stage 4.1 regression",
    description: "Security remediation regression task",
    rewardAmount: "1000000000000000000",
    rewardToken: ADDR,
    creator: REQUESTER, // ignored by the server; session identity wins
    criteria: [{ description: "Criterion", weight: 5, order: 0 }],
    ...overrides,
  });
}

/** create -> claim. Caller must clean up. */
async function claimedTask() {
  const task = await createTask(REQUESTER, taskInput());
  const claim = await claimTask(task.id, WORKER);
  if (!claim.ok) throw new Error("claim failed in test setup");
  return task;
}

/** create -> claim -> submit -> (simulated) UNDER_REVIEW. Caller cleans up. */
async function underReviewTask() {
  const task = await claimedTask();
  const sub = await submitWork({ taskId: task.id, contentRef: "ipfs://QmV1" }, WORKER);
  if (!sub.ok) throw new Error("submit failed in test setup");
  // Simulate evaluation (AI arrives in a later stage).
  await prisma.task.update({
    where: { id: task.id },
    data: { status: "UNDER_REVIEW" },
  });
  return task;
}

async function deleteTask(taskId: string) {
  await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
}

// ─── 1. Revision authorization ────────────────────────────────

test("revision by an unrelated user is rejected with 403 and no state change", async () => {
  const task = await underReviewTask();
  try {
    const result = await requestRevision(task.id, STRANGER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "forbidden");
      assert.equal(result.status, 403);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
    assert.equal(fresh?.revisionCount, 0);
  } finally {
    await deleteTask(task.id);
  }
});

test("revision by the assigned worker is rejected with 403", async () => {
  const task = await underReviewTask();
  try {
    const result = await requestRevision(task.id, WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "forbidden");
      assert.equal(result.status, 403);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "UNDER_REVIEW");
  } finally {
    await deleteTask(task.id);
  }
});

test("revision by the creator succeeds and the max revision limit is preserved", async () => {
  const task = await underReviewTask();
  try {
    for (let i = 0; i < MAX_REVISION_ATTEMPTS; i++) {
      const result = await requestRevision(task.id, REQUESTER);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.status, "IN_PROGRESS");
        assert.equal(result.data.revisionCount, i + 1);
      }
      // Worker resubmits, then (simulated) evaluation returns it to review.
      const resub = await submitWork(
        { taskId: task.id, contentRef: `ipfs://QmRev${i}` },
        WORKER
      );
      assert.equal(resub.ok, true);
      await prisma.task.update({
        where: { id: task.id },
        data: { status: "UNDER_REVIEW" },
      });
    }
    const exhausted = await requestRevision(task.id, REQUESTER);
    assert.equal(exhausted.ok, false);
    if (!exhausted.ok) {
      assert.equal(exhausted.reason, "revision_limit_reached");
      assert.equal(exhausted.status, 409);
    }
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 2. Directed task claiming ─────────────────────────────────

test("designated worker can claim a directed task", async () => {
  const task = await createTask(REQUESTER, taskInput({ assignee: WORKER }));
  try {
    const result = await claimTask(task.id, WORKER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.status, "IN_PROGRESS");
      assert.equal(result.data.assignee, WORKER);
    }
  } finally {
    await deleteTask(task.id);
  }
});

test("another worker cannot claim a task designated for someone else", async () => {
  const task = await createTask(REQUESTER, taskInput({ assignee: WORKER }));
  try {
    const result = await claimTask(task.id, OTHER_WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "already_assigned");
      assert.equal(result.status, 403);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "OPEN", "task must remain unclaimed");
    assert.equal(fresh?.assignee, WORKER, "designation must not be overwritten");
  } finally {
    await deleteTask(task.id);
  }
});

test("creator cannot claim their own task", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const result = await claimTask(task.id, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "creator_cannot_claim");
      assert.equal(result.status, 403);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "OPEN");
    assert.equal(fresh?.assignee, null);
  } finally {
    await deleteTask(task.id);
  }
});

test("concurrent claims on a directed task: designated worker wins, others rejected", async () => {
  const task = await createTask(REQUESTER, taskInput({ assignee: WORKER }));
  try {
    const results = await Promise.all([
      claimTask(task.id, WORKER),
      claimTask(task.id, OTHER_WORKER),
    ]);
    assert.equal(results[0].ok, true, "designated worker must win the race");
    assert.equal(results[1].ok, false, "other worker must be rejected");
    if (!results[1].ok) {
      assert.equal(results[1].reason, "already_assigned");
      assert.equal(results[1].status, 403);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.assignee, WORKER);
    assert.equal(fresh?.status, "IN_PROGRESS");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 3. Deadline / expiry ──────────────────────────────────────

test("claiming an expired OPEN task fails with 410 and lazily expires it", async () => {
  const task = await createTask(
    REQUESTER,
    taskInput({ deadline: new Date(Date.now() - 1000) })
  );
  try {
    const result = await claimTask(task.id, WORKER);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "expired");
      assert.equal(result.status, 410);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "EXPIRED");
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "TASK_EXPIRED" },
    });
    assert.equal(events.length, 1);
  } finally {
    await deleteTask(task.id);
  }
});

test("EXPIRED is terminal: no service path can revive an expired task", async () => {
  const task = await createTask(
    REQUESTER,
    taskInput({ deadline: new Date(Date.now() - 1000) })
  );
  try {
    const first = await claimTask(task.id, WORKER);
    assert.equal(first.ok, false);
    const second = await claimTask(task.id, WORKER);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "not_open");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "EXPIRED");
  } finally {
    await deleteTask(task.id);
  }
});

test("listOpenTasks lazily expires and never lists expired OPEN tasks", async () => {
  const live = await createTask(REQUESTER, taskInput());
  const dead = await createTask(
    REQUESTER,
    taskInput({ deadline: new Date(Date.now() - 1000) })
  );
  try {
    const listed = await listOpenTasks();
    const ids = listed.map((t) => t.id);
    assert.ok(ids.includes(live.id));
    assert.ok(!ids.includes(dead.id), "expired task must not be advertised");
    const fresh = await prisma.task.findUnique({ where: { id: dead.id } });
    assert.equal(fresh?.status, "EXPIRED");
  } finally {
    await deleteTask(live.id);
    await deleteTask(dead.id);
  }
});

test("submission after the deadline fails, expires the task and leaves no records", async () => {
  const task = await createTask(
    REQUESTER,
    // Headroom for the claim; the deadline must still be live at claim time
    // (the claim guard now enforces the deadline inside the database).
    taskInput({ deadline: new Date(Date.now() + 2000) })
  );
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    // Let the deadline pass between the claim and the submission.
    await new Promise((r) => setTimeout(r, 2300));
    const result = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmLate" },
      WORKER
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "deadline_passed");
      assert.equal(result.status, 410);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "EXPIRED", "expired in-flight work must be recovered");
    const submissions = await prisma.submission.findMany({
      where: { taskId: task.id },
    });
    assert.equal(submissions.length, 0, "no submission record may be created");
  } finally {
    await deleteTask(task.id);
  }
});

test("expired ASSIGNED/IN_PROGRESS tasks are recovered deterministically on read", async () => {
  const task = await createTask(
    REQUESTER,
    taskInput({ deadline: new Date(Date.now() - 1000) })
  );
  try {
    // Simulate in-flight work whose deadline passed (no scheduler).
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "IN_PROGRESS", assignee: WORKER },
    });
    const view = await getTaskForActor(task.id, REQUESTER);
    assert.equal(view.ok, true);
    if (view.ok) assert.equal(view.data.status, "EXPIRED");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "EXPIRED");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 4. Concurrent submission / revision conflicts ─────────────

test("concurrent duplicate submissions: one wins, the loser gets a 409 and no partial records", async () => {
  const task = await claimedTask();
  try {
    const results = await Promise.all([
      submitWork({ taskId: task.id, contentRef: "ipfs://QmA" }, WORKER),
      submitWork({ taskId: task.id, contentRef: "ipfs://QmB" }, WORKER),
    ]);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one submission must succeed");
    const loser = results.find((r) => !r.ok);
    assert.ok(loser, "the losing request must receive a result, not a throw");
    if (loser && !loser.ok) {
      assert.equal(loser.status, 409);
      assert.equal(loser.reason, "task_state_conflict");
    }
    const submissions = await prisma.submission.findMany({
      where: { taskId: task.id },
    });
    assert.equal(submissions.length, 1, "no partial/duplicate records may remain");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SUBMITTED");
  } finally {
    await deleteTask(task.id);
  }
});

test("concurrent revision requests: one wins, the loser gets a 409, count is exact", async () => {
  const task = await underReviewTask();
  try {
    const results = await Promise.all([
      requestRevision(task.id, REQUESTER),
      requestRevision(task.id, REQUESTER),
    ]);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one revision must apply");
    const loser = results.find((r) => !r.ok);
    assert.ok(loser, "the losing request must receive a result, not a throw");
    if (loser && !loser.ok) {
      assert.equal(loser.status, 409);
    }
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "IN_PROGRESS");
    assert.equal(fresh?.revisionCount, 1, "the budget consumed exactly one attempt");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 5. State-machine enforcement through the service ─────────

test("no service path can illegally move a SUBMITTED task", async () => {
  const task = await claimedTask();
  try {
    const sub = await submitWork({ taskId: task.id, contentRef: "ipfs://QmX" }, WORKER);
    assert.equal(sub.ok, true);

    // Every mutating service call must refuse; none may change the status.
    const claim = await claimTask(task.id, OTHER_WORKER);
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.reason, "not_open");

    const submit = await submitWork({ taskId: task.id, contentRef: "ipfs://QmY" }, WORKER);
    assert.equal(submit.ok, false);
    if (!submit.ok) assert.ok(submit.reason.startsWith("task_not_in_progress:"));

    const revision = await requestRevision(task.id, REQUESTER);
    assert.equal(revision.ok, false);
    if (!revision.ok) {
      assert.ok(revision.reason.startsWith("task_not_under_review:"));
    }

    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SUBMITTED");
    const submissions = await prisma.submission.findMany({
      where: { taskId: task.id },
    });
    assert.equal(submissions.length, 1, "rejected duplicate left no records");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── 6. Submission versioning ──────────────────────────────────

test("previous submissions are superseded atomically when a revision is requested", async () => {
  const task = await underReviewTask();
  try {
    const first = await prisma.submission.findFirst({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(first?.status, "PENDING");

    const rev = await requestRevision(task.id, REQUESTER);
    assert.equal(rev.ok, true);

    const superseded = await prisma.submission.findUnique({
      where: { id: first!.id },
    });
    assert.equal(
      superseded?.status,
      "SUPERSEDED",
      "earlier revision attempts must not remain valid"
    );
    assert.equal(
      (await prisma.submission.findMany({
        where: { taskId: task.id, status: "PENDING" },
      })).length,
      0,
      "no earlier submission may remain PENDING after a revision"
    );

    // The latest valid submission is unambiguous after resubmission.
    const resub = await submitWork({ taskId: task.id, contentRef: "ipfs://QmV2" }, WORKER);
    assert.equal(resub.ok, true);
    const pending = await prisma.submission.findMany({
      where: { taskId: task.id, status: "PENDING" },
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].contentRef, "ipfs://QmV2");
  } finally {
    await deleteTask(task.id);
  }
});