/**
 * CeloTasker — Stage 5C settlement execution tests.
 *
 * ALL blockchain interaction is MOCKED — no automated test ever makes a real
 * payment. The mocks implement the minimal RelayerDeps surface so the full
 * authorize → lock → build → broadcast → confirm lifecycle is exercised
 * deterministically, including idempotency, crash/timeout recovery and
 * failure handling.
 *
 * (A clearly separated, OPTIONAL manual mainnet verification procedure for
 * the real agent wallet is documented in the Stage 5C report — it is never
 * part of the automated suite.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTaskRequestSchema } from "../lib/validation/ValidationSchemas.ts";
import {
  createTask,
  claimTask,
  submitWork,
} from "../lib/workflow/TaskService.ts";
import { settleSubmission } from "../lib/settlement/SettlementExecutor.ts";
import {
  buildSettlementCalldata,
  type RelayerDeps,
} from "../lib/settlement/CeloRelayer.ts";
import { createDefaultRelayerDeps } from "../lib/settlement/CeloRelayer.ts";
import { parseUnits, encodeEventTopics, toHex, erc20Abi } from "viem";
import { Prisma } from "@prisma/client";
import { Attribution } from "ox/erc8021";
import { SETTLEMENT_TOKEN_WHITELIST, CHAIN_IDS } from "../lib/security/SecurityPolicy.ts";
import { prisma } from "../lib/prisma.ts";

/** Whitelisted cUSD on Celo MAINNET (chain 42220). */
const WHITELISTED = SETTLEMENT_TOKEN_WHITELIST[CHAIN_IDS.CELO_MAINNET][0];
const OTHER_TOKEN = "0x9999999999999999999999999999999999999999";
const REQUESTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const RELAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_HASH = `0x${"ab".repeat(32)}`;
/**
 * Reward in whole tokens (human units). The Stage 5C executor converts it to
 * base units with the token's on-chain decimals via parseUnits — so the
 * mocked allowance (1,000,000 tokens) comfortably covers it.
 */
const AMOUNT = "123";
const TAG = "celotasker-test-tag";

function taskInput(overrides: Record<string, unknown> = {}) {
  return CreateTaskRequestSchema.parse({
    title: "Stage 5C execution regression",
    description: "Settlement execution regression task",
    rewardAmount: AMOUNT,
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
  const sub = await submitWork({ taskId: task.id, contentRef: "ipfs://QmPay" }, worker);
  if (!sub.ok) throw new Error("submit failed in test setup");
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

interface MockOptions {
  decimals?: number;
  allowance?: bigint;
  receipt?: { status: "success" | "reverted" } | "timeout";
  sendError?: Error;
  /**
   * H-1 regression: the node ACCEPTED the transaction but the RPC response
   * was lost — sendTransaction throws even though the tx is (as far as the
   * chain is concerned) submitted. The send is recorded BEFORE the throw.
   */
  sendAcceptedError?: Error;
  chainId?: number;
  attributionTag?: string;
  /**
   * Receipt logs (raw). Defaults to a correctly encoded ERC-20 Transfer event
   * for the fixture's token/owner/worker/amount — built with viem's
   * encodeEventLog, exactly like a real Celo receipt.
   */
  receiptLogs?: unknown[];
  /** Transfer logs returned by getLogs during broadcast recovery. */
  recoveryLogs?: Array<unknown>;
  /** Raw transactions returned by getTransaction during recovery. */
  recoveryTransactions?: Record<string, { from?: string; to: string | null; input: string }>;
  /** The current chain head the mocked getBlockNumber reports (M-2). */
  chainHead?: bigint;
  /** The block number carried by the mocked receipt (M-2); null = missing. */
  receiptBlockNumber?: bigint | null;
}

/** A correctly encoded ERC-20 Transfer log entry (as a real receipt carries). */
function transferLog(params: {
  from: string;
  to: string;
  value: bigint;
  token?: string;
  hash?: string;
  blockNumber?: bigint;
}): unknown {
  // Indexed topics (topic0 = event signature, topic1/2 = from/to) through
  // viem's ABI event encoder; the non-indexed value as 32-byte data.
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: {
      from: params.from as `0x${string}`,
      to: params.to as `0x${string}`,
    },
  });
  return {
    address: params.token ?? WHITELISTED,
    topics,
    data: toHex(params.value, { size: 32 }),
    blockNumber: params.blockNumber ?? 12345n,
    transactionHash: params.hash ?? TX_HASH,
    logIndex: 0,
    removed: false,
  };
}

/**
 * A recovery-scan Transfer log for this fixture: correct parties and amount,
 * at a recent in-window block (mock chain head is 200_000n).
 */
function recoveryLog(params?: { hash?: string; blockNumber?: bigint }): unknown {
  return transferLog({
    from: REQUESTER,
    to: WORKER,
    value: parseUnits(AMOUNT, 18),
    hash: params?.hash,
    blockNumber: params?.blockNumber ?? 199_950n,
  });
}

/** The default (correct) receipt logs for this fixture. */
function correctTransferLogs(): unknown[] {
  return [
    transferLog({
      from: REQUESTER,
      to: WORKER,
      value: parseUnits(AMOUNT, 18),
    }),
  ];
}

/** A fully mocked relayer: no network, no money — just recorded calls. */
function mockRelayer(opts: MockOptions = {}) {
  const calls = {
    reads: [] as string[],
    sends: [] as { to: string; data: string }[],
    receipts: [] as string[],
    chainChecks: 0,
    logScans: 0,
  };
  const deps: RelayerDeps = {
    chainId: opts.chainId ?? CHAIN_IDS.CELO_MAINNET,
    relayerAddress: RELAYER,
    attributionTag: opts.attributionTag ?? TAG,
    publicClient: {
      getChainId: async () => {
        calls.chainChecks += 1;
        return opts.chainId ?? CHAIN_IDS.CELO_MAINNET;
      },
      readContract: async (args: { functionName: string }) => {
        calls.reads.push(args.functionName);
        if (args.functionName === "decimals") return opts.decimals ?? 18;
        if (args.functionName === "allowance") {
          return opts.allowance ?? parseUnits("1000000", 18);
        }
        throw new Error(`unexpected read: ${args.functionName}`);
      },
      waitForTransactionReceipt: async (args: { hash: string }) => {
        calls.receipts.push(args.hash);
        if (opts.receipt === "timeout") {
          throw new Error("receipt timeout");
        }
        return {
          status: opts.receipt?.status ?? "success",
          blockNumber:
            opts.receiptBlockNumber === undefined ? 12345n : opts.receiptBlockNumber,
          transactionHash: args.hash,
          logs: opts.receiptLogs ?? correctTransferLogs(),
        };
      },
      getBlockNumber: async () => {
        // Used by M-2 depth checks and by the M-1 recovery window.
        return opts.chainHead ?? 200_000n;
      },
      getLogs: async () => {
        calls.logScans += 1;
        return opts.recoveryLogs ?? [];
      },
      getTransaction: async (args: { hash: string }) => {
        const tx = (opts.recoveryTransactions ?? {})[args.hash];
        if (tx) return { hash: args.hash, from: RELAYER, ...tx };
        // Default: sent by OUR relayer, to the token, with the exact calldata
        // this server would have built.
        return {
          hash: args.hash,
          from: RELAYER,
          to: WHITELISTED,
          input: expectedCalldata().data,
        };
      },
    },
    walletClient: {
      account: { address: RELAYER },
      sendTransaction: async (args: { to: string; data: string }) => {
        if (opts.sendError) throw opts.sendError;
        calls.sends.push({ to: args.to, data: args.data });
        if (opts.sendAcceptedError) throw opts.sendAcceptedError;
        return TX_HASH;
      },
    },
  };
  return { deps, calls };
}

/** The exact calldata the executor must broadcast for this fixture. */
function expectedCalldata() {
  return buildSettlementCalldata({
    owner: REQUESTER,
    recipient: WORKER,
    amount: AMOUNT,
    decimals: 18,
    attributionTag: TAG,
  });
}

// ─── Happy path ────────────────────────────────────────────────

test("successful receipt: one transferFrom, CONFIRMED settlement, task COMPLETED", async () => {
  const { task, submissionId } = await payableTask();
  const { deps, calls } = mockRelayer();
  try {
    const result = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.transaction?.status, "CONFIRMED");
      assert.equal(result.transaction?.txHash, TX_HASH);
      assert.equal(result.transaction?.chainId, CHAIN_IDS.CELO_MAINNET);
      assert.equal(result.transaction?.blockNumber, 12345);
    }

    // Exactly ONE broadcast with the exact expected calldata (transferFrom
    // + ERC-8021 suffix appended exactly once — verified via ox round-trip).
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0].to, WHITELISTED);
    assert.equal(calls.sends[0].data, expectedCalldata().data);
    assert.deepEqual(
      Attribution.fromData(calls.sends[0].data as `0x${string}`)?.codes,
      [TAG]
    );

    // Persisted state: settlement CONFIRMED with txHash; task COMPLETED.
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    assert.equal(settlement?.txHash, TX_HASH);
    assert.equal(settlement?.recipient, WORKER);
    assert.equal(settlement?.amount, AMOUNT);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");

    // Truthful audit: authorization, broadcast, confirmation — in order,
    // with txHash/chainId/token/recipient/amount recorded on each.
    const started = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_STARTED" },
    });
    assert.equal(started.length, 1);
    const broadcast = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_BROADCAST" },
    });
    assert.equal(broadcast.length, 1);
    const bp = JSON.parse(broadcast[0].payload ?? "{}");
    assert.equal(bp.txHash, TX_HASH);
    assert.equal(bp.chainId, CHAIN_IDS.CELO_MAINNET);
    assert.equal(bp.token, WHITELISTED);
    assert.equal(bp.recipient, WORKER);
    assert.equal(bp.amount, AMOUNT);
    const completed = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_COMPLETED" },
    });
    assert.equal(completed.length, 1);
    const cp = JSON.parse(completed[0].payload ?? "{}");
    assert.equal(cp.txHash, TX_HASH);
    assert.equal(cp.chainId, CHAIN_IDS.CELO_MAINNET);
    assert.equal(cp.blockNumber, "12345");
  } finally {
    await deleteTask(task.id);
  }
});

