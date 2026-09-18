/**
 * CeloTasker — Settlement executor (Stage 5C).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * Orchestration on top of the UNCHANGED Stage 4.2 authorization gate
 * (lib/workflow/SettlementService.requestSettlement — still the only component
 * that may create a Settlement and move a task to SETTLING):
 *
 *   1. Authorize          — the Stage 4.2 gate (submitter binding, server-
 *                            derived recipient/amount/token, whitelist).
 *   2. Lock               — the gate's guarded UNDER_REVIEW → SETTLING
 *                            transition + unique Settlement.submissionId.
 *   3. Build              — ERC-20 transferFrom calldata + ERC-8021 suffix,
 *                            decimals read from the token contract, allowance
 *                            (owner → relayer) verified. Nothing from clients.
 *   4. Broadcast          — PENDING → BROADCAST claim (guarded; exactly one
 *                            executor ever sends), txHash persisted
 *                            IMMEDIATELY after a successful broadcast.
 *   5. Confirm            — wait for the receipt; ONLY receipt.status ===
 *                            "success" authorizes SETTLED → COMPLETED through
 *                            the frozen state machine.
 *
 * IDEMPOTENCY (one approved submission → at most ONE successful settlement):
 * - Duplicate requests re-enter through the persisted settlement row.
 * - A BROADCAST settlement is NEVER re-sent: recovery re-checks the receipt
 *   of the PERSISTED txHash only.
 * - A BROADCAST row with a null txHash (crash window between claim and
 *   broadcast) is treated as ambiguous and refused — never blindly re-sent.
 * - A reverted receipt is terminal: settlement FAILED, task PAYMENT_FAILED.
 *
 * No scheduler, no UI, no arbitrary tokens/recipients/calldata.
 */
import { Prisma, type Settlement } from "@prisma/client";
import { prisma } from "../prisma.ts";
import { recordTaskEvent } from "../audit/AuditLog.ts";
import { transitionTask } from "../workflow/TaskService.ts";
import { requestSettlement } from "../workflow/SettlementService.ts";
import {
  CHAIN_IDS,
  SETTLEMENT_TOKEN_WHITELIST,
  TIMEOUTS,
} from "../security/SecurityPolicy.ts";
import {
  createDefaultRelayerDeps,
  readTokenDecimals,
  readAllowance,
  buildSettlementCalldata,
  broadcastTransferFrom,
  waitForSettlementReceipt,
  verifyTransferEvent,
  findMatchingBroadcast,
  type RelayerDeps,
  type RelayerReceipt,
  type ExpectedTransfer,
} from "./CeloRelayer.ts";
import { resolveSettlementConfirmationDepth } from "./RelayerConfig.ts";

export interface TransactionInfo {
  txHash: string;
  status: "BROADCAST" | "CONFIRMED";
  chainId: number;
  blockNumber: number | null;
}

export type SettleResult =
  | {
      ok: true;
      settlement: Settlement;
      transaction: TransactionInfo | null;
      /** e.g. "execution_unavailable" | "awaiting_confirmation" | "already_settled". */
      note: string | null;
    }
  | { ok: false; reason: string; status: number };

/** Sentinel: a guarded write raced — roll back, never record a false outcome. */
class ExecutorConflictError extends Error {
  constructor() {
    super("Settlement state changed concurrently; rolled back");
    this.name = "ExecutorConflictError";
  }
}

/** Failure metadata recorded in the audit trail (secret-free). */
function failureMetadata(reason: string, extra: Record<string, unknown> = {}) {
  return { reason, chainId: CHAIN_IDS.CELO_MAINNET, ...extra };
}

/**
 * M-A: is this Prisma error a UNIQUE-constraint violation on Settlement.txHash?
 *
 * Only called from the two writes that attach a txHash (the post-broadcast
 * persist and the recovery attach), where txHash is the ONLY unique column
 * being modified — `Settlement.submissionId` is never written by them. A P2002
 * there therefore identifies the txHash constraint; Prisma reports the
 * offending field(s) in `meta.target` (array or string) when the connector
 * supplies them, and SQLite does not always do so, hence an absent target is
 * accepted as this constraint too. Any other error — including a P2002 naming
 * a different field — keeps the pre-existing path.
 */
function isTxHashUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  if (fields.length === 0) return true;
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes("txhash"));
}

