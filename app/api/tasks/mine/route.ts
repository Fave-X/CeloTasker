import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeTask } from "@/lib/api/serialize";
import { listMyTasks } from "@/lib/workflow/TaskService";

/**
 * GET /api/tasks/mine — tasks created by or assigned to the authenticated user.
 */
export async function GET(request: Request) {
  const limit = rateLimit(clientKeyFromRequest(request, "GET /api/tasks/mine"), {
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

  const tasks = await listMyTasks(actor.address);
  return NextResponse.json(
    { tasks: tasks.map((t) => serializeTask(t)) },
    { status: 200 }
  );
}
