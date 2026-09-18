"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { buttonClasses } from "@/components/ui/buttonClasses";
import { useWallet } from "@/components/wallet/WalletProvider";
import { TaskList, type TaskResponse } from "./TaskList";

export function TaskBrowser({ mine = false }: { mine?: boolean }) {
  const wallet = useWallet();
  const identity = mine ? wallet.sessionAddress : null;
  const enabled = !mine || (wallet.status === "authenticated" && !!identity && wallet.onCelo);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    identity: string | null;
    tasks: TaskResponse[];
    error: string | null;
  } | null>(null);

  useEffect(() => {
    setResult(null);
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    apiFetch<{ tasks: TaskResponse[] }>(mine ? "/api/tasks/mine" : "/api/tasks", {
      cache: "no-store",
      signal: controller.signal,
    }).then(({ tasks }) => {
      if (active) setResult({ identity, tasks, error: null });
    }).catch((error: unknown) => {
      if (active) setResult({ identity, tasks: [], error:
        error instanceof ApiError && error.status === 401
          ? "Your session has expired. Reconnect your wallet and retry."
          : error instanceof Error ? error.message : "Could not load tasks.",
      });
    });
    return () => { active = false; controller.abort(); };
  }, [enabled, identity, mine, attempt]);

  const current = result?.identity === identity ? result : null;
  return (
    <section className="max-w-[880px]">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{mine ? "My Work" : "Tasks"}</h1>
          <p className="mt-2 text-sm text-ink-soft">{mine ? "Tasks you created and work assigned to you." : "Browse open tasks and find work worth doing."}</p>
        </div>
        <Link href="/tasks/new" className={buttonClasses()}>Create Task</Link>
      </div>
      {!enabled ? (
        <p role="status" className="border-t border-line py-6 text-ink-soft">
          {wallet.status === "detecting" || wallet.status === "connecting" ? "Checking your wallet session…" : "Connect your wallet on Celo Mainnet using the header to view My Work."}
        </p>
      ) : !current ? (
        <p role="status" className="py-6 text-ink-soft">Loading tasks…</p>
      ) : current.error ? (
        <div className="space-y-3 border-t border-line py-6">
          <p role="alert" className="text-fail">{current.error}</p>
          <Button variant="secondary" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>Retry</Button>
        </div>
      ) : current.tasks.length === 0 ? (
        <p role="status" className="border-t border-line py-6 text-ink-soft">{mine ? "No tasks created by or assigned to you yet." : "No open tasks right now. You can create the first one."}</p>
      ) : <TaskList tasks={current.tasks} sessionAddress={identity} />}
    </section>
  );
}