/**
 * M-A: the SAME transaction was found by two settlements trying to claim it.
 *
 * The hash is already owned elsewhere, so this settlement must NOT treat it as
 * its own payment. Fail closed: the BROADCAST claim (with its null txHash) is
 * preserved for manual operator recovery, nothing is broadcast again, and the
 * settlement is never marked confirmed. Returns the deterministic
 * ambiguous-recovery conflict (409) used by the existing ambiguity path.
 */
async function ambiguousRecoveryConflict(
  taskId: string,
  actorAddress: string,
  settlement: { id: string; submissionId: string },
  evidence: Record<string, unknown>
): Promise<SettleResult> {
  await recordTaskEvent({
    taskId,
    eventType: "SETTLEMENT_REJECTED",
    actor: actorAddress,
    metadata: failureMetadata("ambiguous_recovery", {
      settlementId: settlement.id,
      submissionId: settlement.submissionId,
      note: "the recovered transaction hash is already owned by another settlement; attachment and re-sending are refused",
      ...evidence,
    }),
  }).catch(() => {});
  return { ok: false, reason: "ambiguous_recovery", status: 409 };
}

/**
 * Entry point used by the route: authorize (Stage 4.2 gate) and execute.
 * Fully idempotent — safe for duplicate, concurrent and post-crash retries.
 */
export async function settleSubmission(
  submissionId: string,
  actorAddress: string,
  deps?: RelayerDeps | null
): Promise<SettleResult> {
  // Idempotent re-entry: a settlement may already exist (duplicate request,
  // retry after a timeout, or recovery after a crash).
  const existing = await prisma.settlement.findUnique({ where: { submissionId } });
  if (existing) {
    if (existing.recipient !== actorAddress) {
      return { ok: false, reason: "forbidden", status: 403 };
    }
    return resumeSettlement(existing, actorAddress, deps);
  }

  // AUTHORIZE — the unchanged Stage 4.2 gate remains the security boundary.
  const gate = await requestSettlement(submissionId, actorAddress);
  if (!gate.ok) {
    // A concurrent request may have won the gate and created the settlement
    // between our lookup and the gate's guard; recover via the persisted row.
    if (gate.reason.startsWith("task_not_under_review:")) {
      const raced = await prisma.settlement.findUnique({ where: { submissionId } });
      if (raced && raced.recipient === actorAddress) {
        return resumeSettlement(raced, actorAddress, deps);
      }
    }
    return { ok: false, reason: gate.reason, status: gate.status };
  }

  // Authorized and locked (task SETTLING, unique settlement row PENDING).
  return executeSettlement(gate.data.id, actorAddress, deps);
}

/** Continue an existing settlement from its persisted state — never re-authorize. */
async function resumeSettlement(
  settlement: Settlement,
  actorAddress: string,
  deps?: RelayerDeps | null
): Promise<SettleResult> {
  if (settlement.status === "CONFIRMED") {
    // Already settled: idempotent success, never a second transfer.
    return {
      ok: true,
      settlement,
      transaction: settlement.txHash
        ? {
            txHash: settlement.txHash,
            status: "CONFIRMED",
            chainId: CHAIN_IDS.CELO_MAINNET,
            blockNumber: null,
          }
        : null,
      note: "already_settled",
    };
  }
  if (settlement.status === "FAILED") {
    return { ok: false, reason: "settlement_failed", status: 409 };
  }
  if (settlement.status === "BROADCAST") {
    return confirmSettlement(settlement.id, actorAddress, deps);
  }
  // PENDING: execute it (the gate already authorized this row).
  return executeSettlement(settlement.id, actorAddress, deps);
}

/**
 * Execute a PENDING settlement: pre-flight checks (chain, whitelist, binding,
 * decimals, allowance), claim the exclusive broadcast right, broadcast, persist
 * the txHash immediately, then confirm via the receipt.
 */
