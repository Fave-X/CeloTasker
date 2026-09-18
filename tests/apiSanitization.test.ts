import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFileMetadata } from "../lib/validation/FileValidation.ts";
import { UPLOAD_POLICY } from "../lib/security/SecurityPolicy.ts";
import {
  serializeTask,
  serializeSubmission,
  serializeSettlement,
} from "../lib/api/serialize.ts";

// ─── File metadata validation ────────────────────────────────

test("allowed file metadata passes", () => {
  assert.deepEqual(
    validateFileMetadata({
      filename: "solution.png",
      sizeBytes: 1024,
      mimeType: "image/png",
    }),
    { ok: true }
  );
  assert.deepEqual(
    validateFileMetadata({
      filename: "writeup.pdf",
      sizeBytes: 5 * 1024 * 1024,
      mimeType: "application/pdf",
    }),
    { ok: true }
  );
});

test("rejected file metadata is refused", () => {
  const rejects = (input: Parameters<typeof validateFileMetadata>[0]) =>
    assert.equal(validateFileMetadata(input).ok, false);

  rejects({
    filename: "big.png",
    sizeBytes: UPLOAD_POLICY.MAX_FILE_BYTES + 1,
    mimeType: "image/png",
  });
  rejects({ filename: "a.png", sizeBytes: 10, mimeType: "application/x-msdownload" });
  rejects({ filename: "payload.exe", sizeBytes: 10, mimeType: "text/plain" });
  // SVG hosts scripts — blocked to prevent stored XSS
  rejects({ filename: "art.svg", sizeBytes: 10, mimeType: "image/png" });
  rejects({ filename: "archive.tar", sizeBytes: 10, mimeType: "application/zip" });
  rejects({ filename: "../evil.png", sizeBytes: 10, mimeType: "image/png" });
  rejects({ filename: "a\nb.png", sizeBytes: 10, mimeType: "image/png" });
  rejects({ filename: "", sizeBytes: 10, mimeType: "image/png" });
  rejects({ filename: "a.png", sizeBytes: -1, mimeType: "image/png" });
});

// ─── API response sanitization ───────────────────────────────

test("serializers expose only whitelisted fields", () => {
  const now = new Date();
  const task = {
    id: "t1",
    title: "T",
    description: "D",
    rewardAmount: "1",
    rewardToken: "0xabc",
    status: "CREATED",
    creator: "0xccc",
    assignee: null,
    revisionCount: 0, // internal — must NOT appear
    deadline: null,
    createdAt: now,
    updatedAt: now, // internal — must NOT appear
    criteria: [
      { id: "c1", taskId: "t1", description: "x", weight: 1, order: 0 },
    ],
  } as never;

  const publicTask = serializeTask(task);
  assert.deepEqual(Object.keys(publicTask).sort(), [
    "assignee", "createdAt", "creator", "criteria", "deadline", "description",
    "id", "rewardAmount", "rewardToken", "status", "title",
  ]);
  assert.deepEqual(Object.keys(publicTask.criteria[0]).sort(), [
    "description", "id", "order", "weight",
  ]);

  const submission = {
    id: "s1",
    taskId: "t1",
    submitter: "0xaaa",
    contentRef: "ipfs://x",
    status: "PENDING",
    score: null,
    createdAt: now,
  } as never;
  assert.deepEqual(Object.keys(serializeSubmission(submission)).sort(), [
    "contentRef", "createdAt", "id", "score", "status", "submitter", "taskId",
  ]);

  const settlement = {
    id: "st1",
    submissionId: "s1",
    taskId: "t1",
    recipient: "0xbbb",
    amount: "5",
    rewardToken: "0xabc",
    status: "PENDING",
    txHash: null,
    createdAt: now,
  } as never;
  const publicSettlement = serializeSettlement(settlement);
  assert.equal("txHash" in publicSettlement, false);
  assert.deepEqual(Object.keys(publicSettlement).sort(), [
    "amount", "createdAt", "id", "recipient", "rewardToken", "status",
    "submissionId", "taskId",
  ]);
});
