/**
 * CeloTasker — Append-only audit trail for TaskEvent.
 *
 * IMPORTANT: TaskEvent records are immutable by policy. This module
 * intentionally exposes ONLY `recordTaskEvent`. Never add update or
 * delete functions here, and never call prisma.taskEvent.update/delete
 * anywhere in the codebase.
 */
import { prisma } from "../prisma.ts";
import type { TaskEventType } from "../workflow/TaskStatus";

export interface AuditEventInput {
  taskId: string;
  eventType: TaskEventType | (string & {});
  /** Address or system identifier of the actor ("system" for automated steps). */
  actor?: string | null;
  /** Structured metadata; will be stored as a JSON string. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append an audit event. Timestamps are set by the database (createdAt
 * default), never by the caller — callers cannot forge event times.
 */
export async function recordTaskEvent(input: AuditEventInput) {
  return prisma.taskEvent.create({
    data: {
      taskId: input.taskId,
      eventType: input.eventType,
      actor: input.actor ?? "system",
      payload: input.metadata ? JSON.stringify(input.metadata) : null,
      // createdAt is DB-managed; no client-supplied timestamp is accepted.
    },
  });
}

/**
 * Read-only access for later stages (review UI, settlement evidence).
 * Reads do not violate append-only semantics.
 */
export async function listTaskEvents(taskId: string) {
  return prisma.taskEvent.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
  });
}