async function executeSettlement(
  settlementId: string,
  actorAddress: string,
  deps?: RelayerDeps | null
): Promise<SettleResult> {
  const settlement = await prisma.settlement.findUnique({ where: { id: settlementId } });
  if (!settlement) return { ok: false, reason: "not_found", status: 404 };
  const task = await prisma.task.findUnique({ where: { id: settlement.taskId } });
  const submission = await prisma.submission.findUnique({
    where: { id: settlement.submissionId },
  });
  if (!task || !submission) {
    return { ok: false, reason: "internal", status: 500 };
  }

  // Resolve relayer deps. Missing/invalid configuration FAILS SAFE: the
  // authorized settlement stays PENDING and can be executed later.
  const resolvedDeps = deps !== undefined ? deps : createDefaultRelayerDeps();
  if (!resolvedDeps) {
    return {
      ok: true,
      settlement,
      transaction: null,
      note: "execution_unavailable",
    };
  }

  const commonAudit = {
    settlementId: settlement.id,
    submissionId: settlement.submissionId,
    taskId: task.id,
    token: settlement.rewardToken,
    recipient: settlement.recipient,
    amount: settlement.amount,
    chainId: resolvedDeps.chainId,
  };
  const reject = async (
    reason: string,
    status: number,
    extra: Record<string, unknown> = {}
  ) => {
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata(reason, { ...commonAudit, ...extra }),
    });
    return { ok: false as const, reason, status };
  };

  // The task must still be SETTLING (the gate's lock is intact).
  if (task.status !== "SETTLING") {
    return { ok: false, reason: "task_state_conflict", status: 409 };
  }

  // Defense in depth: the mainnet whitelist is the executable set.
  const whitelist = SETTLEMENT_TOKEN_WHITELIST[CHAIN_IDS.CELO_MAINNET];
  const token = settlement.rewardToken.toLowerCase();
  if (!whitelist.includes(token)) {
    return reject("unsupported_token", 403);
  }

  // Defense in depth: the persisted recipient must be the submitter.
  if (settlement.recipient !== submission.submitter) {
    return reject("recipient_mismatch", 409);
  }

  // Chain verification: settlement runs on Celo MAINNET only. A mispointed
  // RPC (e.g. a testnet URL) is refused — never a silent fallback.
  const chainId = await resolvedDeps.publicClient.getChainId();
  if (
    chainId !== resolvedDeps.chainId ||
    resolvedDeps.chainId !== CHAIN_IDS.CELO_MAINNET
  ) {
    return reject("wrong_chain", 409, { actualChainId: chainId });
  }

  // Decimals are read from the verified token contract — never hardcoded,
  // never client-supplied.
  let decimals: number;
  try {
    decimals = await readTokenDecimals(resolvedDeps, token);
  } catch (err) {
    return reject("invalid_decimals", 409, { detail: (err as Error).message });
  }

  // Convert the trusted task amount using the on-chain decimals and append
  // the ERC-8021 attribution suffix (server-side tag only).
  let calldata;
  try {
    calldata = buildSettlementCalldata({
      owner: task.creator, // the requester funds the reward (transferFrom owner)
      recipient: settlement.recipient,
      amount: settlement.amount,
      decimals,
      attributionTag: resolvedDeps.attributionTag,
    });
  } catch {
    return reject("invalid_reward", 409);
  }

  // Allowance(owner → relayer) must cover the amount. No approval flow is
  // ever invented here — the requester approves the relayer off-chain.
  const owner = task.creator;
  const spender = resolvedDeps.relayerAddress;
  let allowance: bigint;
  try {
    allowance = await readAllowance(resolvedDeps, { token, owner, spender });
  } catch {
    return reject("allowance_unreadable", 502);
  }
  if (allowance < calldata.amountBaseUnits) {
    return reject("insufficient_allowance", 409, {
      owner,
      spender,
      required: calldata.amountBaseUnits.toString(),
      actual: allowance.toString(),
    });
  }

  // CLAIM the exclusive broadcast right: guarded PENDING → BROADCAST. Exactly
  // one concurrent executor can pass; the others fall back to the persisted
  // state (confirm path) and never send a second transaction.
  const claimed = await prisma.settlement.updateMany({
    where: { id: settlement.id, status: "PENDING" },
    data: { status: "BROADCAST" },
  });
  if (claimed.count !== 1) {
    return { ok: false, reason: "task_state_conflict", status: 409 };
  }

  // Broadcast through the dedicated relayer wallet.
  let txHash: string;
  try {
    txHash = await broadcastTransferFrom(resolvedDeps, { token, data: calldata.data });
  } catch (err) {
    console.error("settlement broadcast failed:", err);
    // H-1 (fail closed): a sendTransaction error does NOT prove that no
    // transaction was broadcast. The RPC may have accepted the transaction
    // before the error surfaced (response lost, connection reset, timeout),
    // and the viem API provides no reliable pre-submission/ambiguous
    // distinction. The claim is therefore NEVER released: the settlement
    // stays BROADCAST with a null txHash, and every future retry is routed
    // through the VERIFIED recovery scan — a second transaction is never
    // broadcast for this settlement.
    return reject("broadcast_failed_ambiguous", 502, {
      settlementId: settlement.id,
      note: "submission status ambiguous; broadcast claim retained, re-send refused",
    });
  }

  // The transaction IS on chain. NEVER send another one for this settlement —
  // all failure handling below is persistence/recovery only.

  // 1. Truthful audit event FIRST: it is the recoverable server-side record
  //    of the txHash if the row update below fails (different table).
  let auditWritten = false;
  try {
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_BROADCAST",
      actor: actorAddress,
      metadata: {
        ...commonAudit,
        txHash,
        owner,
        spender,
        amountBaseUnits: calldata.amountBaseUnits.toString(),
      },
    });
    auditWritten = true;
  } catch (err) {
    console.error("settlement broadcast audit write failed:", err);
  }

  // 2. Persist the txHash on the settlement row (guarded). If this fails the
  //    settlement stays BROADCAST + null txHash — recovery re-verifies the
  //    chain (findMatchingBroadcast) instead of ever re-sending.
  try {
    await prisma.settlement.updateMany({
      where: { id: settlement.id, status: "BROADCAST", txHash: null },
      data: { txHash },
    });
  } catch (err) {
    // M-A: the unique constraint on txHash rejected the write because ANOTHER
    // settlement already owns this transaction — the same broadcast has now
    // been discovered by two settlements (e.g. a relayer re-sent the identical
    // calldata from a reused nonce and the node produced the same hash). It is
    // impossible to prove which settlement this payment belongs to, so this
    // one fails closed: the BROADCAST claim is preserved with a null txHash
    // (never confirmed, never re-sent) and manual operator recovery is needed.
    if (isTxHashUniqueViolation(err)) {
      console.error("settlement txHash already owned by another settlement");
      return await ambiguousRecoveryConflict(task.id, actorAddress, settlement, {
        txHash,
        phase: "broadcast_persist",
      });
    }
    console.error("settlement txHash persistence failed:", err);
    return {
      ok: false,
      reason: auditWritten
        ? "broadcast_persist_failed"
        : "broadcast_persist_failed_no_audit",
      status: 500,
    };
  }

  return await confirmByReceipt(
    settlement.id,
    actorAddress,
    resolvedDeps,
    txHash,
    {
      token,
      from: owner,
      to: settlement.recipient,
      value: calldata.amountBaseUnits,
    }
  );
}