test("duplicate request after confirmation is idempotent: never a second transfer", async () => {
  const { task, submissionId } = await payableTask();
  const first = mockRelayer();
  const second = mockRelayer();
  try {
    const r1 = await settleSubmission(submissionId, WORKER, first.deps);
    assert.equal(r1.ok, true);
    const r2 = await settleSubmission(submissionId, WORKER, second.deps);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.note, "already_settled");
      assert.equal(r2.transaction?.status, "CONFIRMED");
    }
    assert.equal(first.calls.sends.length, 1);
    assert.equal(second.calls.sends.length, 0, "no second transfer, ever");
  } finally {
    await deleteTask(task.id);
  }
});

test("unauthorized: a stranger cannot settle or recover someone else's settlement", async () => {
  const { task, submissionId } = await payableTask();
  const { deps, calls } = mockRelayer();
  try {
    const gate = await settleSubmission(submissionId, STRANGER, deps);
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.equal(gate.reason, "forbidden");
      assert.equal(gate.status, 403);
    }
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
    assert.equal(calls.sends.length, 0);
  } finally {
    await deleteTask(task.id);
  }
});

test("unknown submission and non-eligible submissions are refused", async () => {
  const { deps } = mockRelayer();
  const missing = await settleSubmission("does-not-exist", WORKER, deps);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);

  // A superseded submission never reaches execution (Stage 4.2 gate).
  const { task, submissionId } = await payableTask();
  try {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "SUPERSEDED" },
    });
    const superseded = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(superseded.ok, false);
    if (!superseded.ok) assert.equal(superseded.reason, "submission_superseded");
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
  } finally {
    await deleteTask(task.id);
  }
});

// ─── Idempotency / concurrency / recovery ──────────────────────

test("concurrent settlement attempts produce exactly one broadcast", async () => {
  const { task, submissionId } = await payableTask();
  const a = mockRelayer();
  const b = mockRelayer();
  try {
    const results = await Promise.all([
      settleSubmission(submissionId, WORKER, a.deps),
      settleSubmission(submissionId, WORKER, b.deps),
    ]);
    const totalSends = a.calls.sends.length + b.calls.sends.length;
    assert.equal(totalSends, 1, "exactly one transfer may ever be broadcast");
    assert.ok(results.some((r) => r.ok), "at least one attempt succeeds");
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    assert.equal(settlement?.txHash, TX_HASH);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");
    const completed = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_COMPLETED" },
    });
    assert.equal(completed.length, 1, "one authoritative confirmation");
  } finally {
    await deleteTask(task.id);
  }
});

test("receipt timeout: BROADCAST persists, recovery confirms WITHOUT a new transfer", async () => {
  const { task, submissionId } = await payableTask();
  const timeoutMock = mockRelayer({ receipt: "timeout" });
  const recoveryMock = mockRelayer();
  try {
    const first = await settleSubmission(submissionId, WORKER, timeoutMock.deps);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.note, "awaiting_confirmation");
      assert.equal(first.transaction?.status, "BROADCAST");
      assert.equal(first.transaction?.txHash, TX_HASH);
    }
    // Persisted txHash drives recovery; the task is still SETTLING.
    const mid = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(mid?.status, "BROADCAST");
    assert.equal(mid?.txHash, TX_HASH);
    const midTask = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(midTask?.status, "SETTLING", "never SETTLED without a receipt");

    // "Process restarted / previous attempt timed out": retry reads the
    // PERSISTED txHash — it never sends another transfer.
    const recovery = await settleSubmission(submissionId, WORKER, recoveryMock.deps);
    assert.equal(recovery.ok, true);
    if (recovery.ok) {
      assert.equal(recovery.transaction?.status, "CONFIRMED");
      assert.equal(recovery.transaction?.txHash, TX_HASH);
    }
    assert.equal(recoveryMock.calls.sends.length, 0, "no second transfer, ever");
    assert.equal(recoveryMock.calls.receipts.length, 1, "receipt re-read by persisted hash");
    assert.equal(recoveryMock.calls.receipts[0], TX_HASH);

    const final = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(final?.status, "CONFIRMED");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");
  } finally {
    await deleteTask(task.id);
  }
});

test("crash between broadcast and hash persistence: recovery verifies the chain, never re-sends", async () => {
  const { task, submissionId } = await payableTask();
  const { deps, calls } = mockRelayer();
  try {
    // Authorize through the gate, then simulate the crash window: the
    // settlement is BROADCAST with NO persisted hash and NO matching
    // transaction on chain.
    const gate = await settleSubmission(
      submissionId,
      WORKER,
      mockRelayer({ receipt: "timeout" }).deps
    );
    assert.equal(gate.ok, true);
    await prisma.settlement.update({
      where: { submissionId },
      data: { status: "BROADCAST", txHash: null },
    });

    const retry = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(retry.ok, false);
    if (!retry.ok) {
      // The recovery scan found no matching on-chain transfer: structured
      // refusal — NEVER a re-send.
      assert.equal(retry.reason, "no_matching_broadcast");
      assert.equal(retry.status, 409);
    }
    assert.equal(calls.sends.length, 0, "never blindly send another transfer");
    assert.equal(calls.logScans >= 1, true, "the chain was scanned for the tx");
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, null);
  } finally {
    await deleteTask(task.id);
  }
});

test("reverted receipt: settlement FAILED, task PAYMENT_FAILED, never SETTLED", async () => {
  const { task, submissionId } = await payableTask();
  const { deps } = mockRelayer({ receipt: { status: "reverted" } });
  try {
    const result = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "receipt_reverted");
      assert.equal(result.status, 502);
    }
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "FAILED");
    assert.equal(settlement?.txHash, TX_HASH, "failure evidence preserved");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "PAYMENT_FAILED");
    const failed = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "PAYMENT_FAILED" },
    });
    assert.equal(failed.length, 1);
    const fp = JSON.parse(failed[0].payload ?? "{}");
    assert.equal(fp.reason, "receipt_reverted");
    assert.equal(fp.txHash, TX_HASH);
    assert.equal(
      (await prisma.taskEvent.findMany({
        where: { taskId: task.id, eventType: "SETTLEMENT_COMPLETED" },
      })).length,
      0,
      "confirmation never recorded before a successful receipt"
    );

    // A retry of a FAILED settlement is refused deterministically.
    const retry = await settleSubmission(submissionId, WORKER, mockRelayer().deps);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.reason, "settlement_failed");
  } finally {
    await deleteTask(task.id);
  }
});

