import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeTask } from "@/lib/api/serialize";
import { claimTask } from "@/lib/workflow/TaskService";

/**
 * POST /api/tasks/[id]/claim — worker claims an OPEN task.
 * Worker identity comes exclusively from the verified session. The claim is
 * atomic: only the first claimant wins; concurrent claims fail with 409.
 * Transitions OPEN -> ASSIGNED -> IN_PROGRESS with audit events.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = rateLimit(clientKeyFromRequest(request, "POST /api/tasks/[id]/claim"), {
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

  const result = await claimTask(id, actor.address);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Task not found",
      not_open: "Task is not open for claiming",
      expired: "Task has expired",
      already_claimed: "Task was already claimed",
      creator_cannot_claim: "Creators cannot claim their own tasks",
      already_assigned: "Task is designated for another worker",
      internal: "Failed to claim task",
    };
    return NextResponse.json(
      { error: messages[result.reason] ?? "Claim failed" },
      { status: result.status }
    );
  }

  return NextResponse.json({ task: serializeTask(result.data) }, { status: 200 });
}