/**
 * M-2: structured, retryable "not deep enough yet" result. The settlement
 * keeps its BROADCAST claim and (persisted or recovered) txHash; a later
 * idempotent settle request re-enters confirmByReceipt and finalizes once
 * the required depth is reached. Nothing is ever re-broadcast.
 */
function awaitingConfirmations(
  settlement: Settlement,
  txHash: string,
  chainId: number,
  receiptBlock: bigint | null
): SettleResult {
  return {
    ok: true,
    settlement,
    transaction: {
      txHash,
      status: "BROADCAST",
      chainId,
      blockNumber: receiptBlock !== null ? Number(receiptBlock) : null,
    },
    note: "awaiting_confirmations",
  };
}

/**
 * Confirm a BROADCAST settlement by waiting for the receipt of the PERSISTED
 * txHash. NEVER sends a new transaction.
 *
 * BROADCAST + null txHash (the crash window between broadcast and hash
 * persistence) is recovered DETERMINISTICALLY: the chain is scanned for the
 * exact expected Transfer event whose transaction carries byte-identical
 * calldata (transferFrom + ERC-8021 suffix). Only a verified match is
 * attached — a recovered hash never causes another broadcast. When no
 * matching transaction is found, the refusal is structured and audited
 * (never a re-send).
 */
