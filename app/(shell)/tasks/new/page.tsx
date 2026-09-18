import type { Metadata } from "next";
import { CreateTaskForm } from "@/components/tasks/CreateTaskForm";

export const metadata: Metadata = { title: "Create Task — CeloTasker" };

export default function CreateTaskPage() {
  return <CreateTaskForm />;
}
