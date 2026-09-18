/**
 * CeloTasker — read-only frontend data-surface tests (UI Step 1).
 *
 * Covers the three approved read-only additions:
 *   GET /api/relayer           — public relayer facts for Approve & Relay
 *   GET /api/tasks/[id]/state  — ACL'd task-state bundle
 *   GET /api/tasks/[id]/events — ACL'd read-only audit trail
 *
 * Route handlers are invoked directly with real Requests and REAL sessions
 * (created through lib/auth/session), matching the existing test conventions.
 * No blockchain interaction; the relayer address is derived OFFLINE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
} from "../lib/workflow/TaskService.ts";
import { createSession } from "../lib/auth/session.ts";
import { SETTLEMENT_TOKEN_WHITELIST, CHAIN_IDS } from "../lib/security/SecurityPolicy.ts";
import { prisma } from "../lib/prisma.ts";
import { GET as relayerGET } from "../app/api/relayer/route.ts";
import { GET as stateGET } from "../app/api/tasks/[id]/state/route.ts";
import { GET as eventsGET } from "../app/api/tasks/[id]/events/route.ts";

const WHITELISTED = SETTLEMENT_TOKEN_WHITELIST[CHAIN_IDS.CELO_MAINNET][0];
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";

function taskInput() {
  return CreateTaskRequestSchema.parse({
    title: "UI state surface regression",
    description: "Read-only data surfaces for the frontend",
    rewardAmount: "1",
    rewardToken: WHITELISTED,
    creator: REQUESTER, // ignored by the server; session identity wins
    criteria: [{ description: "Criterion", weight: 5, order: 0 }],
  });
}

/** create -> claim -> submit (task IN_PROGRESS with a PENDING submission). */
async function claimedTaskWithSubmission(worker = WORKER) {
  const task = await createTask(REQUESTER, taskInput());
  const claim = await claimTask(task.id, worker);
  if (!claim.ok) throw new Error("claim failed in test setup");
  const sub = await submitWork({ taskId: task.id, contentRef: "ipfs://QmState" }, worker);
  if (!sub.ok) throw new Error("submit failed in test setup");
  return { task, submissionId: sub.data.id };
}

async function deleteTask(taskId: string) {
  await prisma.settlement.deleteMany({ where: { taskId } }).catch(() => {});
  await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
}

/** A Request carrying a real session cookie for the given address. */
async function authedRequest(url: string, address: string): Promise<Request> {
  const session = await createSession(address);
  return new Request(url, {
    headers: { cookie: `celo_tasker_session=${session.token}` },
  });
}

// ─── GET /api/relayer ────────────────────────────────────────