async function confirmSettlement(
  settlementId: string,
  actorAddress: string,
  deps?: RelayerDeps | null
): Promise<SettleResult> {
  const settlement = await prisma.settlement.findUnique({ where: { id: settlementId } });
  if (!settlement) return { ok: false, reason: "not_found", status: 404 };
  const task = await prisma.task.findUnique({ where: { id: settlement.taskId } });
  if (!task) return { ok: false, reason: "internal", status: 500 };

  const resolvedDeps = deps !== undefined ? deps : createDefaultRelayerDeps();

  if (settlement.txHash) {
    if (!resolvedDeps) {
      return {
        ok: true,
        settlement,
        transaction: {
          txHash: settlement.txHash,
          status: "BROADCAST",
          chainId: CHAIN_IDS.CELO_MAINNET,
          blockNumber: null,
        },
        note: "execution_unavailable",
      };
    }
    const expectedTransfer = await computeExpectedTransfer(resolvedDeps, settlement, task);
    if ("error" in expectedTransfer) {
      return { ok: false, reason: expectedTransfer.error, status: 409 };
    }
    return await confirmByReceipt(
      settlement.id,
      actorAddress,
      resolvedDeps,
      settlement.txHash,
      expectedTransfer.expected
    );
  }

  // Crash window: claimed (BROADCAST) but no txHash was ever persisted.
  if (!resolvedDeps) {
    // Nothing can be verified without chain access: fail safe, never re-send.
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata("ambiguous_broadcast", {
        settlementId: settlement.id,
        submissionId: settlement.submissionId,
      }),
    }).catch(() => {});
    return { ok: false, reason: "ambiguous_broadcast", status: 409 };
  }

  // DETERMINISTIC RECOVERY: verify the actual on-chain transaction before
  // attaching any hash. This never broadcasts anything.
  const expectedTransfer = await computeExpectedTransfer(resolvedDeps, settlement, task);
  if ("error" in expectedTransfer) {
    return { ok: false, reason: expectedTransfer.error, status: 409 };
  }
  return await recoverAndConfirm(
    settlement,
    task,
    actorAddress,
    resolvedDeps,
    expectedTransfer
  );
}