test("H-1 regression: ambiguous broadcast failure retains the claim (BROADCAST, null hash) and a retry recovers WITHOUT a second broadcast", async () => {
  const { task, submissionId } = await payableTask();
  // The dangerous case: the node ACCEPTED the transaction, then the RPC
  // response was lost (timeout / connection reset) — sendTransaction throws
  // even though the transaction is submitted to the chain.
  const accepted = mockRelayer({
    sendAcceptedError: new Error("response lost after the node accepted the tx"),
  });
  try {
    const result = await settleSubmission(submissionId, WORKER, accepted.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "broadcast_failed_ambiguous");
      assert.equal(result.status, 502);
    }

    // Exactly ONE submission attempt was made — the one the node accepted.
    assert.equal(accepted.calls.sends.length, 1);

    // H-1 invariant: the claim is NEVER released back to PENDING. The
    // settlement stays BROADCAST with no known hash — the only way a retry
    // can proceed is verified recovery, never a new broadcast claim.
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST", "claim must not be released (H-1)");
    assert.equal(settlement?.txHash, null);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");

    // The ambiguous failure is audited.
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_REJECTED" },
    });
    assert.ok(rejected.length >= 1);
    const lastPayload = JSON.parse(rejected[rejected.length - 1].payload ?? "{}");
    assert.equal(lastPayload.reason, "broadcast_failed_ambiguous");

    // RETRY: must go through VERIFIED recovery, which discovers the accepted
    // transaction by scanning Transfer logs and verifying its calldata — and
    // must NEVER broadcast a second transaction.
    const recovery = mockRelayer({ recoveryLogs: [recoveryLog()] });
    const retry = await settleSubmission(submissionId, WORKER, recovery.deps);
    assert.equal(retry.ok, true);
    assert.equal(recovery.calls.sends.length, 0, "no second broadcast may ever occur (H-1)");
    assert.ok(recovery.calls.logScans >= 1, "retry used the verified recovery scan");
    const confirmed = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(confirmed?.status, "CONFIRMED");
    assert.equal(confirmed?.txHash, TX_HASH);
    const done = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(done?.status, "COMPLETED");
  } finally {
    await deleteTask(task.id);
  }
});

test("H-1 regression: ambiguous failure with NO on-chain match stays BROADCAST and refuses any re-send", async () => {
  const { task, submissionId } = await payableTask();
  // The send threw and recovery finds nothing on chain (the tx was never
  // mined / never existed). The settlement must remain stuck in BROADCAST
  // rather than risk a double payment — no new claim, no new broadcast.
  const failing = mockRelayer({ sendError: new Error("rpc down") });
  try {
    const result = await settleSubmission(submissionId, WORKER, failing.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "broadcast_failed_ambiguous");
      assert.equal(result.status, 502);
    }

    // RETRY with a healthy relayer: recovery scans and finds nothing → the
    // refusal is structured; a second broadcast is NEVER attempted.
    const healthy = mockRelayer({ recoveryLogs: [] });
    const retry = await settleSubmission(submissionId, WORKER, healthy.deps);
    assert.equal(retry.ok, false);
    if (!retry.ok) {
      assert.equal(retry.reason, "no_matching_broadcast");
      assert.equal(retry.status, 409);
    }
    assert.equal(healthy.calls.sends.length, 0, "no second broadcast may ever occur (H-1)");
    assert.ok(healthy.calls.logScans >= 1, "retry used the verified recovery scan");

    // State invariant across BOTH attempts: still BROADCAST, still claimless.
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST", "claim must not be released (H-1)");
    assert.equal(settlement?.txHash, null);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
    assert.equal(failing.calls.sends.length + healthy.calls.sends.length, 0);
  } finally {
    await deleteTask(task.id);
  }
});

// ─── Pre-broadcast safety checks ────────────────────────────────

test("insufficient allowance fails safely and is retryable after approval", async () => {
  const { task, submissionId } = await payableTask();
  const low = mockRelayer({ allowance: 1n });
  try {
    const result = await settleSubmission(submissionId, WORKER, low.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "insufficient_allowance");
      assert.equal(result.status, 409);
    }
    assert.equal(low.calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "PENDING");
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_REJECTED" },
    });
    assert.equal(rejected.length, 1);
    assert.equal(JSON.parse(rejected[0].payload ?? "{}").reason, "insufficient_allowance");

    // After the requester approves off-chain, the retry succeeds.
    const retry = await settleSubmission(submissionId, WORKER, mockRelayer().deps);
    assert.equal(retry.ok, true);
    const done = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(done?.status, "COMPLETED");
  } finally {
    await deleteTask(task.id);
  }
});

test("invalid token decimals are refused safely", async () => {
  const { task, submissionId } = await payableTask();
  const { deps, calls } = mockRelayer({ decimals: 32 });
  try {
    const result = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_decimals");
      assert.equal(result.status, 409);
    }
    assert.equal(calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "PENDING");
  } finally {
    await deleteTask(task.id);
  }
});

test("a relayer pointed at the wrong chain is refused (no silent fallback)", async () => {
  const { task, submissionId } = await payableTask();
  const { deps, calls } = mockRelayer({ chainId: 44787 }); // Alfajores
  try {
    const result = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "wrong_chain");
      assert.equal(result.status, 409);
    }
    assert.equal(calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "PENDING");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
  } finally {
    await deleteTask(task.id);
  }
});

test("a non-whitelisted token is refused by the gate and never settles", async () => {
  const task = await createTask(REQUESTER, taskInput({ rewardToken: OTHER_TOKEN }));
  try {
    const claim = await claimTask(task.id, WORKER);
    assert.equal(claim.ok, true);
    const sub = await submitWork({ taskId: task.id, contentRef: "ipfs://QmX" }, WORKER);
    assert.equal(sub.ok, true);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "UNDER_REVIEW" },
    });
    await prisma.submission.update({
      where: { id: sub.data.id },
      data: { status: "APPROVED" },
    });
    const { deps, calls } = mockRelayer();
    const result = await settleSubmission(sub.data.id, WORKER, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "token_not_whitelisted");
      assert.equal(result.status, 403);
    }
    assert.equal(calls.sends.length, 0);
    assert.equal(
      (await prisma.settlement.findMany({ where: { taskId: task.id } })).length,
      0
    );
  } finally {
    await deleteTask(task.id);
  }
});

// ─── Corrupted-record defense & configuration ──────────────────

/** A task whose settlement row was inserted directly (legacy/corruption). */
async function directSettlementTask(overrides: {
  rewardToken?: string;
  amount?: string;
  recipient?: string;
}) {
  const { task, submissionId } = await payableTask();
  await prisma.task.update({ where: { id: task.id }, data: { status: "SETTLING" } });
  await prisma.settlement.create({
    data: {
      submissionId,
      taskId: task.id,
      recipient: overrides.recipient ?? WORKER,
      amount: overrides.amount ?? AMOUNT,
      rewardToken: overrides.rewardToken ?? WHITELISTED,
      status: "PENDING",
    },
  });
  return { task, submissionId };
}

