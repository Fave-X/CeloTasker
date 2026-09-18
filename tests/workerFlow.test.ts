import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  listOpenTasks,
  claimTask,
} from "../lib/workflow/TaskService.ts";
import { prisma } from "../lib/prisma.ts";

const ADDR = "0x874069fa1eb16d44d622f2e0ca254a81a1e0c679";
const WORKER1 = "0x1111111111111111111111111111111111111111";
const WORKER2 = "0x2222222222222222222222222222222222222222";
const WORKER3 = "0x4444444444444444444444444444444444444444";

function taskInput() {
  const input = {
    title: "Build a Celo dApp",
    description: "Full task description for the worker",
    rewardAmount: "1000000000000000000",
    rewardToken: ADDR,
    creator: ADDR, // ignored by the server; session identity wins
    criteria: [{ description: "Code compiles", weight: 5, order: 0 }],
  };
  // Mimic the route: all input passes the shared Zod schema first.
  return CreateTaskRequestSchema.parse(input);
}

test("task creation: authenticated flow reaches OPEN with audit trail", async () => {
  const task = await createTask(WORKER1, taskInput());
  try {
    assert.equal(task.status, "OPEN");
    assert.equal(task.creator, WORKER1);
    assert.equal(task.revisionCount, 0);
    assert.equal(task.criteria.length, 1);

    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      events.map((e) => e.eventType),
      ["TASK_CREATED", "TASK_OPENED"]
    );
    assert.equal(events[0].actor, WORKER1);
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("task discovery: only OPEN tasks are listed", async () => {
  const open = await createTask(WORKER1, taskInput());
  const claimed = await createTask(WORKER1, taskInput());
  try {
    // Move `claimed` out of OPEN as if a worker took it.
    await prisma.task.update({
      where: { id: claimed.id },
      data: { status: "IN_PROGRESS", assignee: WORKER2 },
    });

    const listed = await listOpenTasks();
    const ids = listed.map((t) => t.id);
    assert.ok(ids.includes(open.id));
    assert.ok(!ids.includes(claimed.id));
  } finally {
    await prisma.task.delete({ where: { id: open.id } });
    await prisma.task.delete({ where: { id: claimed.id } });
  }
});

test("successful claim: OPEN -> ASSIGNED -> IN_PROGRESS with audit", async () => {
  const task = await createTask(WORKER1, taskInput());
  try {
    const result = await claimTask(task.id, WORKER2);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.status, "IN_PROGRESS");
      assert.equal(result.data.assignee, WORKER2);
    }

    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: { in: ["TASK_ASSIGNED", "WORK_STARTED"] } },
    });
    assert.equal(events.length, 2);
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("double-claim race: only one worker wins", async () => {
  const task = await createTask(WORKER1, taskInput());
  try {
    // Two concurrent claims on the same task by eligible (non-creator) workers.
    const results = await Promise.all([
      claimTask(task.id, WORKER2),
      claimTask(task.id, WORKER3),
    ]);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one claim must succeed");

    const finalTask = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(finalTask?.assignee, winners[0].ok ? (winners[0] as { data: { assignee: string } }).data.assignee : null);
    assert.ok([WORKER2, WORKER3].includes(finalTask?.assignee ?? ""));
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("unauthorized claim: non-OPEN task cannot be claimed", async () => {
  const task = await createTask(WORKER1, taskInput());
  try {
    const first = await claimTask(task.id, WORKER2); // first claim succeeds
    assert.equal(first.ok, true);
    const second = await claimTask(task.id, WORKER3);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "not_open");
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});

test("expired task cannot be claimed", async () => {
  const input = taskInput();
  const task = await createTask(WORKER1, {
    ...input,
    deadline: new Date(Date.now() - 1000),
  });
  try {
    const result = await claimTask(task.id, WORKER2);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");
  } finally {
    await prisma.task.delete({ where: { id: task.id } });
  }
});
