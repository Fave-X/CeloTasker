import { NextResponse } from "next/server";
import { CreateTaskRequestSchema } from "@/lib/validation/ValidationSchemas";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeTask } from "@/lib/api/serialize";
import { createTask, listOpenTasks } from "@/lib/workflow/TaskService";

/**
 * POST /api/tasks — create a task (authenticated).
 *
 * Identity comes from the verified session. All fields are validated with the
 * shared Zod schema; unknown/protected fields (status, ids, timestamps,
 * revision counters) are stripped. The server controls the task ID, status
 * (CREATED -> OPEN), timestamps and revision counters. Audit events are
 * recorded for both lifecycle steps.
 */
export async function POST(request: Request) {
  const limit = rateLimit(clientKeyFromRequest(request, "POST /api/tasks"), {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateTaskRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const task = await createTask(actor.address, parsed.data);
    return NextResponse.json({ task: serializeTask(task) }, { status: 201 });
  } catch (err) {
    console.error("POST /api/tasks failed:", err);
    return NextResponse.json(
      { error: "Failed to create task" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/tasks — discovery: all OPEN tasks (public view, serialized).
 * Unauthenticated listing is allowed; private detail requires the ACL'd
 * detail endpoint.
 */
export async function GET(request: Request) {
  const limit = rateLimit(clientKeyFromRequest(request, "GET /api/tasks"), {
    limit: 60,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const tasks = await listOpenTasks();
  return NextResponse.json(
    { tasks: tasks.map((t) => serializeTask(t)) },
    { status: 200 }
  );
}
