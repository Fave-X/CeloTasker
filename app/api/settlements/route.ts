import { NextResponse } from "next/server";
import {
  CreateSettlementRequestSchema,
} from "@/lib/validation/ValidationSchemas";
import {
  getAuthenticatedActor,
  requireAuthenticatedActor,
  UnauthorizedActorError,
} from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeSettlement } from "@/lib/api/serialize";
import { settleSubmission } from "@/lib/settlement/SettlementExecutor";

/**
 * POST /api/settlements — request settlement of an approved submission.
 *
 * Stage constraint: NO blockchain transaction is performed here. This endpoint
 * only confirms deterministic authorization; payment execution arrives in a
 * later stage.
 *
 * Stage 4.2 hardening — server-controlled behavior:
 * - ONLY the submission id is accepted from the body. Recipient, amount and
 *   reward token are NEVER client-controlled: they are derived server-side
 *   from the trusted Submission/Task records (see lib/workflow/SettlementService).
 * - Actor ↔ submission binding: only the worker who submitted the work may
 *   request settlement; the recipient is always that verified submitter.
 * - Current-submission-only: a stale/SUPERSEDED earlier attempt is rejected
 *   even if it was once APPROVED.
 * - UNDER_REVIEW → SETTLING is a guarded transition: concurrent requests
 *   produce exactly one settlement; losers get a deterministic 409.
 * - Settlement status starts at PENDING; txHash is never client-provided.
 * - Identity comes exclusively from the verified session — a body address
 *   alone can never authorize settlement.
 */
export async function POST(request: Request) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/settlements"),
    { limit: 5, windowMs: 60_000 }
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Only the submission id is read from the body; recipient / amount /
  // rewardToken are structurally absent from the schema and can never be
  // accepted, let alone honored.
  const parsed = CreateSettlementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Identity comes from the verified session — the body can never name an
  // actor. Unauthenticated callers are rejected BEFORE any state lookup.
  const actor = await getAuthenticatedActor(request);
  try {
    requireAuthenticatedActor(actor);
  } catch (err) {
    if (err instanceof UnauthorizedActorError) {
      return NextResponse.json(
        { error: "Authentication required for settlement requests" },
        { status: 401 }
      );
    }
    throw err;
  }

  // Stage 4.2 authorization gate + Stage 5C on-chain execution (idempotent):
  // the gate inside settleSubmission remains the unchanged security boundary;
  // execution only broadcasts/reads the receipt for the settlement the gate
  // created. Only the submission id is accepted from the body.
  const result = await settleSubmission(
    parsed.data.submissionId,
    actor.address as string
  );

  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Submission not found",
      forbidden: "Only the worker who submitted may request settlement",
      submission_superseded:
        "Submission is from an earlier revision and is no longer payable",
      task_state_conflict:
        "Task state changed concurrently; settlement not applied",
      duplicate_settlement: "A settlement already exists for this submission",
      token_not_whitelisted: "Reward token is not on the settlement whitelist",
      unsupported_token: "Reward token cannot be settled on Celo Mainnet",
      amount_exceeds_limit: "Task reward exceeds the settlement limit",
      amount_below_limit: "Task reward is below the settlement limit",
      recipient_mismatch: "Settlement recipient failed integrity verification",
      invalid_decimals: "Token returned invalid decimals; settlement not sent",
      invalid_reward: "Task reward amount is invalid; settlement not sent",
      insufficient_allowance:
        "Requester has not approved a sufficient relayer allowance; settlement not sent",
      wrong_chain: "Relayer RPC is not Celo Mainnet; settlement not sent",
      ambiguous_broadcast:
        "A previous broadcast may exist; re-sending is refused pending manual review",
      no_matching_broadcast:
        "No on-chain transaction matched the expected payment; re-sending is refused",
      ambiguous_recovery:
        "Multiple matching on-chain transactions were found; manual recovery is required and re-sending is refused",
      broadcast_persist_failed:
        "Transaction was broadcast but its hash could not be persisted; recovery required",
      broadcast_persist_failed_no_audit:
        "Transaction was broadcast but its hash could not be recorded; manual recovery required",
      transfer_verification_failed:
        "Receipt did not contain the expected token transfer; settlement not confirmed",
      recovery_scan_failed: "On-chain recovery scan failed; nothing was sent",
      settlement_failed: "This settlement previously failed on chain",
      broadcast_failed_ambiguous:
        "Transaction broadcast status is unknown; re-sending is refused pending verified recovery",
      receipt_reverted: "Transaction reverted on chain; settlement failed",
      invalid_confirmations:
        "Settlement confirmation-depth configuration is invalid; finalization refused",
      reorg_detected:
        "A chain reorganization was detected; retry settlement confirmation later",
      internal: "Failed to request settlement",
    };
    const message =
      messages[result.reason] ??
      (result.reason.startsWith("submission_not_approved:")
        ? "Only APPROVED submissions can be settled"
        : result.reason.startsWith("task_not_under_review:")
          ? "Task is not eligible for settlement"
          : "Settlement rejected");
    return NextResponse.json({ error: message }, { status: result.status });
  }

  // The transaction object is public on-chain data only (txHash, status,
  // chainId, blockNumber) — never secrets or wallet internals.
  return NextResponse.json(
    {
      settlement: serializeSettlement(result.settlement),
      eligible: true,
      transaction: result.transaction,
      note: result.note,
    },
    { status: 201 }
  );
}
