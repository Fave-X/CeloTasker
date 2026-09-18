"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api/client";
import { CUSD_ADDRESS } from "@/lib/celo";
import type { TaskStatus } from "@/lib/workflow/TaskStatus";
import { Button } from "@/components/ui/Button";
import { useWallet } from "@/components/wallet/WalletProvider";
import { SubmitWorkForm } from "./SubmitWorkForm";
import { RequesterReview, type TaskStateJson } from "./RequesterReview";
import { PaymentSection } from "./PaymentSection";
import { TaskActivity } from "./TaskActivity";
import type { TaskResponse } from "./TaskList";

// Presentation only; the backend remains authoritative for lifecycle state.
const STATE_DESCRIPTION: Record<TaskStatus, string> = {
  CREATED: "The task has been created but is not yet open for work.",
  OPEN: "The task is open and available for a worker to take on.",
  ASSIGNED: "A worker is assigned to this task.",
  IN_PROGRESS: "The assigned worker is working on this task.",
  SUBMITTED: "Work has been submitted and is awaiting validation.",
  UNDER_VALIDATION: "The submission is in the validation stage.",
  UNDER_REVIEW: "The submission is in review. This is not payment confirmation.",
  REVISION_REQUESTED: "Changes have been requested before the work can proceed.",
  SETTLING: "Payment settlement is in progress; completion is not yet confirmed.",
  SETTLED: "Payment has settled. The task is awaiting its final completion state.",
  COMPLETED: "The task is complete.",
  REJECTED: "The task has been rejected and is closed.",
  PAYMENT_FAILED: "Payment settlement failed. The task is not completed.",
  EXPIRED: "The task has expired and is no longer available for work.",
};

type DetailResult = {
  identity: string;
  id: string;
} & (
  | { state: TaskStateJson; error: null }
  | { state: null; error: { title: string; message: string; retry: boolean } }
);

function detailError(error: unknown): NonNullable<DetailResult["error"]> {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return { title: "Invalid task link", message: "This task link is not valid. Return to Tasks or My Work.", retry: false };
      case 401:
        return { title: "Sign in required", message: "Your session is no longer authenticated. Disconnect and reconnect using the header, then retry.", retry: true };
      case 403:
        return { title: "Access denied", message: "Only the requester or assigned worker can view this task. Knowing its link does not grant access.", retry: false };
      case 404:
        return { title: "Task not found", message: "The requested task could not be found.", retry: false };
      case 429:
        return { title: "Too many requests", message: "Please wait a minute before trying again.", retry: true };
    }
  }
  return { title: "Could not load task", message: error instanceof Error ? error.message : "Please try again.", retry: true };
}

export function TaskDetail({ id }: { id: string }) {
  const wallet = useWallet();
  const identity = wallet.sessionAddress;
  const enabled = wallet.status === "authenticated" && !!identity && wallet.onCelo;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<DetailResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (!enabled || !identity) return;
    let active = true;
    const controller = new AbortController();
    apiFetch<{ state: TaskStateJson }>(`/api/tasks/${encodeURIComponent(id)}/state`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    }).then(({ state }) => {
      if (active) setResult({ id, identity, state, error: null });
    }).catch((error: unknown) => {
      if (active) setResult({ id, identity, state: null, error: detailError(error) });
    });
    return () => { active = false; controller.abort(); };
  }, [enabled, identity, id, attempt]);

  // Never display an earlier wallet's private response after an account change.
  const current = result?.identity === identity && result?.id === id ? result : null;
  const checking = wallet.status === "detecting" || wallet.status === "connecting";

  return (
    <section className="max-w-[880px]">
      <nav aria-label="Task navigation" className="mb-7 flex gap-5 text-sm text-celo">
        <Link href="/tasks" className="hover:underline">Back to Tasks</Link>
        <Link href="/my-work" className="hover:underline">My Work</Link>
      </nav>
      {!enabled ? (
        <div className="space-y-3 border-t border-line py-6">
          <h1 className="text-3xl font-semibold tracking-tight">Task Detail</h1>
          <p role="status" className="text-ink-soft">{checking
            ? "Checking your wallet session…"
            : "You are viewing as an unauthenticated visitor. Connect your wallet on Celo Mainnet using the header. Only the requester or assigned worker can view full details."}</p>
        </div>
      ) : !current ? (
        <div aria-busy="true" className="space-y-3 py-6">
          <h1 className="text-3xl font-semibold tracking-tight">Task Detail</h1>
          <p role="status" className="text-ink-soft">Loading task…</p>
        </div>
      ) : current.error ? (
        <div className="space-y-4 border-t border-line py-6">
          <div role="alert">
            <h1 className="text-2xl font-semibold">{current.error.title}</h1>
            <p className="mt-2 text-ink-soft">{current.error.message}</p>
          </div>
          {current.error.retry && <Button variant="secondary" onClick={() => {
            setResult(null);
            setAttempt((value) => value + 1);
          }}>Retry</Button>}
        </div>
      ) : <TaskContent
            state={current.state}
            identity={identity!}
            // Server-returned task from the claim — never a local state guess.
            onClaimed={(claimed) => setResult((prev) => prev && prev.state
              ? { ...prev, state: { ...prev.state, task: claimed } }
              : prev)}
            // Action endpoints return only their own record, so refetch the bundle.
            onRefresh={() => { setResult(null); setAttempt((value) => value + 1); }}
          />}
    </section>
  );
}

