import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { reviewSubmission } from "@/lib/workflow/ReviewService";

/**
 * POST /api/tasks/[id]/review — run the AI evaluation/review (authenticated,
 * creator-only).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * - Runs only after the deterministic validator (task must be UNDER_REVIEW).
 * - The AI evaluation is UNTRUSTED and ADVISORY: it never mutates state
 *   directly. The deterministic review layer decides the authoritative
 *   outcome (submission APPROVED / existing revision workflow / task
 *   REJECTED) through the frozen state machine.
 * - An APPROVE recommendation only becomes APPROVED when the deterministic
 *   approval policy (all rubric criteria covered and satisfied, current
 *   PENDING submission) agrees.
 * - No request-body data influences the evaluation; the provider is resolved
 *   server-side. No blockchain execution happens here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/tasks/[id]/review"),
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

  const result = await reviewSubmission(id, actor.address);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Task not found",
      forbidden: "Only the task creator may review submissions",
      no_eligible_submission: "No eligible (non-superseded) submission to review",
      evaluation_unavailable: "AI evaluation provider is not configured",
      evaluation_timeout: "AI evaluation timed out; nothing was applied",
      malformed_model_output: "AI evaluation output was malformed; nothing was applied",
      evaluation_provider_error: "AI evaluation provider failed; nothing was applied",
      task_state_conflict: "Task state changed concurrently; review not applied",
      internal: "Review failed",
    };
    const message =
      messages[result.reason] ??
      (result.reason.startsWith("task_not_under_review")
        ? "Task is not under review"
        : "Review rejected");
    return NextResponse.json({ error: message }, { status: result.status });
  }

  return NextResponse.json({ review: result.data }, { status: 200 });
}