test("executor defense in depth: non-whitelisted token row, bad amount, corrupted recipient", async () => {
  // Unsupported token in a directly-inserted row (the gate would never create one).
  const bad = await directSettlementTask({ rewardToken: OTHER_TOKEN });
  try {
    const result = await settleSubmission(bad.submissionId, WORKER, mockRelayer().deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "unsupported_token");
      assert.equal(result.status, 403);
    }
  } finally {
    await deleteTask(bad.task.id);
  }

  // Invalid reward amount in a directly-inserted row.
  const ugly = await directSettlementTask({ amount: "not-a-number" });
  try {
    const result = await settleSubmission(ugly.submissionId, WORKER, mockRelayer().deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_reward");
      assert.equal(result.status, 409);
    }
  } finally {
    await deleteTask(ugly.task.id);
  }

  // Persisted recipient that no longer matches the submission's submitter.
  const forged = await payableTask();
  try {
    await prisma.task.update({
      where: { id: forged.task.id },
      data: { status: "SETTLING" },
    });
    await prisma.settlement.create({
      data: {
        submissionId: forged.submissionId,
        taskId: forged.task.id,
        recipient: WORKER,
        amount: AMOUNT,
        rewardToken: WHITELISTED,
        status: "PENDING",
      },
    });
    await prisma.submission.update({
      where: { id: forged.submissionId },
      data: { submitter: STRANGER }, // simulated corruption
    });
    const result = await settleSubmission(
      forged.submissionId,
      WORKER,
      mockRelayer().deps
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "recipient_mismatch");
      assert.equal(result.status, 409);
    }
  } finally {
    await deleteTask(forged.task.id);
  }
});

test("missing relayer configuration fails safe: authorized settlement stays PENDING", async () => {
  const { task, submissionId } = await payableTask();
  const savedRpc = process.env.CELO_RPC_URL;
  const savedKey = process.env.AGENT_RELAYER_PRIVATE_KEY;
  const savedTag = process.env.ATTRIBUTION_TAG;
  try {
    delete process.env.CELO_RPC_URL;
    delete process.env.AGENT_RELAYER_PRIVATE_KEY;
    delete process.env.ATTRIBUTION_TAG;
    assert.equal(createDefaultRelayerDeps(), null);

    // Default deps (as the route uses): authorized but NOT executed.
    const result = await settleSubmission(submissionId, WORKER);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.note, "execution_unavailable");
      assert.equal(result.transaction, null);
    }
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "PENDING");
    assert.equal(settlement?.txHash, null);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING", "authorized, locked, not executed");

    // Once configuration is restored, the same request executes idempotently.
    if (savedRpc !== undefined) process.env.CELO_RPC_URL = savedRpc;
    if (savedKey !== undefined) process.env.AGENT_RELAYER_PRIVATE_KEY = savedKey;
    if (savedTag !== undefined) process.env.ATTRIBUTION_TAG = savedTag;
    const retry = await settleSubmission(
      submissionId,
      WORKER,
      mockRelayer({ attributionTag: "CeloTasker" }).deps
    );
    assert.equal(retry.ok, true);
    const done = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(done?.status, "COMPLETED");
  } finally {
    if (savedRpc !== undefined) process.env.CELO_RPC_URL = savedRpc;
    if (savedKey !== undefined) process.env.AGENT_RELAYER_PRIVATE_KEY = savedKey;
    if (savedTag !== undefined) process.env.ATTRIBUTION_TAG = savedTag;
    await deleteTask(task.id);
  }
});

// ─── FIX 2/6: recovery with a verified on-chain match ──────────

test("recovery attaches a VERIFIED hash and confirms without any new transfer", async () => {
  const { task, submissionId } = await payableTask();
  try {
    // Simulate: broadcast happened, hash was never persisted.
    const gate = await settleSubmission(
      submissionId,
      WORKER,
      mockRelayer({ receipt: "timeout" }).deps
    );
    assert.equal(gate.ok, true);
    await prisma.settlement.update({
      where: { submissionId },
      data: { status: "BROADCAST", txHash: null },
    });

    // The chain HAS our broadcast: a Transfer log exists whose transaction
    // carries byte-identical calldata (transferFrom + ERC-8021 suffix).
    const recovery = mockRelayer({
      recoveryLogs: [recoveryLog()],
      // getTransaction default returns the exact expected calldata.
    });
    const result = await settleSubmission(submissionId, WORKER, recovery.deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.transaction?.status, "CONFIRMED");
      assert.equal(result.transaction?.txHash, TX_HASH);
    }
    assert.equal(recovery.calls.sends.length, 0, "recovery NEVER broadcasts");
    assert.equal(recovery.calls.logScans >= 1, true, "the chain was scanned");

    // The verified hash is attached and confirmation proceeds.
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    assert.equal(settlement?.txHash, TX_HASH);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");
    // The recovery is truthfully audited.
    const broadcasts = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_BROADCAST" },
    });
    const recovered = broadcasts
      .map((e) => JSON.parse(e.payload ?? "{}"))
      .find((p) => p.recovered === true);
    assert.ok(recovered, "a recovered-broadcast audit record exists");
    assert.equal(recovered.txHash, TX_HASH);
    assert.equal(recovered.verification, "byte-identical calldata + expected Transfer event");
  } finally {
    await deleteTask(task.id);
  }
});

test("recovery refuses a non-matching on-chain transaction (wrong calldata)", async () => {
  const { task, submissionId } = await payableTask();
  try {
    await settleSubmission(
      submissionId,
      WORKER,
      mockRelayer({ receipt: "timeout" }).deps
    );
    await prisma.settlement.update({
      where: { submissionId },
      data: { status: "BROADCAST", txHash: null },
    });

    // The chain has a Transfer to the right parties, but its transaction
    // carries DIFFERENT calldata (e.g. a manual transfer without the
    // ERC-8021 suffix) — it must NOT be attached.
    const recovery = mockRelayer({
      recoveryLogs: [recoveryLog()],
      recoveryTransactions: {
        [TX_HASH]: { to: WHITELISTED, input: "0xdeadbeef" },
      },
    });
    const result = await settleSubmission(submissionId, WORKER, recovery.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_matching_broadcast");
      assert.equal(result.status, 409);
    }
    assert.equal(recovery.calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.txHash, null, "an unverified hash is never attached");
  } finally {
    await deleteTask(task.id);
  }
});

// ─── M-1: candidate ownership and ambiguity hardening ───────────

/** A second, distinct transaction hash (never equal to TX_HASH). */
const OTHER_HASH = "0x" + "cd".repeat(32);
/** An address that is NOT the configured relayer. */
const FOREIGN_SENDER = "0x" + "cc".repeat(20);

/** Put a settlement into the ambiguous crash window (BROADCAST, null hash). */
async function crashWindowSettlement(submissionId: string, taskId: string) {
  await settleSubmission(
    submissionId,
    WORKER,
    mockRelayer({ receipt: "timeout" }).deps
  );
  await prisma.settlement.update({
    where: { submissionId },
    data: { status: "BROADCAST", txHash: null },
  });
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  assert.equal(task?.status, "SETTLING");
}

test("M-1: recovery requires the EXACT amount — a wrong-value Transfer is rejected", async () => {
  const { task, submissionId } = await payableTask();
  try {
    await crashWindowSettlement(submissionId, task.id);

    // A Transfer to the right parties but with the WRONG amount — the value
    // is non-indexed (invisible to the RPC filter), so only the decoded
    // check can catch it. It must never become a candidate.
    const wrongValue = mockRelayer({
      recoveryLogs: [
        transferLog({
          from: REQUESTER,
          to: WORKER,
          value: parseUnits("999", 18),
          blockNumber: 199_950n,
        }),
      ],
    });
    const result = await settleSubmission(submissionId, WORKER, wrongValue.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_matching_broadcast");
      assert.equal(result.status, 409);
    }
    assert.equal(wrongValue.calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, null);
  } finally {
    await deleteTask(task.id);
  }
});

test("M-1: recovery rejects a candidate sent by anyone other than the configured relayer", async () => {
  const { task, submissionId } = await payableTask();
  try {
    await crashWindowSettlement(submissionId, task.id);

    // Byte-identical calldata to the right token — but sent from a foreign
    // address (e.g. the worker replaying the calldata themselves). It is NOT
    // our broadcast and must never be attached.
    const foreign = mockRelayer({
      recoveryLogs: [recoveryLog()],
      recoveryTransactions: {
        [TX_HASH]: { from: FOREIGN_SENDER, to: WHITELISTED, input: expectedCalldata().data },
      },
    });
    const result = await settleSubmission(submissionId, WORKER, foreign.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_matching_broadcast");
      assert.equal(result.status, 409);
    }
    assert.equal(foreign.calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, null);
  } finally {
    await deleteTask(task.id);
  }
});