function TaskContent({ state, identity, onClaimed, onRefresh }: {
  state: TaskStateJson;
  identity: string;
  onClaimed: (task: TaskResponse) => void;
  onRefresh: () => void;
}) {
  const task = state.task;
  const creator = task.creator.toLowerCase() === identity.toLowerCase();
  const worker = task.assignee?.toLowerCase() === identity.toLowerCase();
  const criteria = [...task.criteria].sort((a, b) => a.order - b.order);
  const stateDescription = STATE_DESCRIPTION[task.status as TaskStatus];

  return (
    <article>
      <header>
        <p className="text-sm text-ink-soft">
          {creator && worker ? "You are the requester and assigned worker." : creator
            ? "You are the requester / creator." : worker
              ? "You are the assigned worker." : "You are signed in."}
        </p>
        <h1 className="mt-3 break-words text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{task.title}</h1>
        <p className="mt-4 break-words text-xl font-medium text-celo">
          {task.rewardAmount} {task.rewardToken.toLowerCase() === CUSD_ADDRESS.toLowerCase() ? "cUSD" : "(other reward token)"}
          <span className="ml-2 text-sm font-normal text-ink-soft">reward</span>
        </p>
      </header>

      <section aria-labelledby="task-status" className="my-7 border-y border-line py-5">
        <h2 id="task-status" className="text-sm font-medium text-ink-soft">Current status</h2>
        <p className="mt-2 font-mono text-sm">{task.status}</p>
        {stateDescription && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{stateDescription}</p>}
      </section>

      {/* Worker flow, driven only by the server-side state and session identity. */}
      {task.status === "OPEN" && !creator && (worker || !task.assignee) && (
        <ClaimSection task={task} onClaimed={onClaimed} />
      )}
      {task.status === "OPEN" && !creator && task.assignee && !worker && (
        <p className="mt-7 border-t border-line pt-6 text-sm text-ink-soft">This task is reserved for a specific worker.</p>
      )}
      {worker && task.status === "IN_PROGRESS" && (
        <SubmitWorkForm taskId={task.id} deadline={task.deadline} onSubmitSuccess={onRefresh} />
      )}
      {worker && task.status === "ASSIGNED" && (
        <p className="mt-7 border-t border-line pt-6 text-sm text-ink-soft">The task is assigned to you. Submitting opens once work is in progress.</p>
      )}
      {worker && task.status === "SUBMITTED" && (
        <p role="status" className="mt-7 border-t border-line pt-6 text-sm text-ink-soft">Your work has been submitted and is awaiting validation.</p>
      )}
      {worker && task.status === "REVISION_REQUESTED" && (
        <p className="mt-7 border-t border-line pt-6 text-sm text-ink-soft">Changes were requested for this task. Revised work can be submitted once the task is back in progress.</p>
      )}

      <section aria-labelledby="task-description">
        <h2 id="task-description" className="text-lg font-medium">The work</h2>
        <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink-soft">{task.description}</p>
      </section>

      <section aria-labelledby="task-criteria" className="mt-8">
        <h2 id="task-criteria" className="text-lg font-medium">Success criteria</h2>
        {criteria.length === 0 ? <p className="mt-3 text-sm text-ink-soft">No criteria were provided.</p> : (
          <>
            <p className="mt-2 text-sm text-ink-soft">Listed in rubric order. Weights indicate relative importance.</p>
            <ol className="mt-4 divide-y divide-line border-y border-line">
              {criteria.map((criterion, index) => (
                <li key={criterion.id} className="flex items-start gap-4 py-4">
                  <span aria-hidden="true" className="pt-0.5 font-mono text-xs text-ink-faint">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{criterion.description}</p>
                    <p className="mt-2 text-xs text-ink-soft">Weight {criterion.weight}</p>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section aria-labelledby="task-people" className="mt-8">
        <h2 id="task-people" className="text-lg font-medium">Task information</h2>
        <dl className="mt-4 space-y-5 text-sm">
          <div>
            <dt className="text-ink-soft">Deadline</dt>
            <dd className="mt-1">{task.deadline
              ? <time dateTime={task.deadline}>{new Date(task.deadline).toLocaleString()} (your local time)</time>
              : "No deadline set"}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Requester / creator{creator ? " (you)" : ""}</dt>
            <dd className="mt-1 break-all font-mono text-xs leading-relaxed">{task.creator}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Assigned worker{worker ? " (you)" : ""}</dt>
            <dd className="mt-1 break-all font-mono text-xs leading-relaxed">{task.assignee ?? "Not assigned"}</dd>
          </div>
        </dl>
      </section>

      {/* Requester review flow: submission, deterministic validation, AI review
          and the human confirmation gate. Creator-only actions render only for
          the creator; the worker sees the same authoritative results. */}
      <RequesterReview state={state} isCreator={creator} isWorker={worker} onRefresh={onRefresh} />
      {/* Payment stage: requester cUSD authorization, worker-triggered
          settlement. Renders only once a submission is approved; the backend
          relayer performs the actual transfer. */}
      <PaymentSection state={state} isCreator={creator} isWorker={worker} onRefresh={onRefresh} />
      <TaskActivity taskId={task.id} />
    </article>
  );
}

function ClaimSection({ task, onClaimed }: { task: TaskResponse; onClaimed: (task: TaskResponse) => void }) {
  const [pending, setPending] = useState(false);
  const claiming = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const deadlinePassed = !!task.deadline && new Date(task.deadline).getTime() <= Date.now();

  async function claim() {
    if (claiming.current) return;
    setError(null);
    claiming.current = true;
    setPending(true);
    try {
      // Identity comes from the session; the backend performs the atomic
      // OPEN -> ASSIGNED -> IN_PROGRESS transition and returns the new task.
      const { task: claimed } = await apiFetch<{ task: TaskResponse }>(
        `/api/tasks/${encodeURIComponent(task.id)}/claim`,
        { method: "POST", cache: "no-store" }
      );
      onClaimed(claimed);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 401
        ? "Your session has expired. Reconnect your wallet, then try again."
        : caught instanceof Error ? caught.message : "Could not claim this task.");
    } finally {
      claiming.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="claim-heading" className="mt-7 border-t border-line pt-6">
      <h2 id="claim-heading" className="text-lg font-medium">Claim this task</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Claiming assigns this task to you and starts work. The first claimant wins; the requester cannot claim their own task.
      </p>
      {deadlinePassed && <p className="mt-3 text-sm text-ink-soft">The deadline has passed, so this task can no longer be claimed.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-fail">{error}</p>}
      <div className="mt-4">
        <Button onClick={claim} disabled={pending || deadlinePassed}>{pending ? "Claiming…" : "Claim task"}</Button>
      </div>
    </section>
  );
}
