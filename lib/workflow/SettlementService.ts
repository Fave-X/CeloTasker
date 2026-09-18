/**
 * CeloTasker — Deterministic settlement service (Stage 4.2 hardening).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * This module only AUTHORIZEs a settlement request — no blockchain
 * transaction is created or broadcast here (later stage).
 *
 * Server-controlled behavior:
 * - Actor identity comes exclusively from the verified session (route passes
 *   getAuthenticatedActor's address); request bodies can never name an actor.
 * - Actor ↔ submission binding: only the worker who submitted may settle it.
 *   Recipient is always the verified submitter — never a body-supplied value.
 * - Current-submission-only: the task's current submission is derived
 *   server-side; a stale/SUPERSEDED earlier attempt is rejected even if it
 *   was once APPROVED.
 * - Amount and reward token are derived exclusively from the trusted Task
 *   row and bounded by SETTLEMENT_LIMITS and the token whitelist.
 * - UNDER_REVIEW → SETTLING goes through the guarded transitionTask helper:
 *   exactly one concurrent request wins; the loser gets a deterministic 409
 *   and leaves no settlement record (also enforced by the unique constraint
 *   on Settlement.submissionId).
 * - Every outcome — success, conflict, duplicate, rejection — is audited
 *   truthfully with the session actor.
 */
import { Prisma, type Settlement } from "@prisma/client";
import { prisma } from "../prisma.ts";
import { recordTaskEvent } from "../audit/AuditLog.ts";
import { transitionTask } from "./TaskService.ts";
import {
  SETTLEMENT_LIMITS,
  SETTLEMENT_TOKEN_WHITELIST,
  CHAIN_IDS,
} from "../security/SecurityPolicy.ts";

export type SettlementResult =
  | { ok: true; data: Settlement }
  | { ok: false; reason: string; status: number };

export async function requestSettlement(
  submissionId: string,
  actorAddress: string
): Promise<SettlementResult> {
  // Load the submission with its task. The client-supplied id is used ONLY
  // to locate the record — every authorization decision below is made
  // server-side from trusted data.
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { task: true },
  });
  if (!submission) return { ok: false, reason: "not_found", status: 404 };

  // Actor ↔ submission binding: only the submitter may settle their own work.
  // Checked FIRST so an unrelated authenticated wallet learns nothing and
  // can mutate nothing.
  if (submission.submitter !== actorAddress) {
    return { ok: false, reason: "forbidden", status: 403 };
  }

  const task = submission.task;

  // Current-submission-only: derive the task's current submission from the
  // database rather than trusting the client-selected row. A SUPERSEDED (or
  // otherwise non-current) submission can never be settled, even if it was
  // APPROVED during an earlier revision round.
  const current = await prisma.submission.findFirst({
    where: { taskId: task.id, status: { not: "SUPERSEDED" } },
    orderBy: { createdAt: "desc" },
  });
  if (!current || current.id !== submission.id) {
    return { ok: false, reason: "submission_superseded", status: 409 };
  }

  if (submission.status !== "APPROVED") {
    return { ok: false, reason: `submission_not_approved:${submission.status}`, status: 409 };
  }
  if (task.status !== "UNDER_REVIEW") {
    return { ok: false, reason: `task_not_under_review:${task.status}`, status: 409 };
  }

  // Server-controlled amount and token: derived exclusively from the trusted
  // Task row. There is no second, client-supplied amount/token to reconcile.
  const amount = task.rewardAmount;
  const rewardToken = task.rewardToken.toLowerCase();

  // Policy bounds (server-side, deterministic). rewardAmount is in WHOLE TOKEN
// units (the Stage 5C convention): MIN_AMOUNT "1" strictly rejects
// zero-value settlements; MAX_AMOUNT "1000" caps the reward. Integer-only
// BigInt comparisons — no floating point, no rounding.
  if (BigInt(amount) > BigInt(SETTLEMENT_LIMITS.MAX_AMOUNT)) {
    return { ok: false, reason: "amount_exceeds_limit", status: 409 };
  }
  if (BigInt(amount) < BigInt(SETTLEMENT_LIMITS.MIN_AMOUNT)) {
    return { ok: false, reason: "amount_below_limit", status: 409 };
  }
  // Stage 5C: settlement executes on Celo Mainnet only (chain 42220), so the
  // MAINNET token whitelist is the authoritative executable set. Authorizing a
  // token that cannot be paid on the execution chain would create a
  // settlement that can never be confirmed.
  const whitelist = SETTLEMENT_TOKEN_WHITELIST[CHAIN_IDS.CELO_MAINNET];
  if (!whitelist.includes(rewardToken)) {
    return { ok: false, reason: "token_not_whitelisted", status: 403 };
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Guarded transition: the write predicate includes the expected current
      // state, so concurrent settlement attempts produce exactly one winner.
      const moved = await transitionTask(tx, task.id, "UNDER_REVIEW", "SETTLING");
      if (!moved) return { conflict: true } as const;

      const settlement = await tx.settlement.create({
        data: {
          submissionId: submission.id,      // derived from the located row
          taskId: task.id,                  // derived from the stored submission
          recipient: submission.submitter,  // server-derived, never the body
          amount,                           // server-derived: task.rewardAmount
          rewardToken,                      // server-derived: task.rewardToken
          status: "PENDING",                // always PENDING; txHash stays null
        },
      });

      await tx.taskEvent.create({
        data: {
          taskId: task.id,
          eventType: "SETTLEMENT_STARTED",
          actor: actorAddress,
          payload: JSON.stringify({
            settlementId: settlement.id,
            submissionId: submission.id,
            recipient: settlement.recipient,
            amount: settlement.amount,
            rewardToken: settlement.rewardToken,
            fromStatus: "UNDER_REVIEW",
            toStatus: "SETTLING",
            note: "Eligibility confirmed; no blockchain transaction executed yet",
          }),
        },
      });

      return { conflict: false, settlement } as const;
    });

    if (outcome.conflict) {
      await recordTaskEvent({
        taskId: task.id,
        eventType: "SETTLEMENT_REJECTED",
        actor: actorAddress,
        metadata: { reason: "task_state_conflict", submissionId: submission.id },
      });
      return { ok: false, reason: "task_state_conflict", status: 409 };
    }

    return { ok: true, data: outcome.settlement };
  } catch (err) {
    // Unique-constraint violation on Settlement.submissionId: a settlement
    // already exists for this submission. Deterministic conflict, not an
    // internal error. The transaction rolled back — no partial records.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      await recordTaskEvent({
        taskId: task.id,
        eventType: "SETTLEMENT_REJECTED",
        actor: actorAddress,
        metadata: { reason: "duplicate_settlement", submissionId: submission.id },
      });
      return { ok: false, reason: "duplicate_settlement", status: 409 };
    }
    console.error("requestSettlement failed:", err);
    return { ok: false, reason: "internal", status: 500 };
  }
}