test("M-1: a hash already attached to ANOTHER settlement is never attached here", async () => {
  // Task A settles normally — its settlement owns TX_HASH.
  const a = await payableTask();
  let b: Awaited<ReturnType<typeof payableTask>> | null = null;
  try {
    const settled = await settleSubmission(a.submissionId, WORKER, mockRelayer().deps);
    assert.equal(settled.ok, true);
    const aRow = await prisma.settlement.findUnique({ where: { submissionId: a.submissionId } });
    assert.equal(aRow?.txHash, TX_HASH, "task A's payment is attached to TX_HASH");

    // Task B (identical parties/amount → byte-identical calldata) is in the
    // crash window. The chain scan finds A's transaction — but A's hash is
    // ALREADY OWNED by A's settlement, so it can never be proof of B's
    // broadcast.
    b = await payableTask();
    await crashWindowSettlement(b.submissionId, b.task.id);
    const recovery = mockRelayer({ recoveryLogs: [recoveryLog()] });
    const result = await settleSubmission(b.submissionId, WORKER, recovery.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_matching_broadcast");
      assert.equal(result.status, 409);
    }
    assert.equal(recovery.calls.sends.length, 0);
    const bRow = await prisma.settlement.findUnique({ where: { submissionId: b.submissionId } });
    assert.equal(bRow?.status, "BROADCAST", "the BROADCAST claim is preserved");
    assert.equal(bRow?.txHash, null, "another settlement's hash is never attached");
    // Task A's record is untouched.
    const aRowAfter = await prisma.settlement.findUnique({ where: { submissionId: a.submissionId } });
    assert.equal(aRowAfter?.txHash, TX_HASH);
  } finally {
    await deleteTask(a.task.id);
    if (b) await deleteTask(b.task.id);
  }
});

test("M-1: identical calldata from ANOTHER task is excluded — B recovers its OWN transaction", async () => {
  // Task A settles normally and owns TX_HASH. Task B (byte-identical
  // calldata) is in the crash window and BOTH transactions are on chain.
  const a = await payableTask();
  let b: Awaited<ReturnType<typeof payableTask>> | null = null;
  try {
    await settleSubmission(a.submissionId, WORKER, mockRelayer().deps);
    b = await payableTask();
    await crashWindowSettlement(b.submissionId, b.task.id);

    const recovery = mockRelayer({
      recoveryLogs: [recoveryLog({ hash: TX_HASH }), recoveryLog({ hash: OTHER_HASH })],
    });
    const result = await settleSubmission(b.submissionId, WORKER, recovery.deps);
    assert.equal(result.ok, true, "B recovers after A's hash is excluded");
    assert.equal(recovery.calls.sends.length, 0, "recovery NEVER broadcasts");
    const bRow = await prisma.settlement.findUnique({ where: { submissionId: b.submissionId } });
    assert.equal(bRow?.txHash, OTHER_HASH, "B gets ITS OWN transaction, never A's");
    assert.equal(bRow?.status, "CONFIRMED");
    const done = await prisma.task.findUnique({ where: { id: b.task.id } });
    assert.equal(done?.status, "COMPLETED");
  } finally {
    await deleteTask(a.task.id);
    if (b) await deleteTask(b.task.id);
  }
});

test("M-1: a candidate outside the bounded recovery window is rejected", async () => {
  const { task, submissionId } = await payableTask();
  try {
    await crashWindowSettlement(submissionId, task.id);

    // The settlement was created seconds ago (mock head 200_000n), so the
    // bounded window starts near the head. A candidate at block 12345 is far
    // outside the window — even an RPC that ignores the requested range must
    // not smuggle it in.
    const stale = mockRelayer({
      recoveryLogs: [recoveryLog({ hash: TX_HASH, blockNumber: 12345n })],
    });
    const result = await settleSubmission(submissionId, WORKER, stale.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "no_matching_broadcast");
      assert.equal(result.status, 409);
    }
    assert.equal(stale.calls.sends.length, 0);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, null);
  } finally {
    await deleteTask(task.id);
  }
});

test("M-1: MULTIPLE unattached verified candidates → ambiguous recovery, never a guess", async () => {
  const { task, submissionId } = await payableTask();
  try {
    await crashWindowSettlement(submissionId, task.id);

    // Two transactions, both fully verified (right relayer, right calldata,
    // right amount, in window) and neither attached to any settlement. It is
    // impossible to prove which one belongs here — so nothing may be attached.
    const ambiguous = mockRelayer({
      recoveryLogs: [recoveryLog({ hash: TX_HASH }), recoveryLog({ hash: OTHER_HASH })],
    });
    const result = await settleSubmission(submissionId, WORKER, ambiguous.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "ambiguous_recovery");
      assert.equal(result.status, 409);
    }
    assert.equal(ambiguous.calls.sends.length, 0, "no second broadcast may ever occur");
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST", "the claim is preserved for manual recovery");
    assert.equal(settlement?.txHash, null, "no hash is attached when ownership is unprovable");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");

    // The ambiguity is truthfully audited for the operator.
    const rejected = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_REJECTED" },
    });
    const lastPayload = JSON.parse(rejected[rejected.length - 1].payload ?? "{}");
    assert.equal(lastPayload.reason, "ambiguous_recovery");
    assert.equal(lastPayload.candidateCount, 2);
  } finally {
    await deleteTask(task.id);
  }
});

// ─── M-A: txHash uniqueness (database-enforced settlement ownership) ──

test("M-A: two concurrent recoveries of the same txHash — only one settlement wins", async () => {
  const a = await payableTask();
  const b = await payableTask();
  try {
    await crashWindowSettlement(a.submissionId, a.task.id);
    await crashWindowSettlement(b.submissionId, b.task.id);
    const ownerSettlement = await prisma.settlement.findUnique({
      where: { submissionId: a.submissionId },
    });
    assert.ok(ownerSettlement);

    // Both recoverers scan the SAME fully verified broadcast: the fixtures are
    // identical (same creator, worker, amount, token and tag), so their
    // expected calldata is byte-identical and TX_HASH verifies for both — the
    // exact scenario the M-1 ownership filter exists for.
    const loser = mockRelayer({ recoveryLogs: [recoveryLog({ hash: TX_HASH })] });

    // Deterministic interleaving of the real concurrency window:
    //   1. the loser reads "which hashes are already taken" → nothing attached
    //   2. the winner attaches TX_HASH to ITS settlement (a REAL database write)
    //   3. the loser attempts its own attach → UNIQUE(txHash) rejects it (P2002)
    const settlementModel = prisma.settlement as unknown as {
      findMany: (args: unknown) => Promise<unknown>;
    };
    const originalFindMany = settlementModel.findMany.bind(prisma.settlement);
    let interleaved = false;
    try {
      settlementModel.findMany = async (args) => {
        const where = (args as { where?: Record<string, unknown> })?.where;
        if (!interleaved && where && typeof where === "object" && "txHash" in where) {
          interleaved = true;
          // Step 2 — the concurrent winner commits while the loser is between
          // its ownership check and its attach.
          const claimed = await prisma.settlement.updateMany({
            where: { id: ownerSettlement!.id, status: "BROADCAST", txHash: null },
            data: { txHash: TX_HASH },
          });
          assert.equal(claimed.count, 1, "the concurrent winner owns the hash");
          return []; // the loser's snapshot predates that commit
        }
        return originalFindMany(args as never);
      };

      const result = await settleSubmission(b.submissionId, WORKER, loser.deps);
      assert.equal(interleaved, true, "the recovery attach path was exercised");

      // Fail closed on the existing ambiguity conflict.
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "ambiguous_recovery");
        assert.equal(result.status, 409);
      }
      assert.equal(loser.calls.sends.length, 0, "never re-broadcast");
      assert.equal(loser.calls.receipts.length, 0, "never confirmed by receipt");

      // The loser keeps its fail-closed BROADCAST claim and attaches nothing.
      const loserRow = await prisma.settlement.findUnique({
        where: { submissionId: b.submissionId },
      });
      assert.equal(loserRow?.status, "BROADCAST");
      assert.equal(loserRow?.txHash, null);
      const loserTask = await prisma.task.findUnique({ where: { id: b.task.id } });
      assert.equal(loserTask?.status, "SETTLING", "never SETTLED/COMPLETED");

      // Truthfully audited for the operator.
      const rejected = await prisma.taskEvent.findMany({
        where: { taskId: b.task.id, eventType: "SETTLEMENT_REJECTED" },
      });
      const payload = JSON.parse(rejected[rejected.length - 1].payload ?? "{}");
      assert.equal(payload.reason, "ambiguous_recovery");
      assert.equal(payload.phase, "recovery_attach");
    } finally {
      settlementModel.findMany = originalFindMany as never;
    }

    // Only ONE settlement in the whole database owns that transaction.
    const owners = await prisma.settlement.findMany({ where: { txHash: TX_HASH } });
    assert.equal(owners.length, 1, "one transaction, one owner");
    assert.equal(owners[0].id, ownerSettlement!.id);

    // And the database itself refuses a second claim on the same hash.
    const loserId = (
      await prisma.settlement.findUnique({ where: { submissionId: b.submissionId } })
    )!.id;
    await assert.rejects(
      () =>
        prisma.settlement.updateMany({
          where: { id: loserId },
          data: { txHash: TX_HASH },
        }),
      (err: unknown) =>
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002",
      "UNIQUE(Settlement.txHash) must reject a duplicate claim"
    );
  } finally {
    await deleteTask(a.task.id);
    await deleteTask(b.task.id);
  }
});

