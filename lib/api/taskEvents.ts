/**
 * CeloTasker — read-only task audit trail (UI Step 1).
 *
 * Lives in lib/ (not the route) so it is testable through Node's test runner.
 * The append-only TaskEvent records are the system's real activity: nothing is
 * manufactured here, and only whitelisted fields are exposed. Chronological
 * ascending order — the natural reading order of an audit trail. The ACL is
 * identical to the detail endpoint (creator or assignee only).
 */
import { listTaskEvents } from "../audit/AuditLog.ts";
import { getTaskForActor } from "../workflow/TaskService.ts";
import { serializeTaskEvent, type PublicTaskEvent } from "./serialize.ts";

export type TaskEventsResult =
  | { ok: true; data: { events: PublicTaskEvent[] } }
  | { ok: false; reason: "not_found" | "forbidden" | "invalid_id"; status: number };

/** The real audit trail for one task, for an authenticated actor. */
export async function getTaskEventsForActor(
  taskId: string,
  actorAddress: string
): Promise<TaskEventsResult> {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 64) {
    return { ok: false, reason: "invalid_id", status: 400 };
  }

  // Same access control as the detail endpoint.
  const access = await getTaskForActor(taskId, actorAddress);
  if (!access.ok) {
    const reason = access.reason === "not_found" ? "not_found" : "forbidden";
    return { ok: false, reason, status: access.status };
  }

  const events = await listTaskEvents(taskId);
  return { ok: true, data: { events: events.map((e) => serializeTaskEvent(e)) } };
}