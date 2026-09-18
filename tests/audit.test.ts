import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordTaskEvent,
  listTaskEvents,
} from "../lib/audit/AuditLog.ts";
import { prisma } from "../lib/prisma.ts";

let taskId: string;

beforeEach(async () => {
  const task = await prisma.task.create({
    data: {
      title: "audit-test",
      description: "audit test task",
      rewardAmount: "1",
      rewardToken: "0x874069fa1eb16d44d622f2e0ca254a81a1e0c679",
      status: "CREATED",
      creator: "0x00000000000000000000000000000000000000aa",
    },
  });
  taskId = task.id;
  return async () => {
    // Test cleanup only: removing the parent task cascades; production code
    // never updates or deletes TaskEvent rows.
    await prisma.task.delete({ where: { id: taskId } });
  };
});

test("audit events are append-only and can be created", async () => {
  const before = new Date();
  const event = await recordTaskEvent({
    taskId,
    eventType: "TASK_CREATED",
    actor: "0x00000000000000000000000000000000000000bb",
    metadata: { note: "creation", revisionCount: 0 },
  });

  assert.ok(event.id);
  assert.equal(event.taskId, taskId);
  assert.equal(event.eventType, "TASK_CREATED");
  assert.equal(event.actor, "0x00000000000000000000000000000000000000bb");
  assert.deepEqual(JSON.parse(event.payload ?? "{}"), {
    note: "creation",
    revisionCount: 0,
  });
  assert.ok(event.createdAt instanceof Date);
  // Timestamp is DB-generated, not caller-provided.
  assert.ok(event.createdAt.getTime() >= before.getTime() - 60_000);
});

test("actor defaults to system and metadata is optional", async () => {
  const event = await recordTaskEvent({ taskId, eventType: "TASK_OPENED" });
  assert.equal(event.actor, "system");
  assert.equal(event.payload, null);
});

test("events are listed chronologically per task", async () => {
  await recordTaskEvent({ taskId, eventType: "TASK_CREATED" });
  await recordTaskEvent({ taskId, eventType: "TASK_OPENED" });
  const events = await listTaskEvents(taskId);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.eventType), [
    "TASK_CREATED",
    "TASK_OPENED",
  ]);
});

test("audit module exposes no mutation operations", async () => {
  const mod = await import("../lib/audit/AuditLog.ts");
  const exports = Object.keys(mod).sort();
  // ONLY creation + read helpers. Update/delete must never appear here.
  assert.deepEqual(exports, ["listTaskEvents", "recordTaskEvent"]);
});
