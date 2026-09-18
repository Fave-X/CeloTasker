"use client";

/**
 * CeloTasker — task activity / audit trail (read-only).
 *
 * Renders the append-only TaskEvent records served by
 * GET /api/tasks/[id]/events (same ACL as the detail endpoint: creator or
 * assignee only, chronological ascending from the backend). Everything shown
 * is backend data — event type, actor, timestamp and a few whitelisted payload
 * facts such as the settlement transaction hash. Nothing is manufactured
 * client-side; an event type without a known label renders as its raw
 * server identifier, and unknown payload fields are simply not displayed.
 */
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api/client";
import type { PublicTaskEvent } from "@/lib/api/serialize";
import { Button } from "@/components/ui/Button";

/** JSON dates arrive as strings over the API, not database Date objects. */
type EventJson = Omit<PublicTaskEvent, "createdAt"> & { createdAt: string };

/**
 * Plain-language labels for the backend's TaskEventType values (from
 * lib/workflow/TaskStatus). A type without a label falls back to the raw
 * server identifier — nothing is renamed or hidden.
 */
const EVENT_LABELS: Record<string, string> = {
  TASK_CREATED: "Task created",
  TASK_OPENED: "Task opened for claims",
  TASK_ASSIGNED: "Worker assigned",
  WORK_STARTED: "Work started",
  SUBMISSION_RECEIVED: "Work submitted",
  VALIDATION_STARTED: "Deterministic validation ran",
  VALIDATION_REJECTED: "Validation refused",
  REVIEW_STARTED: "AI review started",
  EVALUATION_COMPLETED: "AI review completed",
  EVALUATION_REJECTED: "AI review refused",
  REVISION_REQUESTED: "Revision requested",
  REVISION_LIMIT_REACHED: "Revision limit reached",
  REVISION_REJECTED: "Revision refused",
  APPROVAL_CONFIRMED: "Requester confirmed the submission",
  TASK_APPROVED: "Submission approved",
  TASK_REJECTED: "Task rejected",
  SETTLEMENT_STARTED: "Settlement started",
  SETTLEMENT_BROADCAST: "Payment broadcast on Celo",
  SETTLEMENT_COMPLETED: "Payment confirmed on Celo",
  SETTLEMENT_REJECTED: "Settlement refused",
  PAYMENT_FAILED: "Payment failed",
  TASK_EXPIRED: "Task expired",
  TASK_COMPLETED: "Task completed",
  CLAIM_FAILED: "Claim refused",
  SUBMISSION_REJECTED: "Submission refused",
};

/** Only these payload fields are surfaced, verbatim from the backend. */
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

function PayloadFacts({ payload }: { payload: string | null }) {
  if (!payload) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const meta = raw as Record<string, unknown>;
  const txHash =
    typeof meta.txHash === "string" && HEX64.test(meta.txHash) ? meta.txHash : null;
  const reason = typeof meta.reason === "string" ? meta.reason : null;
  const fromStatus = typeof meta.fromStatus === "string" ? meta.fromStatus : null;
  const toStatus = typeof meta.toStatus === "string" ? meta.toStatus : null;
  if (!txHash && !reason && !fromStatus && !toStatus) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {fromStatus && toStatus && (
        <p className="font-mono text-xs leading-relaxed text-ink-faint">
          {fromStatus} → {toStatus}
        </p>
      )}
      {reason && (
        <p className="break-words font-mono text-xs leading-relaxed text-ink-faint">
          reason: {reason}
        </p>
      )}
      {txHash && (
        <p className="break-all font-mono text-xs leading-relaxed">
          tx{" "}
          <a
            href={`https://celoscan.io/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="text-celo hover:underline"
          >
            {txHash}
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * The audit trail for one task. Fetches GET /api/tasks/[id]/events, honors
 * its creator/assignee ACL, and renders the backend's chronological order
 * as-is — the newest event at the bottom, like a ledger.
 */
export function TaskActivity({ taskId }: { taskId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    | { kind: "loading" }
    | { kind: "ready"; events: EventJson[] }
    | { kind: "error"; message: string; retry: boolean }
  >({ kind: "loading" });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResult({ kind: "loading" });
    apiFetch<{ events: EventJson[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/events`,
      { method: "GET", cache: "no-store", signal: controller.signal }
    )
      .then(({ events }) => {
        if (!active) return;
        setResult({ kind: "ready", events: Array.isArray(events) ? events : [] });
      })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
        if (caught instanceof ApiError && caught.status === 401) {
          setResult({
            kind: "error",
            message: "Your session is no longer authenticated. Reconnect your wallet, then retry.",
            retry: true,
          });
        } else if (caught instanceof ApiError && caught.status === 403) {
          setResult({
            kind: "error",
            message: "Only the requester or assigned worker can read this task's audit trail.",
            retry: false,
          });
        } else {
          setResult({
            kind: "error",
            message: caught instanceof Error ? caught.message : "Could not load the audit trail.",
            retry: true,
          });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [taskId, attempt]);

  return (
    <section aria-labelledby="task-activity-heading" className="mt-8 border-t border-line pt-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="task-activity-heading" className="text-lg font-medium">Activity</h2>
        <p className="text-xs text-ink-faint">Append-only audit trail, chronological order</p>
      </div>

      {result.kind === "loading" && (
        <p role="status" className="mt-4 text-sm text-ink-soft">Loading activity…</p>
      )}

      {result.kind === "error" && (
        <div className="mt-4">
          <p role="alert" className="text-sm text-fail">{result.message}</p>
          {result.retry && (
            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      )}

      {result.kind === "ready" && result.events.length === 0 && (
        <p className="mt-4 text-sm text-ink-soft">No activity recorded yet.</p>
      )}

      {result.kind === "ready" && result.events.length > 0 && (
        <ol className="mt-4 divide-y divide-line border-y border-line">
          {result.events.map((event) => (
            <li key={event.id} className="py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 text-sm font-medium">
                  {EVENT_LABELS[event.eventType] ?? event.eventType}
                </p>
                <time
                  dateTime={event.createdAt}
                  className="shrink-0 font-mono text-xs leading-relaxed text-ink-faint"
                >
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </div>
              {event.actor && (
                <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-ink-faint">
                  {event.actor}
                </p>
              )}
              <PayloadFacts payload={event.payload} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