test("GET /api/relayer returns the derived public relayer facts", async () => {
  const response = await relayerGET(new Request("http://localhost/api/relayer"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    relayerAddress: string;
    chainId: number;
    token: string;
  };
  assert.match(body.relayerAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(body.chainId, CHAIN_IDS.CELO_MAINNET);
  assert.equal(body.token, WHITELISTED);
  // No secret material may ever appear in the payload.
  const text = JSON.stringify(body);
  const key = (process.env.AGENT_RELAYER_PRIVATE_KEY ?? "").trim();
  if (key) assert.equal(text.includes(key), false);
});

test("GET /api/relayer fails safe (503) when the relayer is unconfigured", async () => {
  const saved = process.env.AGENT_RELAYER_PRIVATE_KEY;
  delete process.env.AGENT_RELAYER_PRIVATE_KEY;
  try {
    const response = await relayerGET(new Request("http://localhost/api/relayer"));
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.equal("relayerAddress" in body, false);
  } finally {
    if (saved !== undefined) process.env.AGENT_RELAYER_PRIVATE_KEY = saved;
  }
});

// ─── GET /api/tasks/[id]/state ───────────────────────────────

test("state bundle: unauthenticated callers are rejected", async () => {
  const { task } = await claimedTaskWithSubmission();
  try {
    const response = await stateGET(
      new Request(`http://localhost/api/tasks/${task.id}/state`),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(response.status, 401);
  } finally {
    await deleteTask(task.id);
  }
});

test("state bundle: unrelated wallets get 403 and learn nothing", async () => {
  const { task } = await claimedTaskWithSubmission();
  try {
    const response = await stateGET(
      await authedRequest(`http://localhost/api/tasks/${task.id}/state`, STRANGER),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(response.status, 403);
  } finally {
    await deleteTask(task.id);
  }
});

test("state bundle: the creator sees task + current submission; nothing invented", async () => {
  const { task, submissionId } = await claimedTaskWithSubmission();
  try {
    const response = await stateGET(
      await authedRequest(`http://localhost/api/tasks/${task.id}/state`, REQUESTER),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      state: {
        task: { id: string; status: string; criteria: unknown[] };
        submission: { id: string; status: string } | null;
        validation: unknown;
        evaluation: unknown;
        settlement: unknown;
      };
    };
    assert.equal(body.state.task.id, task.id);
    assert.equal(body.state.task.status, "IN_PROGRESS");
    assert.equal(body.state.task.criteria.length, 1);
    assert.equal(body.state.submission?.id, submissionId);
    assert.equal(body.state.submission?.status, "PENDING");
    // Before validation/review/confirmation nothing may be synthesized.
    assert.equal(body.state.validation, null);
    assert.equal(body.state.evaluation, null);
    assert.equal(body.state.settlement, null);
  } finally {
    await deleteTask(task.id);
  }
});

test("state bundle: a current evaluation is surfaced; a stale one is hidden", async () => {
  const { task, submissionId } = await claimedTaskWithSubmission();
  try {
    await prisma.taskEvent.create({
      data: {
        taskId: task.id,
        eventType: "EVALUATION_COMPLETED",
        actor: REQUESTER,
        payload: JSON.stringify({
          providerId: "gemini",
          modelId: "test-model",
          recommendation: "APPROVE",
          decision: "PENDING_HUMAN_CONFIRMATION",
          downgraded: false,
          reason: null,
          policyChecks: [{ id: "criteria_covered", label: "Criteria", passed: true }],
          criterionResults: [{ criterionId: "c1", satisfied: true, reasoning: "ok" }],
          overallFeedback: "Good work",
          extractedData: null,
          submissionId,
          outcome: "PENDING_HUMAN_CONFIRMATION",
        }),
      },
    });
    const response = await stateGET(
      await authedRequest(`http://localhost/api/tasks/${task.id}/state`, REQUESTER),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      state: { evaluation: { submissionId: string; recommendation: string } | null };
    };
    assert.equal(body.state.evaluation?.submissionId, submissionId);
    assert.equal(body.state.evaluation?.recommendation, "APPROVE");

    // If the stored evaluation belongs to a foreign (stale) submission it is
    // never exposed for the current one.
    const stored = await prisma.taskEvent.findFirst({
      where: { taskId: task.id, eventType: "EVALUATION_COMPLETED" },
    });
    assert.ok(stored);
    await prisma.taskEvent.update({
      where: { id: stored.id },
      data: {
        payload: JSON.stringify({
          providerId: "gemini",
          modelId: "test-model",
          recommendation: "APPROVE",
          decision: "PENDING_HUMAN_CONFIRMATION",
          downgraded: false,
          reason: null,
          policyChecks: [],
          criterionResults: [],
          overallFeedback: "stale",
          submissionId: "nonexistent-submission",
          outcome: "PENDING_HUMAN_CONFIRMATION",
        }),
      },
    });
    const response2 = await stateGET(
      await authedRequest(`http://localhost/api/tasks/${task.id}/state`, REQUESTER),
      { params: Promise.resolve({ id: task.id }) }
    );
    const body2 = (await response2.json()) as { state: { evaluation: unknown } };
    assert.equal(body2.state.evaluation, null);
  } finally {
    await deleteTask(task.id);
  }
});

// ─── GET /api/tasks/[id]/events ──────────────────────────────

test("events: ACL'd, whitelisted, and reflects real recorded activity", async () => {
  const { task } = await claimedTaskWithSubmission();
  try {
    const unauth = await eventsGET(
      new Request(`http://localhost/api/tasks/${task.id}/events`),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(unauth.status, 401);

    const stranger = await eventsGET(
      await authedRequest(`http://localhost/api/tasks/${task.id}/events`, STRANGER),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(stranger.status, 403);

    const response = await eventsGET(
      await authedRequest(`http://localhost/api/tasks/${task.id}/events`, REQUESTER),
      { params: Promise.resolve({ id: task.id }) }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      events: Array<{
        id: string;
        eventType: string;
        actor: string | null;
        payload: string | null;
        createdAt: string;
      }>;
    };
    const types = body.events.map((e) => e.eventType);
    assert.equal(types.includes("TASK_CREATED"), true);
    assert.equal(types.includes("TASK_OPENED"), true);
    assert.equal(types.includes("TASK_ASSIGNED"), true);
    assert.equal(types.includes("SUBMISSION_RECEIVED"), true);
    for (const e of body.events) {
      assert.deepEqual(Object.keys(e).sort(), [
        "actor", "createdAt", "eventType", "id", "payload",
      ]);
      assert.equal("taskId" in e, false);
    }
    const times = body.events.map((e) => new Date(e.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  } finally {
    await deleteTask(task.id);
  }
});