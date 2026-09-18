import { NextResponse } from "next/server";
import { CreateSubmissionRequestSchema } from "@/lib/validation/ValidationSchemas";
import { getAuthenticatedActor } from "@/lib/security/authorization";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";
import { serializeSubmission } from "@/lib/api/serialize";
import { submitWork } from "@/lib/workflow/TaskService";

/**
 * POST /api/submissions — submit work against a task (authenticated worker).
 *
 * Server-controlled behavior:
 * - Identity comes from the verified session; body `submitter` is ignored.
 * - Only the assigned worker may submit; deadline is enforced.
 * - Submission status always starts at PENDING (never client-provided).
 * - The task transitions IN_PROGRESS -> SUBMITTED through the deterministic
 *   state machine inside a transaction; audit events record success/failure.
 */
export async function POST(request: Request) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/submissions"),
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateSubmissionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await submitWork(
    { taskId: parsed.data.taskId, contentRef: parsed.data.contentRef },
    actor.address
  );

  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "Task not found",
      not_assignee: "Only the assigned worker may submit",
      deadline_passed: "Task deadline has passed",
      task_state_conflict:
        "Task state changed concurrently; submission not recorded",
      internal: "Failed to record submission",
    };
    const message = messages[result.reason] ??
      (result.reason.startsWith("task_not_in_progress")
        ? "Task is not accepting submissions"
        : "Submission rejected");
    return NextResponse.json({ error: message }, { status: result.status });
  }

  return NextResponse.json(
    { submission: serializeSubmission(result.data) },
    { status: 201 }
  );
}
