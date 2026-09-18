"use client";

import Link from "next/link";
import type { PublicTask } from "@/lib/api/serialize";
import { CUSD_ADDRESS } from "@/lib/celo";

/** JSON dates from the existing task serializer, not database Date objects. */
export type TaskResponse = Omit<PublicTask, "deadline" | "createdAt"> & {
  deadline: string | null;
  createdAt: string;
};

export function TaskList({ tasks, sessionAddress }: {
  tasks: TaskResponse[];
  sessionAddress?: string | null;
}) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {tasks.map((task) => {
        const mine = sessionAddress?.toLowerCase();
        const created = mine && task.creator.toLowerCase() === mine;
        const assigned = mine && task.assignee?.toLowerCase() === mine;
        return (
          <li key={task.id}>
            <Link href={`/tasks/${encodeURIComponent(task.id)}`} className="block rounded-control px-2 py-5 transition-colors hover:bg-paper-sunken">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="min-w-0 break-words text-lg font-medium">{task.title}</h2>
                <span className="shrink-0 text-sm font-medium text-celo">
                  {task.rewardAmount} {task.rewardToken.toLowerCase() === CUSD_ADDRESS.toLowerCase() ? "cUSD" : "(other reward token)"}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 break-words text-sm leading-relaxed text-ink-soft">{task.description}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                <span className="capitalize">{task.status.toLowerCase().replaceAll("_", " ")}</span>
                {created && <span>Created by you</span>}
                {assigned && <span>Assigned to you</span>}
                {task.deadline && <span>Due <time dateTime={task.deadline}>{new Date(task.deadline).toLocaleString()}</time></span>}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
