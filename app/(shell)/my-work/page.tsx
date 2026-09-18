import type { Metadata } from "next";
import { TaskBrowser } from "@/components/tasks/TaskBrowser";

export const metadata: Metadata = { title: "My Work — CeloTasker" };

export default function MyWorkPage() {
  return (
    <TaskBrowser mine />
  );
}