test("M-A: a txHash unique violation at broadcast persist fails closed, never confirmed", async () => {
  const { task, submissionId } = await payableTask();
  try {
    // The broadcast SUCCEEDS (the transaction is on chain and the truthful
    // SETTLEMENT_BROADCAST audit is written first), but persisting the hash is
    // rejected because another settlement already owns that transaction.
    const settlementModel = prisma.settlement as unknown as {
      updateMany: (args: { data?: { txHash?: string } }) => Promise<unknown>;
    };
    const originalUpdateMany = settlementModel.updateMany.bind(prisma.settlement);
    let violationRaised = false;
    try {
      settlementModel.updateMany = async (args) => {
        if (!violationRaised && typeof args?.data?.txHash === "string") {
          violationRaised = true;
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`txHash`)",
            {
              code: "P2002",
              clientVersion: "test",
              meta: { target: ["txHash"] },
            }
          );
        }
        return originalUpdateMany(args as never);
      };

      const { deps, calls } = mockRelayer();
      const result = await settleSubmission(submissionId, WORKER, deps);
      assert.equal(violationRaised, true, "the unique violation was exercised");

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "ambiguous_recovery");
        assert.equal(result.status, 409);
      }
      assert.equal(calls.sends.length, 1, "the one broadcast already happened");
      assert.equal(calls.receipts.length, 0, "never confirmed");

      const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
      assert.equal(settlement?.status, "BROADCAST", "fail-closed claim preserved");
      assert.equal(settlement?.txHash, null, "no attachment");
      const fresh = await prisma.task.findUnique({ where: { id: task.id } });
      assert.equal(fresh?.status, "SETTLING", "never SETTLED/COMPLETED");

      const rejected = await prisma.taskEvent.findMany({
        where: { taskId: task.id, eventType: "SETTLEMENT_REJECTED" },
      });
      const payload = JSON.parse(rejected[rejected.length - 1].payload ?? "{}");
      assert.equal(payload.reason, "ambiguous_recovery");
      assert.equal(payload.phase, "broadcast_persist");
    } finally {
      settlementModel.updateMany = originalUpdateMany as never;
    }
  } finally {
    await deleteTask(task.id);
  }
});

// ─── M-A: database-level txHash ownership ───────────────────────

/**
 * M-A regression: the M-1 ownership filter is a SELECT and the attachment is a
 * separate UPDATE, so two concurrent recoverers can both observe the same
 * verified broadcast as "available". The database-level UNIQUE constraint on
 * Settlement.txHash must let exactly ONE of them own it, and the loser must
 * fail closed: claim preserved, never confirmed, never re-broadcast.
 *
 * The invariant is enforced by the DATABASE, not by an application convention —
 * a second row with the same non-null txHash is rejected by the unique index,
 * while many NULLs (the fail-closed BROADCAST-without-hash crash window) stay
 * representable.
 */
test("M-A: the database rejects a second owner of a txHash and allows many NULLs", async () => {
  const task = await createTask(REQUESTER, taskInput());
  try {
    const submissionIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const created = await prisma.submission.create({
        data: {
          taskId: task.id,
          submitter: WORKER,
          contentRef: `ipfs://QmTxHashUniqueness${i}`,
          status: "APPROVED",
        },
      });
      submissionIds.push(created.id);
    }
    const settlementRow = (submissionId: string, txHash: string | null) => ({
      submissionId,
      taskId: task.id,
      recipient: WORKER,
      amount: AMOUNT,
      rewardToken: WHITELISTED,
      status: "BROADCAST",
      txHash,
    });

    // One settlement may own the transaction...
    await prisma.settlement.create({ data: settlementRow(submissionIds[0], TX_HASH) });

    // ...a second one may NOT — the database itself refuses it.
    let uniqueViolation: unknown = null;
    try {
      await prisma.settlement.create({ data: settlementRow(submissionIds[1], TX_HASH) });
    } catch (err) {
      uniqueViolation = err;
    }
    if (!(uniqueViolation instanceof Prisma.PrismaClientKnownRequestError)) {
      assert.fail("a second owner of the same txHash must be rejected by the database");
    }
    assert.equal(uniqueViolation.code, "P2002");

    // The crash window stays representable: MANY rows may hold a NULL txHash.
    await prisma.settlement.create({ data: settlementRow(submissionIds[1], null) });
    await prisma.settlement.create({ data: settlementRow(submissionIds[2], null) });
    await prisma.settlement.create({ data: settlementRow(submissionIds[3], null) });
    assert.equal(
      await prisma.settlement.count({ where: { taskId: task.id, txHash: null } }),
      3,
      "multiple NULL txHashes remain allowed"
    );
    assert.equal(
      await prisma.settlement.count({ where: { taskId: task.id, txHash: TX_HASH } }),
      1
    );

    // It is a real database index (migration 20260915000000), not app logic.
    const indexes = await prisma.$queryRaw<Array<{ name: string; sql: string | null }>>`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name = 'Settlement_txHash_key'
    `;
    assert.equal(indexes.length, 1, "the UNIQUE index exists in the database");
    assert.match(indexes[0].sql ?? "", /UNIQUE\s+INDEX/i);
  } finally {
    await deleteTask(task.id);
  }
});

