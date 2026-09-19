import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeTask } from "@/lib/api/serialize";
import { getTaskForActor } from "@/lib/workflow/TaskService";

/**
 * GET /api/tasks/[id] — task detail (authenticated, ACL'd).
 *
 * While a task is OPEN it is viewable by ANY authenticated session, so workers
 * who have not claimed it can inspect it before claiming (the same data is
 * already public, unauthenticated, via GET /api/tasks). For every other status
 * only the creator or the assigned worker may view details; unrelated workers
 * cannot access private task data.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(clientKeyFromRequest(request, "GET /api/tasks/[id]"), {
    limit: 60,
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

  const result = await getTaskForActor(id, actor.address, { allowOpenView: true });
  if (!result.ok) {
    const message =
      result.reason === "not_found" ? "Task not found" : "Access denied";
    return NextResponse.json({ error: message }, { status: result.status });
  }

  return NextResponse.json({ task: serializeTask(result.data) }, { status: 200 });
}
