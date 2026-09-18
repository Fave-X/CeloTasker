"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { apiFetch, ApiError, jsonBody } from "@/lib/api/client";
import { CreateTaskRequestSchema } from "@/lib/validation/ValidationSchemas";
import { CUSD_ADDRESS } from "@/lib/celo";
import { Button } from "@/components/ui/Button";
import { buttonClasses } from "@/components/ui/buttonClasses";
import { useWallet } from "@/components/wallet/WalletProvider";
import { TaskList, type TaskResponse } from "./TaskList";

const inputClass = "mt-2 block w-full rounded-control border border-line-strong bg-paper-raised px-3 py-2 text-sm text-ink";

export function CreateTaskForm() {
  const wallet = useWallet();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reward, setReward] = useState("1");
  const [deadline, setDeadline] = useState("");
  const [criteria, setCriteria] = useState([{ id: 0, description: "", weight: "1" }]);
  const nextId = useRef(1);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<TaskResponse | null>(null);
  const authenticated = wallet.status === "authenticated" && !!wallet.sessionAddress && wallet.onCelo;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setErrors([]);
    if (!authenticated) {
      setErrors(["Connect your wallet using the header before creating a task."]);
      return;
    }
    if (!/^[1-9]\d*$/.test(reward)) {
      setErrors(["Reward must be a positive whole number of cUSD, for example 1."]);
      return;
    }
    const due = deadline ? new Date(deadline) : undefined;
    if (due && (!Number.isFinite(due.getTime()) || due.getTime() <= Date.now())) {
      setErrors(["Choose a deadline in the future, or leave it blank."]);
      return;
    }
    const parsed = CreateTaskRequestSchema.safeParse({
      title: title.trim(),
      description: description.trim(),
      // Whole cUSD integer string, deliberately not converted to base units.
      rewardAmount: reward,
      rewardToken: CUSD_ADDRESS,
      creator: wallet.sessionAddress,
      ...(due ? { deadline: due } : {}),
      criteria: criteria.map((criterion, order) => ({
        description: criterion.description.trim(), weight: Number(criterion.weight), order,
      })),
    });
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => `${issue.path.join(" / ")}: ${issue.message}`));
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      const result = await apiFetch<{ task: TaskResponse }>("/api/tasks", jsonBody(parsed.data));
      setCreated(result.task);
    } catch (error) {
      setErrors([error instanceof ApiError && error.status === 401
        ? "Your session has expired. Reconnect your wallet, then try again."
        : error instanceof Error ? error.message : "Could not create task."]);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (created) {
    return (
      <section className="max-w-[720px]">
        <h1 className="text-3xl font-semibold tracking-tight">Task created</h1>
        <p role="status" className="my-4 text-ink-soft">Your task is now open. It is also available in My Work.</p>
        <TaskList tasks={[created]} sessionAddress={wallet.sessionAddress} />
        <Link href="/my-work" className={buttonClasses("secondary", "md", "mt-6")}>Go to My Work</Link>
      </section>
    );
  }

  return (
    <section className="max-w-[720px]">
      <Link href="/tasks" className="text-sm text-celo hover:underline">Back to tasks</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Create Task</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">Describe the work and how you will judge a successful result.</p>
      {!authenticated && <p role="status" className="mt-5 rounded-control bg-warn-wash p-3 text-sm">Connect your wallet on Celo Mainnet using the header to create a task.</p>}
      <form onSubmit={submit} className="mt-7 space-y-6">
        <fieldset disabled={pending} className="space-y-6 disabled:opacity-60">
          <label className="block text-sm font-medium">Title
            <input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
          </label>
          <label className="block text-sm font-medium">Description
            <textarea required maxLength={10000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} className={inputClass} />
          </label>
          <label className="block text-sm font-medium">Reward (whole cUSD)
            <input required inputMode="numeric" pattern="[1-9][0-9]*" value={reward} onChange={(event) => setReward(event.target.value)} aria-describedby="reward-help" className={inputClass} />
            <span id="reward-help" className="mt-1 block font-normal text-ink-soft">Use 1 cUSD for a demo task. Whole numbers only.</span>
          </label>
          <label className="block text-sm font-medium">Deadline (optional, your local time)
            <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} className={inputClass} />
          </label>
          <fieldset className="space-y-4 border-t border-line pt-5">
            <legend className="text-base font-medium">Success criteria</legend>
            <p className="text-sm text-ink-soft">Add 1–20 criteria. Weights from 1–100 express relative importance; equal weights mean equal importance.</p>
            {criteria.map((criterion, index) => (
              <div key={criterion.id} className="space-y-3 rounded-card border border-line p-4">
                <label className="block text-sm font-medium">Criterion {index + 1}
                  <textarea required maxLength={500} rows={2} value={criterion.description} onChange={(event) => setCriteria((items) => items.map((item) => item.id === criterion.id ? { ...item, description: event.target.value } : item))} className={inputClass} />
                </label>
                <div className="flex items-end justify-between gap-3">
                  <label className="block text-sm font-medium">Weight
                    <input type="number" required min={1} max={100} step={1} value={criterion.weight} onChange={(event) => setCriteria((items) => items.map((item) => item.id === criterion.id ? { ...item, weight: event.target.value } : item))} className={`${inputClass} max-w-24`} />
                  </label>
                  <Button variant="quiet" disabled={criteria.length === 1} aria-label={`Remove criterion ${index + 1}`} onClick={() => setCriteria((items) => items.filter((item) => item.id !== criterion.id))}>Remove</Button>
                </div>
              </div>
            ))}
            <Button variant="secondary" disabled={criteria.length >= 20} onClick={() => {
              const id = nextId.current++;
              setCriteria((items) => [...items, { id, description: "", weight: "1" }]);
            }}>Add criterion</Button>
          </fieldset>
        </fieldset>
        {errors.length > 0 && (
          <div role="alert" className="rounded-control bg-fail-wash p-4 text-sm text-fail">
            <p className="font-medium">Task could not be created</p>
            <ul className="mt-2 list-inside list-disc space-y-1">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
          </div>
        )}
        <Button type="submit" disabled={!authenticated || pending}>{pending ? "Creating task…" : "Create Task"}</Button>
      </form>
    </section>
  );
}