test("M-A: two concurrent recovery attempts cannot both own the same txHash", async () => {
  const first = await payableTask();
  const second = await payableTask();
  try {
    await crashWindowSettlement(first.submissionId, first.task.id);
    await crashWindowSettlement(second.submissionId, second.task.id);

    // Both payments are identical (same parties, amount and token), so the SAME
    // on-chain transaction fully verifies for BOTH settlements — exactly the
    // situation the M-1 ownership filter alone cannot settle.
    const a = mockRelayer({ recoveryLogs: [recoveryLog()] });
    const b = mockRelayer({ recoveryLogs: [recoveryLog()] });

    const [resultA, resultB] = await Promise.all([
      settleSubmission(first.submissionId, WORKER, a.deps),
      settleSubmission(second.submissionId, WORKER, b.deps),
    ]);

    // Recovery NEVER broadcasts, on either side.
    assert.equal(a.calls.sends.length, 0, "recovery A never broadcasts");
    assert.equal(b.calls.sends.length, 0, "recovery B never broadcasts");

    // Database-level guarantee: exactly one settlement owns the transaction.
    const owners = await prisma.settlement.findMany({ where: { txHash: TX_HASH } });
    assert.equal(owners.length, 1, "only ONE settlement may own a txHash");

    const rows = await prisma.settlement.findMany({
      where: { submissionId: { in: [first.submissionId, second.submissionId] } },
    });
    const owner = rows.find((r) => r.txHash === TX_HASH);
    const loser = rows.find((r) => r.txHash === null);
    assert.ok(owner, "one settlement attached the verified hash");
    assert.ok(loser, "the other settlement never attached it");
    assert.equal(loser.status, "BROADCAST", "the loser keeps its fail-closed claim");
    assert.notEqual(loser.id, owner.id, "the loser is a DIFFERENT settlement than the owner");

    // The loser is a deterministic 409 conflict — never a success, never a 500.
    const loserResult = owner.submissionId === first.submissionId ? resultB : resultA;
    assert.equal(loserResult.ok, false);
    if (!loserResult.ok) {
      assert.ok(
        loserResult.reason === "ambiguous_recovery" ||
          loserResult.reason === "no_matching_broadcast",
        `unexpected loser reason: ${loserResult.reason}`
      );
      assert.equal(loserResult.status, 409);
    }

    // ...and the loser's task was never settled.
    const loserTaskId =
      owner.submissionId === first.submissionId ? second.task.id : first.task.id;
    const loserTask = await prisma.task.findUnique({ where: { id: loserTaskId } });
    assert.equal(loserTask?.status, "SETTLING", "the loser is never marked settled");
  } finally {
    await deleteTask(first.task.id);
    await deleteTask(second.task.id);
  }
});

// ─── M-2: confirmation-depth protection ─────────────────────────

/**
 * Set the server-side confirmation depth for an M-2 test; returns a
 * restore function. NEVER a client-supplied value.
 */
function setDepthEnv(value: string | undefined) {
  const saved = process.env.SETTLEMENT_CONFIRMATION_DEPTH;
  if (value === undefined) {
    delete process.env.SETTLEMENT_CONFIRMATION_DEPTH;
  } else {
    process.env.SETTLEMENT_CONFIRMATION_DEPTH = value;
  }
  return () => {
    if (saved === undefined) {
      delete process.env.SETTLEMENT_CONFIRMATION_DEPTH;
    } else {
      process.env.SETTLEMENT_CONFIRMATION_DEPTH = saved;
    }
  };
}

test("M-2: a transaction AT the required confirmation depth finalizes", async () => {
  const restore = setDepthEnv("5");
  const { task, submissionId } = await payableTask();
  try {
    // Receipt mined 5 blocks below the head: exactly the required depth.
    const atDepth = mockRelayer({ receiptBlockNumber: 199_995n, chainHead: 200_000n });
    const result = await settleSubmission(submissionId, WORKER, atDepth.deps);
    assert.equal(result.ok, true);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    assert.equal(settlement?.txHash, TX_HASH);
    const done = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(done?.status, "COMPLETED");
  } finally {
    restore();
    await deleteTask(task.id);
  }
});

test("M-2: below the required depth stays unconfirmed; no rebroadcast; boundary is exact", async () => {
  const restore = setDepthEnv("5");
  const { task, submissionId } = await payableTask();
  try {
    // Depth 2 of 5: NOT finalized, retryable, exactly one broadcast.
    const shallow = mockRelayer({ receiptBlockNumber: 199_998n, chainHead: 200_000n });
    const first = await settleSubmission(submissionId, WORKER, shallow.deps);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.note, "awaiting_confirmations");
      assert.equal(first.transaction?.status, "BROADCAST");
    }
    let settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST", "no premature CONFIRMED");
    assert.equal(settlement?.txHash, TX_HASH, "the hash is preserved for the retry");
    let fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING", "no premature COMPLETED");
    assert.equal(shallow.calls.sends.length, 1);

    // Retry at depth 4 of 5: still one short — still unconfirmed.
    const four = mockRelayer({ receiptBlockNumber: 199_998n, chainHead: 200_002n });
    const second = await settleSubmission(submissionId, WORKER, four.deps);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.note, "awaiting_confirmations");
    settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");

    // Retry at exactly depth 5: the boundary finalizes.
    const five = mockRelayer({ receiptBlockNumber: 199_998n, chainHead: 200_003n });
    const third = await settleSubmission(submissionId, WORKER, five.deps);
    assert.equal(third.ok, true);
    if (third.ok) assert.equal(third.note, null);
    settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");

    // Across ALL attempts: exactly ONE broadcast — never a second transaction.
    assert.equal(
      shallow.calls.sends.length + four.calls.sends.length + five.calls.sends.length,
      1,
      "no additional broadcast while confirmations were insufficient"
    );
  } finally {
    restore();
    await deleteTask(task.id);
  }
});

test("M-2: a receipt at depth 0 does not finalize (reorg window)", async () => {
  const restore = setDepthEnv("5");
  const { task, submissionId } = await payableTask();
  try {
    // Just mined — the head IS the receipt's block.
    const justMined = mockRelayer({ receiptBlockNumber: 200_000n, chainHead: 200_000n });
    const result = await settleSubmission(submissionId, WORKER, justMined.deps);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.note, "awaiting_confirmations");
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, TX_HASH);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
    assert.equal(justMined.calls.sends.length, 1);
  } finally {
    restore();
    await deleteTask(task.id);
  }
});

test("M-2: a receipt with NO block number fails closed and stays retryable", async () => {
  const restore = setDepthEnv("5");
  const { task, submissionId } = await payableTask();
  try {
    // The RPC returns a receipt without a block number — the depth cannot be
    // proven, so finalization must NEVER happen.
    const blockless = mockRelayer({ receiptBlockNumber: null });
    const result = await settleSubmission(submissionId, WORKER, blockless.deps);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.note, "awaiting_confirmations");
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, TX_HASH);
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
    assert.equal(blockless.calls.sends.length, 1);

    // Retryable: once the RPC provides the block (far below the head), it
    // finalizes — with no new broadcast.
    const healed = mockRelayer({ receiptBlockNumber: 199_995n, chainHead: 200_000n });
    const retry = await settleSubmission(submissionId, WORKER, healed.deps);
    assert.equal(retry.ok, true);
    assert.equal(healed.calls.sends.length, 0, "never a second broadcast");
    const confirmed = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(confirmed?.status, "CONFIRMED");
  } finally {
    restore();
    await deleteTask(task.id);
  }
});

test("M-2: an invalid confirmation-depth configuration fails closed", async () => {
  const { task, submissionId } = await payableTask();
  const invalid = ["abc", "0", "-3", "1.5", "999999"];
  try {
    for (const value of invalid) {
      const restore = setDepthEnv(value);
      try {
        const broken = mockRelayer();
        const result = await settleSubmission(submissionId, WORKER, broken.deps);
        assert.equal(result.ok, false, `config "${value}" must fail closed`);
        if (!result.ok) {
          assert.equal(result.reason, "invalid_confirmations", JSON.stringify(value));
          assert.equal(result.status, 500);
        }
        // State is fully preserved — nothing finalized, nothing re-sent.
        const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
        assert.equal(settlement?.status, "BROADCAST", JSON.stringify(value));
        const fresh = await prisma.task.findUnique({ where: { id: task.id } });
        assert.equal(fresh?.status, "SETTLING", JSON.stringify(value));
      } finally {
        restore();
      }
    }
  } finally {
    await deleteTask(task.id);
  }
});

test("M-2: a chain head BEHIND the receipt block is a reorg — refused, retryable", async () => {
  const restore = setDepthEnv("5");
  const { task, submissionId } = await payableTask();
  try {
    // The head is 50 blocks BEHIND the receipt's block — an inconsistent
    // (reorged) view. The receipt cannot be trusted for finalization.
    const reorged = mockRelayer({ receiptBlockNumber: 200_050n, chainHead: 200_000n });
    const result = await settleSubmission(submissionId, WORKER, reorged.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "reorg_detected");
      assert.equal(result.status, 409);
    }
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST", "the claim is preserved");
    assert.equal(settlement?.txHash, TX_HASH, "the hash is preserved for re-verification");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");
    assert.equal(reorged.calls.sends.length, 1);

    // Retryable: a consistent later view (head beyond the receipt at depth)
    // finalizes with NO new broadcast.
    const healed = mockRelayer({ receiptBlockNumber: 200_050n, chainHead: 200_055n });
    const retry = await settleSubmission(submissionId, WORKER, healed.deps);
    assert.equal(retry.ok, true);
    assert.equal(healed.calls.sends.length, 0, "never a second broadcast");
    const confirmed = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(confirmed?.status, "CONFIRMED");
  } finally {
    restore();
    await deleteTask(task.id);
  }
});