/** Scan the chain for the verified broadcast, attach it, then confirm. */
async function recoverAndConfirm(
  settlement: Settlement,
  task: { id: string; creator: string },
  actorAddress: string,
  resolvedDeps: RelayerDeps,
  expectedTransfer: { expected: ExpectedTransfer; calldata: string }
): Promise<SettleResult> {
  let candidates: string[];
  try {
    candidates = await findMatchingBroadcast(resolvedDeps, {
      expected: expectedTransfer.expected,
      calldata: expectedTransfer.calldata,
      relayerAddress: resolvedDeps.relayerAddress,
      broadcastAfter: settlement.createdAt,
    });
  } catch (err) {
    console.error("broadcast recovery scan failed:", err);
    return { ok: false, reason: "recovery_scan_failed", status: 502 };
  }

  if (candidates.length === 0) {
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata("no_matching_broadcast", {
        settlementId: settlement.id,
        submissionId: settlement.submissionId,
        token: expectedTransfer.expected.token,
        recipient: expectedTransfer.expected.to,
        amountBaseUnits: expectedTransfer.expected.value.toString(),
        note: "no on-chain transaction matched the expected calldata; re-sending is refused",
      }),
    }).catch(() => {});
    return { ok: false, reason: "no_matching_broadcast", status: 409 };
  }

  // M-1: a hash already attached to ANOTHER settlement is that settlement's
  // payment — it can never be proof of THIS settlement's broadcast. Identical
  // (creator → worker → amount → token → tag) settlements produce byte-identical
  // calldata, so another task's confirmed transaction WILL pass the on-chain
  // checks; only this ownership filter distinguishes it.
  const taken = await prisma.settlement.findMany({
    where: { txHash: { in: candidates } },
    select: { txHash: true },
  });
  const takenHashes = new Set(taken.map((s) => (s.txHash ?? "").toLowerCase()));
  const available = candidates.filter((h) => !takenHashes.has(h.toLowerCase()));

  if (available.length === 0) {
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata("no_matching_broadcast", {
        settlementId: settlement.id,
        submissionId: settlement.submissionId,
        token: expectedTransfer.expected.token,
        recipient: expectedTransfer.expected.to,
        amountBaseUnits: expectedTransfer.expected.value.toString(),
        note: "every verified candidate transaction is already attached to another settlement; re-sending is refused",
      }),
    }).catch(() => {});
    return { ok: false, reason: "no_matching_broadcast", status: 409 };
  }

  // M-1 fail-closed: multiple indistinguishable verified candidates. Never
  // guess — a wrong attachment corrupts the payment record and can mark a
  // settlement paid that never was. The BROADCAST claim is preserved and
  // operator/manual recovery is required.
  if (available.length > 1) {
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata("ambiguous_recovery", {
        settlementId: settlement.id,
        submissionId: settlement.submissionId,
        candidateCount: available.length,
        note: "multiple verified candidate transactions; manual operator recovery required; re-sending is refused",
      }),
    }).catch(() => {});
    return { ok: false, reason: "ambiguous_recovery", status: 409 };
  }

  let recoveredHash = available[0];

  // Attach the VERIFIED hash (guarded: exactly one recoverer wins; a
  // concurrent attach of the same hash is harmless).
  //
  // M-A: this write is additionally protected by the database-level UNIQUE
  // constraint on Settlement.txHash. The ownership filter above (SELECT) and
  // this attach (UPDATE) are separate statements, so two concurrent recoverers
  // can both pass the filter with the same verified hash; the database then
  // rejects the loser with P2002 instead of letting a single payment be claimed
  // by two settlements.
  let attached: { count: number };
  try {
    attached = await prisma.settlement.updateMany({
      where: { id: settlement.id, status: "BROADCAST", txHash: null },
      data: { txHash: recoveredHash },
    });
  } catch (err) {
    if (isTxHashUniqueViolation(err)) {
      console.error("recovered txHash already owned by another settlement");
      return await ambiguousRecoveryConflict(task.id, actorAddress, settlement, {
        txHash: recoveredHash,
        phase: "recovery_attach",
      });
    }
    // Any other write failure keeps the pre-existing behaviour.
    throw err;
  }
  if (attached.count !== 1) {
    const fresh = await prisma.settlement.findUnique({ where: { id: settlement.id } });
    if (!fresh?.txHash) {
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }
    recoveredHash = fresh.txHash;
  }

  await recordTaskEvent({
    taskId: task.id,
    eventType: "SETTLEMENT_BROADCAST",
    actor: actorAddress,
    metadata: {
      settlementId: settlement.id,
      submissionId: settlement.submissionId,
      taskId: task.id,
      token: expectedTransfer.expected.token,
      recipient: expectedTransfer.expected.to,
      amount: settlement.amount,
      chainId: resolvedDeps.chainId,
      txHash: recoveredHash,
      owner: task.creator,
      spender: resolvedDeps.relayerAddress,
      amountBaseUnits: expectedTransfer.expected.value.toString(),
      recovered: true,
      verification: "byte-identical calldata + expected Transfer event",
    },
  }).catch(() => {});

  return await confirmByReceipt(
    settlement.id,
    actorAddress,
    resolvedDeps,
    recoveredHash,
    expectedTransfer.expected
  );
}

/** Re-derive the expected transfer and calldata from trusted records. */
async function computeExpectedTransfer(
  deps: RelayerDeps,
  settlement: { rewardToken: string; recipient: string; amount: string },
  task: { creator: string }
): Promise<
  | { expected: ExpectedTransfer; calldata: string }
  | { error: "invalid_decimals" | "invalid_reward" }
> {
  const token = settlement.rewardToken.toLowerCase();
  let decimals: number;
  try {
    decimals = await readTokenDecimals(deps, token);
  } catch {
    return { error: "invalid_decimals" };
  }
  let calldata;
  try {
    calldata = buildSettlementCalldata({
      owner: task.creator,
      recipient: settlement.recipient,
      amount: settlement.amount,
      decimals,
      attributionTag: deps.attributionTag,
    });
  } catch {
    return { error: "invalid_reward" };
  }
  return {
    expected: {
      token,
      from: task.creator,
      to: settlement.recipient,
      value: calldata.amountBaseUnits,
    },
    calldata: calldata.data,
  };
}

