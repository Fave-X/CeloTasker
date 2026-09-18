"use client";

import { useRef, useState, type FormEvent } from "react";
import { apiFetch, ApiError, jsonBody } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { useWallet } from "@/components/wallet/WalletProvider";

const inputClass = "mt-2 block w-full rounded-control border border-line-strong bg-paper-raised px-3 py-2 text-sm text-ink";

/** Mirrors the backend contentRef bound (z.string().max(2048)). */
const MAX_CONTENT_REF_LENGTH = 2048;

/**
 * The backend stores exactly ONE opaque reference string per submission
 * (contentRef: 1..2048 chars, ipfs:// or a well-formed https URL). The demo
 * submission carries a public HTTPS URL plus a one-sentence purpose, so both
 * travel inside that single reference: the sentence becomes an encoded
 * `purpose` query parameter. The result is still one well-formed https URI —
 * the deterministic validator's requirement — and the reviewer sees the ref
 * verbatim later. No new storage architecture.
 */
export function buildContentRef(url: string, purpose: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null;
    parsed.searchParams.set("purpose", purpose);
    return parsed.toString();
  } catch {
    return null;
  }
}

export function SubmitWorkForm({ taskId, deadline, onSubmitSuccess }: {
  taskId: string;
  deadline: string | null;
  onSubmitSuccess: () => void;
}) {
  const wallet = useWallet();
  const authenticated = wallet.status === "authenticated" && !!wallet.sessionAddress && wallet.onCelo;
  const [url, setUrl] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const submitting = useRef(false);
  const deadlinePassed = deadline ? new Date(deadline).getTime() <= Date.now() : false;

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
    const sentence = purpose.trim().replace(/\s+/g, " ");
    if (sentence.length === 0) {
      setErrors(["Add one sentence explaining what the website is for."]);
      return;
    }
    const reference = buildContentRef(url.trim(), sentence);
    if (!reference) {
      setErrors(["Enter a public https:// URL, for example https://example.com."]);
      return;
    }
    if (reference.length > MAX_CONTENT_REF_LENGTH) {
      setErrors(["The URL plus sentence is too long for a single reference. Use a shorter URL or sentence."]);
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

  const preview = purpose.trim() ? buildContentRef(url.trim(), purpose.trim().replace(/\s+/g, " ")) : null;

  return (
    <section aria-labelledby="submit-heading" className="mt-7 border-t border-line pt-6">
      <h2 id="submit-heading" className="text-lg font-medium">Submit your work</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Provide the public link to the work you completed, plus one sentence on what the website is for. Both travel together as the submission reference.
      </p>
      <form onSubmit={submit} className="mt-5 space-y-5">
        <fieldset disabled={pending} className="space-y-5 disabled:opacity-60">
          <label className="block text-sm font-medium">Public URL of the work
            <input required type="url" inputMode="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} className={inputClass} />
          </label>
          <label className="block text-sm font-medium">What is the website for? (one sentence)
            <input required maxLength={300} value={purpose} onChange={(event) => setPurpose(event.target.value)} className={inputClass} />
          </label>
          {preview && <p className="break-all font-mono text-xs leading-relaxed text-ink-soft">Reference to submit: {preview}</p>}
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
