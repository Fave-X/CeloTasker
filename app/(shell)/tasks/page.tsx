import type { Metadata } from "next";
import { TaskBrowser } from "@/components/tasks/TaskBrowser";

export const metadata: Metadata = { title: "Tasks — CeloTasker" };

export default function TasksPage() {
  return (
    <TaskBrowser />
  );
}