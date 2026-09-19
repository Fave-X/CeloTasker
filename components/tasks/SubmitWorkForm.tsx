"use client";

import { useRef, useState, type FormEvent } from "react";
import { apiFetch, ApiError, jsonBody } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { useWallet } from "@/components/wallet/WalletProvider";

const inputClass = "mt-2 block w-full rounded-control border border-line-strong bg-paper-raised px-3 py-2 text-sm text-ink";

/** Mirrors the backend contentRef bound (z.string().min(1).max(2048)). */
const MAX_CONTENT_REF_LENGTH = 2048;

/** A rubric line as the worker needs to read it. */
type SubmissionCriterion = {
  id: string;
  description: string;
  weight: number;
  order: number;
};

/**
 * The worker submission form. Everything shown here is derived from the task
 * record itself — title, description and the success criteria — so the worker
 * answers against exactly what the requester asked for.
 *
 * The backend stores ONE opaque `contentRef` string per submission (1..2048
 * chars). It is now the worker's raw text, verbatim: no URL building and no
 * query parameters. The optional evidence link is deliberately NOT folded into
 * contentRef, so it stays with this form and is never sent.
 */
export function SubmitWorkForm({ taskId, title, description, criteria, deadline, onSubmitSuccess }: {
  taskId: string;
  title: string;
  description: string;
  criteria: readonly SubmissionCriterion[];
  deadline: string | null;
  onSubmitSuccess: () => void;
}) {
  const wallet = useWallet();
  const authenticated = wallet.status === "authenticated" && !!wallet.sessionAddress && wallet.onCelo;
  const [answer, setAnswer] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const submitting = useRef(false);
  const deadlinePassed = deadline ? new Date(deadline).getTime() <= Date.now() : false;
  const orderedCriteria = [...criteria].sort((a, b) => a.order - b.order);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setErrors([]);
    if (!authenticated || !wallet.sessionAddress) {
      setErrors(["Connect your wallet using the header before submitting work."]);
      return;
    }
    if (deadlinePassed) {
      setErrors(["The deadline has passed, so this task is no longer accepting submissions."]);
      return;
    }
    const reference = answer.trim();
    if (reference.length === 0) {
      setErrors(["Describe the work you completed before submitting."]);
      return;
    }
    if (reference.length > MAX_CONTENT_REF_LENGTH) {
      setErrors([`Your response is ${reference.length} characters; the limit is ${MAX_CONTENT_REF_LENGTH}. Shorten it and try again.`]);
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      // The request schema requires `submitter`, but the backend derives the
      // worker identity from the verified session and ignores the body value.
      await apiFetch("/api/submissions", jsonBody({
        taskId,
        submitter: wallet.sessionAddress,
        contentRef: reference,
      }));
      onSubmitSuccess();
    } catch (error) {
      setErrors([error instanceof ApiError && error.status === 401
        ? "Your session has expired. Reconnect your wallet, then try again."
        : error instanceof Error ? error.message : "Could not submit work."]);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="submit-heading" className="mt-7 border-t border-line pt-6">
      <h2 id="submit-heading" className="text-lg font-medium">Submit your work</h2>
      
      {/* Task context — rendered from the server-side task record */}
      <section className="mt-4 space-y-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-soft">{description}</p>
        {orderedCriteria.length > 0 && (
          <div className="mt-3 space-y-2">
            <h4 className="text-sm font-medium text-ink-soft">Success criteria (in rubric order):</h4>
            <ol className="space-y-2">
              {orderedCriteria.map((c, i) => (
                <li key={c.id} className="flex gap-2 text-sm text-ink-soft">
                  <span className="font-mono text-xs text-ink-faint shrink-0">{String(i + 1).padStart(2, "0")}.</span>
                  <span className="break-words">{c.description}</span>
                  <span className="text-xs text-ink-faint shrink-0">Weight {c.weight}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <form onSubmit={submit} className="mt-5 space-y-5">
        <fieldset disabled={pending} className="space-y-4 disabled:opacity-60">
          <label className="block text-sm font-medium">
            Your submission
            <textarea
              required
              minLength={1}
              maxLength={MAX_CONTENT_REF_LENGTH}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className={inputClass}
              rows={6}
              placeholder="Describe the work you completed. Be specific — this text becomes the submission reference."
            />
          </label>
          <label className="block text-sm font-medium">
            Evidence link (optional)
            <input
              type="url"
              inputMode="url"
              placeholder="https://example.com/proof.png"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-ink-soft">
              Optional supporting URL (not sent as part of the submission reference).
            </p>
          </label>
        </fieldset>
        {errors.length > 0 && (
          <div role="alert" className="rounded-control bg-fail-wash p-4 text-sm text-fail">
            <p className="font-medium">Work could not be submitted</p>
            <ul className="mt-2 list-inside list-disc space-y-1">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
          </div>
        )}
        <Button type="submit" disabled={!authenticated || pending || deadlinePassed}>
          {pending ? "Submitting…" : "Submit work"}
        </Button>
        {deadlinePassed && <p className="mt-2 text-sm text-ink-soft">The deadline has passed, so this task is no longer accepting submissions.</p>}
      </form>
    </section>
  );
}