/**
 * Wait for the receipt of the persisted txHash and finalize:
 * - verify the chain is still Celo Mainnet (42220);
 * - verify the receipt contains the expected ERC-20 Transfer event (token,
 *   from = payment owner, to = worker recipient, value = exact base units);
 * - success  → settlement CONFIRMED + task SETTLING → SETTLED → COMPLETED
 *              (guarded state machine transitions, one transaction);
 * - reverted → settlement FAILED + task SETTLING → PAYMENT_FAILED (terminal);
 * - verification failure → NO confirmation; settlement stays BROADCAST with
 *   the persisted hash for re-verification/operator review (never re-sent);
 * - timeout  → stays BROADCAST + txHash; retryable, never re-sent.
 *
 * A successful receipt status AND a matching Transfer event are the ONLY
 * authority for SETTLED/COMPLETED.
 */
async function confirmByReceipt(
  settlementId: string,
  actorAddress: string,
  deps: RelayerDeps,
  txHash: string,
  expected: ExpectedTransfer
): Promise<SettleResult> {
  const settlement = await prisma.settlement.findUnique({ where: { id: settlementId } });
  if (!settlement) return { ok: false, reason: "not_found", status: 404 };
  const task = await prisma.task.findUnique({ where: { id: settlement.taskId } });
  if (!task) return { ok: false, reason: "internal", status: 500 };

  // M-2: the required confirmation depth is SERVER configuration only —
  // never a client-supplied value. An invalid/unsafe configuration fails
  // closed: the settlement is never finalized.
  const requiredDepth = resolveSettlementConfirmationDepth();
  if (requiredDepth === null) {
    console.error(
      "settlement confirmation depth configuration is invalid (SETTLEMENT_CONFIRMATION_DEPTH); refusing to finalize"
    );
    return { ok: false, reason: "invalid_confirmations", status: 500 };
  }

  // The transaction must be on Celo Mainnet — a mispointed RPC is refused.
  try {
    const chainId = await deps.publicClient.getChainId();
    if (chainId !== deps.chainId || deps.chainId !== CHAIN_IDS.CELO_MAINNET) {
      return { ok: false, reason: "wrong_chain", status: 409 };
    }
  } catch (err) {
    console.error("chain verification failed:", err);
    return { ok: false, reason: "recovery_scan_failed", status: 502 };
  }

  let receipt: RelayerReceipt;
  try {
    // viem's native confirmation-depth wait: the real client only resolves
    // once the transaction is buried under `requiredDepth` blocks. The
    // explicit gate below remains the AUTHORITY (M-2).
    receipt = await waitForSettlementReceipt(
      deps,
      txHash,
      TIMEOUTS.RELAYER_TX_TIMEOUT_MS,
      requiredDepth
    );
  } catch (err) {
    // The transaction IS broadcast (txHash persisted). Ambiguity is resolved
    // by re-reading the receipt later — NEVER by sending another transfer.
    console.error("settlement receipt wait failed:", err);
    return {
      ok: true,
      settlement,
      transaction: {
        txHash,
        status: "BROADCAST",
        chainId: deps.chainId,
        blockNumber: null,
      },
      note: "awaiting_confirmation",
    };
  }

  // ─── M-2 CONFIRMATION-DEPTH GATE (authoritative) ────────────────
  // A receipt at depth 0 can still be reorged out. NO final decision —
  // neither CONFIRMED/COMPLETED nor the terminal FAILED — is made until the
  // transaction is buried under the server-configured depth. Insufficient
  // depth defers to a later idempotent retry; nothing is ever re-broadcast.
  try {
    const head = await deps.publicClient.getBlockNumber();
    const receiptBlock = receipt.blockNumber;
    if (receiptBlock === null || receiptBlock === undefined) {
      // No provable depth without the receipt's block — fail closed, retry.
      console.warn(
        "settlement receipt carries no block number; depth cannot be proven; not confirming"
      );
      return awaitingConfirmations(settlement, txHash, deps.chainId, null);
    }
    if (head < receiptBlock) {
      // The chain head is BEHIND the receipt — a reorg or an inconsistent RPC
      // view. The receipt can no longer be trusted for finalization.
      console.error("chain head behind receipt block — reorg or RPC inconsistency");
      return { ok: false, reason: "reorg_detected", status: 409 };
    }
    const depth = head - receiptBlock; // BigInt arithmetic
    if (depth < BigInt(requiredDepth)) {
      return awaitingConfirmations(settlement, txHash, deps.chainId, receiptBlock);
    }
  } catch (err) {
    console.error("confirmation depth check failed:", err);
    return { ok: false, reason: "recovery_scan_failed", status: 502 };
  }

  const commonAudit = {
    settlementId: settlement.id,
    submissionId: settlement.submissionId,
    taskId: task.id,
    token: settlement.rewardToken,
    recipient: settlement.recipient,
    amount: settlement.amount,
    txHash,
    chainId: deps.chainId,
    blockNumber:
      receipt.blockNumber !== null ? receipt.blockNumber.toString() : null,
  };

  if (receipt.status !== "success") {
    // Reverted on chain: terminal failure. Never SETTLED/COMPLETED.
    try {
      await prisma.$transaction(async (tx) => {
        const failed = await tx.settlement.updateMany({
          where: { id: settlement.id, status: "BROADCAST" },
          data: { status: "FAILED" },
        });
        if (failed.count !== 1) throw new ExecutorConflictError();
        const moved = await transitionTask(tx, task.id, "SETTLING", "PAYMENT_FAILED");
        if (!moved) throw new ExecutorConflictError();
        await tx.taskEvent.create({
          data: {
            taskId: task.id,
            eventType: "PAYMENT_FAILED",
            actor: actorAddress,
            payload: JSON.stringify({ ...commonAudit, reason: "receipt_reverted" }),
          },
        });
      });
    } catch (err) {
      return handleFinalizeError(err, task.id, actorAddress, settlement.id);
    }
    return { ok: false, reason: "receipt_reverted", status: 502 };
  }

  // Receipt succeeded — now verify the actual ERC-20 Transfer event before
  // anything is confirmed. Decoded through the ERC-20 event ABI; never
  // client input, never string matching.
  const verification = verifyTransferEvent(receipt.logs, expected);
  if (!verification.ok) {
    // Do NOT confirm. Keep the settlement BROADCAST + txHash so the receipt
    // can be re-verified or an operator can investigate; never re-send.
    await recordTaskEvent({
      taskId: task.id,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata("transfer_verification_failed", {
        ...commonAudit,
        detail: verification.detail,
        expectedToken: expected.token,
        expectedFrom: expected.from,
        expectedTo: expected.to,
        expectedValue: expected.value.toString(),
      }),
    }).catch(() => {});
    return { ok: false, reason: "transfer_verification_failed", status: 409 };
  }

  // SUCCESS: only now may the settlement be CONFIRMED and the task completed,
  // atomically through the frozen state machine.
  try {
    await prisma.$transaction(async (tx) => {
      const confirmed = await tx.settlement.updateMany({
        where: { id: settlement.id, status: "BROADCAST" },
        data: { status: "CONFIRMED" },
      });
      if (confirmed.count !== 1) throw new ExecutorConflictError();
      const settled = await transitionTask(tx, task.id, "SETTLING", "SETTLED");
      if (!settled) throw new ExecutorConflictError();
      const completed = await transitionTask(tx, task.id, "SETTLED", "COMPLETED");
      if (!completed) throw new ExecutorConflictError();
      await tx.taskEvent.create({
        data: {
          taskId: task.id,
          eventType: "SETTLEMENT_COMPLETED",
          actor: actorAddress,
          payload: JSON.stringify(commonAudit),
        },
      });
    });
  } catch (err) {
    return handleFinalizeError(err, task.id, actorAddress, settlement.id);
  }

  const fresh = await prisma.settlement.findUnique({ where: { id: settlement.id } });
  return {
    ok: true,
    settlement: fresh ?? settlement,
    transaction: {
      txHash,
      status: "CONFIRMED",
      chainId: deps.chainId,
      blockNumber: receipt.blockNumber !== null ? Number(receipt.blockNumber) : null,
    },
    note: null,
  };
}

/** Map finalize-phase races and write conflicts to deterministic responses. */
function handleFinalizeError(
  err: unknown,
  taskId: string,
  actorAddress: string,
  settlementId: string
): SettleResult {
  if (
    err instanceof ExecutorConflictError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034")
  ) {
    // Another process finalized (or raced) this settlement from the same
    // persisted receipt — the persisted outcome wins; never send again.
    void recordTaskEvent({
      taskId,
      eventType: "SETTLEMENT_REJECTED",
      actor: actorAddress,
      metadata: failureMetadata("finalize_race", { settlementId }),
    }).catch(() => {});
    return { ok: false, reason: "task_state_conflict", status: 409 };
  }
  console.error("settlement finalize failed:", err);
  return { ok: false, reason: "internal", status: 500 };
}