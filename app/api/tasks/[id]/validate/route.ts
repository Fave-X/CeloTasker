import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { validateSubmission } from "@/lib/workflow/ValidationService";

/**
 * POST /api/tasks/[id]/validate — run the deterministic validation layer
 * (authenticated, creator-only).
 *
 * Transitions SUBMITTED -> UNDER_VALIDATION -> UNDER_REVIEW through the
 * guarded state machine. The pure deterministic validator runs BEFORE any AI
 * evaluation and is the only component allowed to move a submission into
 * UNDER_REVIEW. No client-supplied reward, token, requester, recipient,
 * rubric or task state is ever trusted; the current submission is derived
 * server-side. An invalid submission deterministically lands in UNDER_REVIEW
 * with the submission marked REJECTED and the structured result recorded in
 * the audit trail.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/tasks/[id]/validate"),
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

  const result = await validateSubmission(id, actor.address);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Task not found",
      forbidden: "Only the task creator may trigger validation",
      no_eligible_submission: "No eligible (non-superseded) submission to validate",
      task_state_conflict: "Task state changed concurrently; validation not applied",
      internal: "Validation failed",
    };
    const message =
      messages[result.reason] ??
      (result.reason.startsWith("task_not_submitted")
        ? "Task is not awaiting validation"
        : "Validation rejected");
    return NextResponse.json({ error: message }, { status: result.status });
  }

  // The validation result is a purpose-built public structure (identifiers,
  // checks, deterministic failure reasons) — safe to return as-is.
  return NextResponse.json({ validation: result.data }, { status: 200 });
}