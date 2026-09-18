import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { confirmApproval } from "@/lib/workflow/ConfirmationService";

/**
 * POST /api/tasks/[id]/confirm — human confirmation gate (authenticated,
 * creator-only, no request body).
 *
 * SECURITY INVARIANT: ... → DETERMINISTIC CODE MUST AUTHORIZE → HUMAN
 * CONFIRMATION MUST AUTHORIZE REAL-MONEY RELEASE → BLOCKCHAIN MUST CONFIRM.
 *
 * After the AI review records a policy-passed APPROVE recommendation as
 * PENDING_HUMAN_CONFIRMATION, ONLY this explicit creator action may mark the
 * current submission APPROVED — the AI review endpoint itself can never
 * authorize payment. No recipient, token, amount or calldata is ever
 * accepted from the client; the unchanged Stage 4.2 settlement gate derives
 * all payment parameters from trusted records.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/tasks/[id]/confirm"),
    { limit: 10, windowMs: 60_000 }
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const actor = await getAuthenticatedActor(request);
  if (!actor.authenticated || !actor.address) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  // No request body is read: confirmation parameters are all server-derived.
  const result = await confirmApproval(id, actor.address);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Task not found",
      forbidden: "Only the task creator may confirm approval",
      no_eligible_submission: "No eligible (non-superseded) submission to confirm",
      no_ai_evaluation:
        "No policy-passed AI approval exists for the current submission; run review first",
      ai_evaluation_not_approved:
        "The AI evaluation did not pass the deterministic approval policy",
      not_confirmable: "Submission state is not confirmable",
      task_state_conflict: "Task state changed concurrently; confirmation not applied",
    };
    const message =
      messages[result.reason] ??
      (result.reason.startsWith("task_not_under_review")
        ? "Task is not under review"
        : result.reason.startsWith("submission_not_pending")
          ? "Only a PENDING submission can be confirmed"
          : "Confirmation rejected");
    return NextResponse.json({ error: message }, { status: result.status });
  }

  return NextResponse.json({ confirmation: result.data }, { status: 200 });
}