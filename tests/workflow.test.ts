import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTransition,
  canTransition,
  resolveReviewDecision,
  toTaskStatus,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  type TaskStatus,
} from "../lib/workflow/TaskStatus.ts";
import { MAX_REVISION_ATTEMPTS } from "../lib/security/SecurityPolicy.ts";

test("happy-path lifecycle is fully legal", () => {
  const path: TaskStatus[] = [
    "CREATED",
    "OPEN",
    "ASSIGNED",
    "IN_PROGRESS",
    "SUBMITTED",
    "UNDER_VALIDATION",
    "UNDER_REVIEW",
    "SETTLING",
    "SETTLED",
    "COMPLETED",
  ];
  for (let i = 0; i < path.length - 1; i++) {
    assert.doesNotThrow(() => assertTransition(path[i], path[i + 1]));
  }
});

test("terminal and failure states are reachable", () => {
  assert.ok(canTransition("OPEN", "EXPIRED"));
  assert.ok(canTransition("ASSIGNED", "EXPIRED"));
  assert.ok(canTransition("IN_PROGRESS", "EXPIRED"));
  assert.ok(canTransition("UNDER_REVIEW", "REJECTED"));
  assert.ok(canTransition("SETTLING", "PAYMENT_FAILED"));
});

test("illegal transitions are rejected", () => {
  const illegal: [TaskStatus, TaskStatus][] = [
    ["CREATED", "SETTLED"],
    ["CREATED", "COMPLETED"],
    ["OPEN", "SETTLING"],
    ["SUBMITTED", "SETTLING"],
    ["IN_PROGRESS", "SETTLED"],
    ["UNDER_REVIEW", "OPEN"],
    ["SETTLED", "OPEN"],
    ["COMPLETED", "IN_PROGRESS"],
    ["REJECTED", "IN_PROGRESS"],
    ["EXPIRED", "OPEN"],
    ["PAYMENT_FAILED", "SETTLING"],
    ["SUBMITTED", "COMPLETED"],
  ];
  for (const [from, to] of illegal) {
    assert.throws(() => assertTransition(from, to), IllegalTransitionError);
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  }
});

test("no status can transition to arbitrary states", () => {
  for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
    for (const status of Object.keys(LEGAL_TRANSITIONS)) {
      const to = status as TaskStatus;
      if (!targets.includes(to)) {
        assert.equal(canTransition(from as TaskStatus, to), false);
      }
    }
  }
});

test("review decisions map deterministically", () => {
  assert.equal(resolveReviewDecision(0, "REQUEST_REVISION"), "REVISION_REQUESTED");
  assert.equal(resolveReviewDecision(1, "APPROVED"), "SETTLING");
  assert.equal(resolveReviewDecision(2, "REJECTED"), "REJECTED");
  // The full revision path is UNDER_REVIEW -> REVISION_REQUESTED -> IN_PROGRESS
  assert.ok(canTransition("REVISION_REQUESTED", "IN_PROGRESS"));
  assert.equal(canTransition("UNDER_REVIEW", "IN_PROGRESS"), false);
});

test("revision limit is enforced", () => {
  assert.equal(MAX_REVISION_ATTEMPTS > 0, true);
  // Each REQUEST_REVISION consumes one attempt.
  for (let count = 0; count < MAX_REVISION_ATTEMPTS; count++) {
    assert.equal(
      resolveReviewDecision(count, "REQUEST_REVISION"),
      "REVISION_REQUESTED"
    );
  }
  assert.throws(
    () => resolveReviewDecision(MAX_REVISION_ATTEMPTS, "REQUEST_REVISION"),
    /Revision limit reached/
  );
  // Approval is still possible after the revision budget is spent.
  assert.equal(
    resolveReviewDecision(MAX_REVISION_ATTEMPTS, "APPROVED"),
    "SETTLING"
  );
});

test("unknown stored statuses are rejected", () => {
  assert.throws(() => toTaskStatus("DRAFT"), /Unknown task status/);
  assert.equal(toTaskStatus("OPEN"), "OPEN");
});
