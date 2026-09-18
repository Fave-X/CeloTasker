import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
  requestRevision,
  getTaskForActor,
  listMyTasks,
} from "../lib/workflow/TaskService.ts";
import { MAX_REVISION_ATTEMPTS } from "../lib/security/SecurityPolicy.ts";
import { prisma } from "../lib/prisma.ts";

const ADDR = "0x874069fa1eb16d44d622f2e0ca254a81a1e0c679";
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";

function taskInput() {
  return CreateTaskRequestSchema.parse({
    title: "Submit a PR",
    description: "Full task description",
    rewardAmount: "500000000000000000",
    rewardToken: ADDR,
    creator: REQUESTER, // ignored by the server; session identity wins
    criteria: [{ description: "Tests pass", weight: 5, order: 0 }],
  });
}

/** Full path: create -> claim, returning the task id. Caller must clean up. */
async function claimedTask(worker = WORKER) {
  const task = await createTask(REQUESTER, taskInput());
  const claim = await claimTask(task.id, worker);
  if (!claim.ok) throw new Error("claim failed in test setup");
  return task;
}

test("submission by the assigned worker succeeds", async () => {
  const task = await claimedTask();
  try {
    const result = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmWork" },
      WORKER
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.status, "PENDING");
      assert.equal(result.data.submitter, WORKER);
    }
    const updated = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(updated?.status, "SUBMITTED");
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("submission by a non-assigned worker is rejected and audited", async () => {
  const task = await claimedTask();
  try {
    const result = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmEvil" },
      STRANGER
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "not_assignee");

    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SUBMISSION_REJECTED" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, STRANGER);

    // Task state unchanged.
    const updated = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(updated?.status, "IN_PROGRESS");
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("submission after deadline is rejected", async () => {
  const input = taskInput();
  const task = await createTask(REQUESTER, {
    ...input,
    // Headroom for the claim; the deadline must still be live at claim time
    // (the claim guard now enforces the deadline inside the database).
    deadline: new Date(Date.now() + 2000),
  });
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);

    // Let the deadline pass.
    await new Promise((r) => setTimeout(r, 2300));

    const result = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmLate" },
      WORKER
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "deadline_passed");
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("revision request: UNDER_REVIEW -> REVISION_REQUESTED -> IN_PROGRESS", async () => {
  const task = await claimedTask();
  try {
    await submitWork({ taskId: task.id, contentRef: "ipfs://QmWork" }, WORKER);
    // Simulate evaluation (AI arrives in a later stage).
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });

    const result = await requestRevision(task.id, REQUESTER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data?.status, "IN_PROGRESS");
      assert.equal(result.data?.revisionCount, 1);
    }
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("revision limit is enforced", async () => {
  const task = await claimedTask();
  try {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW", revisionCount: MAX_REVISION_ATTEMPTS },
    });

    const result = await requestRevision(task.id, REQUESTER);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "revision_limit_reached");

    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "REVISION_LIMIT_REACHED" },
    });
    assert.equal(events.length, 1);
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("worker can resubmit after a revision request", async () => {
  const task = await claimedTask();
  try {
    await submitWork({ taskId: task.id, contentRef: "ipfs://QmV1" }, WORKER);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });
    const rev = await requestRevision(task.id, REQUESTER);
    assert.equal(rev.ok, true);

    const resub = await submitWork(
      { taskId: task.id, contentRef: "ipfs://QmV2" },
      WORKER
    );
    assert.equal(resub.ok, true);
    if (resub.ok) assert.equal(resub.data.contentRef, "ipfs://QmV2");
    const updated = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(updated?.status, "SUBMITTED");
    assert.equal(updated?.revisionCount, 1);
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("unrelated users cannot access private task details", async () => {
  const task = await claimedTask();
  try {
    const stranger = await getTaskForActor(task.id, STRANGER);
    assert.equal(stranger.ok, false);
    if (!stranger.ok) assert.equal(stranger.reason, "forbidden");

    const requester = await getTaskForActor(task.id, REQUESTER);
    assert.equal(requester.ok, true);
    const worker = await getTaskForActor(task.id, WORKER);
    assert.equal(worker.ok, true);
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("listMyTasks returns only relevant tasks", async () => {
  const created = await createTask(REQUESTER, taskInput());
  const claimed = await claimedTask();
  try {
    const mine = await listMyTasks(REQUESTER);
    const ids = mine.map((t) => t.id);
    assert.ok(ids.includes(created.id));
    assert.ok(ids.includes(claimed.id));

    const workerTasks = await listMyTasks(WORKER);
    assert.ok(workerTasks.map((t) => t.id).includes(claimed.id));
    assert.ok(!workerTasks.map((t) => t.id).includes(created.id));
  } finally {
    await prisma.task.delete({ where: { id: created.id } });
    await prisma.task.delete({ where: { id: claimed.id } });
  }
});

test("protected fields cannot be set through input (tampering)", async () => {
  const input = CreateTaskRequestSchema.parse({
    title: "T",
    description: "D",
    rewardAmount: "1",
    rewardToken: ADDR,
    creator: REQUESTER,
    criteria: [{ description: "c", weight: 1, order: 0 }],
    status: "SETTLED",
    id: "forged",
    revisionCount: 99,
    createdAt: "2000-01-01T00:00:00Z",
  });
  assert.equal("status" in input, false);
  assert.equal("id" in input, false);
  assert.equal("revisionCount" in input, false);
  assert.equal("createdAt" in input, false);

  // The service derives status/counters server-side regardless.
  const task = await createTask(REQUESTER, input);
  try {
    assert.equal(task.status, "OPEN");
    assert.equal(task.revisionCount, 0);
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});