test("M-2: RECOVERY also requires confirmation depth before finalizing", async () => {
  const restore = setDepthEnv("5");
  const { task, submissionId } = await payableTask();
  try {
    await crashWindowSettlement(submissionId, task.id);

    // Recovery finds and attaches the VERIFIED transaction — but it was just
    // mined (depth 2 of 5): attaching is allowed, FINALIZING is not.
    const recovery = mockRelayer({
      recoveryLogs: [recoveryLog()],
      receiptBlockNumber: 199_998n,
      chainHead: 200_000n,
    });
    const result = await settleSubmission(submissionId, WORKER, recovery.deps);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.note, "awaiting_confirmations");
    assert.equal(recovery.calls.sends.length, 0, "recovery NEVER broadcasts");
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST", "recovered but NOT yet confirmed");
    assert.equal(settlement?.txHash, TX_HASH, "the verified hash was attached");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "SETTLING");

    // Once the recovered transaction reaches depth, the SAME retry path
    // finalizes — still without any new broadcast.
    const deep = mockRelayer({ receiptBlockNumber: 199_998n, chainHead: 200_003n });
    const retry = await settleSubmission(submissionId, WORKER, deep.deps);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.note, null);
    assert.equal(deep.calls.sends.length, 0, "still never a second broadcast");
    const confirmed = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(confirmed?.status, "CONFIRMED");
    const done = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(done?.status, "COMPLETED");
  } finally {
    restore();
    await deleteTask(task.id);
  }
});

test("FIX 2 regression: send succeeds, txHash DB write fails — structured result, recoverable hash, no re-send", async () => {
  const { task, submissionId } = await payableTask();
  const { deps, calls } = mockRelayer();
  // Patch the shared Prisma singleton IN-PROCESS to simulate the row update
  // failure exactly at the txHash persist (the guarded claim still works).
  const settlementModel = prisma.settlement as unknown as {
    updateMany: (args: { data?: { txHash?: string } }) => Promise<unknown>;
  };
  const originalUpdateMany = settlementModel.updateMany.bind(prisma.settlement);
  let persistFailed = false;
  try {
    settlementModel.updateMany = async (args) => {
      if (args?.data && typeof args.data.txHash === "string") {
        persistFailed = true;
        throw new Error("simulated DB write failure");
      }
      return originalUpdateMany(args as never);
    };

    const result = await settleSubmission(submissionId, WORKER, deps);
    assert.equal(persistFailed, true, "the persist failure was triggered");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "broadcast_persist_failed");
      assert.equal(result.status, 500);
    }
    // Exactly ONE transfer was ever sent; no retry happened.
    assert.equal(calls.sends.length, 1);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "BROADCAST");
    assert.equal(settlement?.txHash, null);

    // The txHash is PRESERVED in the recoverable server-side path: the
    // truthful SETTLEMENT_BROADCAST audit event (written before the row).
    const broadcasts = await prisma.taskEvent.findMany({
      where: { taskId: task.id, eventType: "SETTLEMENT_BROADCAST" },
    });
    assert.equal(broadcasts.length, 1);
    const payload = JSON.parse(broadcasts[0].payload ?? "{}");
    assert.equal(payload.txHash, TX_HASH, "the hash survives in the audit trail");
    assert.equal(payload.recipient, WORKER);
    assert.equal(payload.amount, AMOUNT);
  } finally {
    settlementModel.updateMany = originalUpdateMany as never;
    await deleteTask(task.id);
  }
});

// ─── FIX 3: Transfer-event verification matrix ─────────────────

test("a receipt with the correct Transfer event confirms", async () => {
  const { task, submissionId } = await payableTask();
  try {
    const result = await settleSubmission(submissionId, WORKER, mockRelayer().deps);
    assert.equal(result.ok, true);
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");
  } finally {
    await deleteTask(task.id);
  }
});

test("a successful receipt with the WRONG transfer details never confirms", async () => {
  const wrongCases: Array<{ label: string; logs: unknown[] }> = [
    {
      label: "wrong token contract",
      logs: [transferLog({ from: REQUESTER, to: WORKER, value: parseUnits(AMOUNT, 18), token: OTHER_TOKEN })],
    },
    {
      label: "wrong sender",
      logs: [transferLog({ from: STRANGER, to: WORKER, value: parseUnits(AMOUNT, 18) })],
    },
    {
      label: "wrong recipient",
      logs: [transferLog({ from: REQUESTER, to: STRANGER, value: parseUnits(AMOUNT, 18) })],
    },
    {
      label: "wrong amount",
      logs: [transferLog({ from: REQUESTER, to: WORKER, value: parseUnits("999", 18) })],
    },
    { label: "missing Transfer event", logs: [] },
    {
      label: "unparseable logs",
      logs: [{ address: WHITELISTED, topics: ["0xdeadbeef"], data: "0x" }],
    },
  ];

  for (const wrong of wrongCases) {
    const { task, submissionId } = await payableTask();
    try {
      const result = await settleSubmission(
        submissionId,
        WORKER,
        mockRelayer({ receiptLogs: wrong.logs }).deps
      );
      assert.equal(result.ok, false, wrong.label);
      if (!result.ok) {
        assert.equal(result.reason, "transfer_verification_failed", wrong.label);
        assert.equal(result.status, 409, wrong.label);
      }
      // NO confirmation: settlement stays BROADCAST with the hash preserved
      // for re-verification; the task is NOT completed.
      const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
      assert.equal(settlement?.status, "BROADCAST", wrong.label);
      assert.equal(settlement?.txHash, TX_HASH, wrong.label);
      const fresh = await prisma.task.findUnique({ where: { id: task.id } });
      assert.equal(fresh?.status, "SETTLING", wrong.label);
      assert.equal(
        (await prisma.taskEvent.findMany({
          where: { taskId: task.id, eventType: "SETTLEMENT_COMPLETED" },
        })).length,
        0,
        `${wrong.label}: nothing may claim confirmation`
      );
      // The failure is truthfully audited with the verification detail.
      const rejected = await prisma.taskEvent.findMany({
        where: { taskId: task.id, eventType: "SETTLEMENT_REJECTED" },
      });
      assert.equal(rejected.length, 1, wrong.label);
      const payload = JSON.parse(rejected[0].payload ?? "{}");
      assert.equal(payload.reason, "transfer_verification_failed", wrong.label);
    } finally {
      await deleteTask(task.id);
    }
  }
});

test("a mismatched receipt can be re-verified later (idempotent, no re-send)", async () => {
  const { task, submissionId } = await payableTask();
  try {
    // First attempt: receipt claims success but logs are empty.
    const bad = await settleSubmission(
      submissionId,
      WORKER,
      mockRelayer({ receiptLogs: [] }).deps
    );
    assert.equal(bad.ok, false);

    // Retry reads the PERSISTED hash only: the correct Transfer event is now
    // visible (e.g. a lagging RPC node caught up) and confirmation proceeds.
    const retry = await settleSubmission(submissionId, WORKER, mockRelayer().deps);
    assert.equal(retry.ok, true);
    if (retry.ok) {
      assert.equal(retry.transaction?.status, "CONFIRMED");
      assert.equal(retry.transaction?.txHash, TX_HASH);
    }
    const settlement = await prisma.settlement.findUnique({ where: { submissionId } });
    assert.equal(settlement?.status, "CONFIRMED");
    const fresh = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(fresh?.status, "COMPLETED");
  } finally {
    await deleteTask(task.id);
  }
});