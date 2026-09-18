import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeTaskEvent } from "@/lib/api/serialize";
import { listTaskEvents } from "@/lib/audit/AuditLog";
import { getTaskForActor } from "@/lib/workflow/TaskService";

/**
 * GET /api/tasks/[id]/events — read-only audit trail for one task
 * (authenticated, same ACL as the detail endpoint: creator or assignee).
 *
 * The append-only TaskEvent records are the system's real activity: nothing
 * is manufactured here, and only whitelisted fields are exposed. Chronological
 * ascending order — the natural reading order of an audit trail.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "GET /api/tasks/[id]/events"),
    { limit: 60, windowMs: 60_000 }
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

  // Same access control as the detail endpoint.
  const access = await getTaskForActor(id, actor.address);
  if (!access.ok) {
    const message =
      access.reason === "not_found" ? "Task not found" : "Access denied";
    return NextResponse.json({ error: message }, { status: access.status });
  }

  const events = await listTaskEvents(id);
  return NextResponse.json(
    { events: events.map((e) => serializeTaskEvent(e)) },
    { status: 200 }
  );
}