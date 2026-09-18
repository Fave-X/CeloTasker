import type { Metadata } from "next";
import { TaskDetail } from "@/components/tasks/TaskDetail";

export const metadata: Metadata = { title: "Task Detail — CeloTasker" };

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TaskDetail key={id} id={id} />;
}
