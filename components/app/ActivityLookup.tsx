"use client";

/**
 * CeloTasker — Activity surface.
 *
 * The backend records activity per task (GET /api/tasks/[id]/events, creator
 * or assignee only); there is no cross-task events feed, and this surface
 * never invents one. With a task id in the query string
 * (/activity?task=<id>) it renders that task's audit trail; without one it
 * explains where activity lives. Nothing is ever fabricated to fill the page.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { TaskActivity } from "@/components/tasks/TaskActivity";

export function ActivityLookup() {
  const params = useSearchParams();
  const taskId = params.get("task")?.trim() ?? "";

  if (taskId) {
    return (
      <div className="max-w-[880px]">
        <p className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-ink-faint">
          Task audit trail
        </p>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-ink">
          Activity
        </h1>
        <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-ink-soft">
          {taskId}
        </p>
        <div className="mt-7">
          <TaskActivity taskId={taskId} />
        </div>
      </div>
    );
  }

  return (
    <section className="max-w-[560px]">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">
        Activity
      </h1>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
        Activity is recorded per task, as an append-only audit trail: task
        created, worker claimed, work submitted, validation, AI review,
        requester confirmation, payment and completion. Open a task to read
        its trail — it is shown at the bottom of every task page.
      </p>
      <p className="mt-5 border-l-2 border-line-strong pl-3.5 text-[13px] leading-relaxed text-ink-faint">
        A single task's trail can also be opened directly at
        /activity?task=&lt;task id&gt;.
      </p>
      <div className="mt-7 flex flex-wrap gap-5 text-sm text-celo">
        <Link href="/my-work" className="hover:underline">My Work</Link>
        <Link href="/tasks" className="hover:underline">Tasks</Link>
      </div>
    </section>
  );
}
