import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeTask } from "@/lib/api/serialize";
import { requestRevision } from "@/lib/workflow/TaskService";

/**
 * POST /api/tasks/[id]/revision — request a revision (authenticated).
 *
 * Transitions UNDER_REVIEW -> REVISION_REQUESTED -> IN_PROGRESS with a
 * deterministic revision-count increment. Enforces MAX_REVISION_ATTEMPTS.
 * NOTE: the AI evaluator arrives in a later stage; until then the requester
 * (task creator) may call this endpoint explicitly.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(clientKeyFromRequest(request, "POST /api/tasks/[id]/revision"), {
    limit: 10,
    windowMs: 60_000,
  });
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

  const result = await requestRevision(id, actor.address);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Task not found",
      forbidden: "Only the task creator may request a revision",
      revision_limit_reached: "Maximum revision attempts reached",
      task_state_conflict:
        "Task state changed concurrently; revision not applied",
    };
    const message =
      messages[result.reason] ??
      (result.reason.startsWith("task_not_under_review")
        ? "Task is not under review"
        : "Revision request failed");
    return NextResponse.json({ error: message }, { status: result.status });
  }

  return NextResponse.json({ task: serializeTask(result.data) }, { status: 200 });
}
