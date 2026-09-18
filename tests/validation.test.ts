import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CreateTaskRequestSchema,
  CreateSubmissionRequestSchema,
  CreateSettlementRequestSchema,
} from "../lib/validation/ValidationSchemas.ts";

const ADDR = "0x874069fa1eb16d44d622f2e0ca254a81a1e0c679";
const ADDR2 = "0x1111111111111111111111111111111111111111";

const validTask = {
  title: "Build a dApp",
  description: "Full description here",
  rewardAmount: "1000000000000000000",
  rewardToken: ADDR,
  creator: ADDR2,
  criteria: [{ description: "Code compiles", weight: 5, order: 0 }],
};

test("valid task/submission/settlement payloads parse", () => {
  assert.ok(CreateTaskRequestSchema.safeParse(validTask).success);
  assert.ok(
    CreateSubmissionRequestSchema.safeParse({
      taskId: "abc",
      submitter: ADDR2,
      contentRef: "ipfs://Qm...",
    }).success
  );
  assert.ok(
    CreateSettlementRequestSchema.safeParse({
      submissionId: "abc",
      recipient: ADDR2,
      amount: "500",
      rewardToken: ADDR,
    }).success
  );
});

test("invalid Zod input is rejected", () => {
  // Bad EVM address
  assert.equal(
    CreateTaskRequestSchema.safeParse({ ...validTask, rewardToken: "0x123" })
      .success,
    false
  );
  // Amount must be a decimal integer string
  assert.equal(
    CreateTaskRequestSchema.safeParse({ ...validTask, rewardAmount: "1.5" })
      .success,
    false
  );
  assert.equal(
    CreateTaskRequestSchema.safeParse({ ...validTask, rewardAmount: "-5" })
      .success,
    false
  );
  // Criteria required, weight bounds enforced
  assert.equal(
    CreateTaskRequestSchema.safeParse({ ...validTask, criteria: [] }).success,
    false
  );
  assert.equal(
    CreateTaskRequestSchema.safeParse({
      ...validTask,
      criteria: [{ description: "x", weight: 0, order: 0 }],
    }).success,
    false
  );
  assert.equal(
    CreateTaskRequestSchema.safeParse({
      ...validTask,
      criteria: [{ description: "x", weight: 101, order: 0 }],
    }).success,
    false
  );
  // Empty title/description
  assert.equal(
    CreateTaskRequestSchema.safeParse({ ...validTask, title: "" }).success,
    false
  );
  // Submission: bad address
  assert.equal(
    CreateSubmissionRequestSchema.safeParse({
      taskId: "abc",
      submitter: "not-an-address",
      contentRef: "x",
    }).success,
    false
  );
  // Settlement: submission id is required (Stage 4.2 — recipient, amount and
  // rewardToken are no longer accepted from the body at all).
  assert.equal(
    CreateSettlementRequestSchema.safeParse({
      recipient: ADDR2,
      amount: "500",
      rewardToken: ADDR,
    }).success,
    false
  );
  // Missing fields entirely
  assert.equal(CreateSubmissionRequestSchema.safeParse({}).success, false);
  assert.equal(CreateSettlementRequestSchema.safeParse({}).success, false);
});

test("protected fields are stripped and never honored (tamper attempts)", () => {
  // Attempt to create a task already in a privileged state.
  const tamperedTask = CreateTaskRequestSchema.parse({
    ...validTask,
    status: "SETTLED",
    id: "forged-id",
    createdAt: "2000-01-01T00:00:00Z",
    updatedAt: "2000-01-01T00:00:00Z",
    revisionCount: 999,
    approved: true,
  });
  assert.equal("status" in tamperedTask, false);
  assert.equal("id" in tamperedTask, false);
  assert.equal("createdAt" in tamperedTask, false);
  assert.equal("updatedAt" in tamperedTask, false);
  assert.equal("revisionCount" in tamperedTask, false);
  assert.equal("approved" in tamperedTask, false);

  // Attempt to forge submission evaluation state.
  const tamperedSubmission = CreateSubmissionRequestSchema.parse({
    taskId: "abc",
    submitter: ADDR2,
    contentRef: "ipfs://Qm...",
    status: "APPROVED",
    score: 100,
    id: "forged",
    createdAt: "2000-01-01T00:00:00Z",
  });
  assert.equal("status" in tamperedSubmission, false);
  assert.equal("score" in tamperedSubmission, false);
  assert.equal("id" in tamperedSubmission, false);
  assert.equal("createdAt" in tamperedSubmission, false);

  // Attempt to forge settlement state / tx hash.
  const tamperedSettlement = CreateSettlementRequestSchema.parse({
    submissionId: "abc",
    recipient: ADDR2,
    amount: "500",
    rewardToken: ADDR,
    status: "EXECUTED",
    txHash:
      "0x" + "a".repeat(64),
    taskId: "forged-task",
    createdAt: "2000-01-01T00:00:00Z",
  });
  assert.equal("status" in tamperedSettlement, false);
  assert.equal("txHash" in tamperedSettlement, false);
  assert.equal("taskId" in tamperedSettlement, false);
  assert.equal("createdAt" in tamperedSettlement, false);
  // Stage 4.2: payment parameters are structurally stripped — a client cannot
  // even supply a recipient, amount or token, let alone override one.
  assert.equal("recipient" in tamperedSettlement, false);
  assert.equal("amount" in tamperedSettlement, false);
  assert.equal("rewardToken" in tamperedSettlement, false);
});
