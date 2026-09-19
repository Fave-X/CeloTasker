"use client";

/**
 * CeloTasker — requester review flow (Stages 5A/5B + confirmation gate).
 *
 * Read-only presentation of the authoritative task-state bundle
 * (GET /api/tasks/[id]/state, same creator-or-assignee ACL as the detail
 * endpoint): the worker's submission, the deterministic validation result,
 * the AI review summary and the human confirmation gate. The three requester
 * actions POST to the EXISTING creator-only endpoints and then refetch the
 * bundle — no validation, review or approval logic is ever computed here and
 * no result is invented client-side. The AI recommendation never authorizes
 * payment; only the explicit confirmation step approves the submission, and
 * confirmation itself moves no money (settlement is a separate stage).
 */
import { useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api/client";
import type {
  PublicEvaluation,
  PublicSettlement,
  PublicSubmission,
  PublicValidation,
} from "@/lib/api/serialize";
import { Button } from "@/components/ui/Button";
import type { TaskResponse } from "./TaskList";

/** JSON date fields arrive as strings over the API, not database Dates. */
export type SubmissionJson = Omit<PublicSubmission, "createdAt"> & { createdAt: string };
export type SettlementJson = Omit<PublicSettlement, "createdAt"> & { createdAt: string };

/** The GET /api/tasks/[id]/state response body as the client receives it. */
export type TaskStateJson = {
  task: TaskResponse;
  submission: SubmissionJson | null;
  validation: PublicValidation | null;
  evaluation: PublicEvaluation | null;
  settlement: SettlementJson | null;
};

/**
 * Mirror of SubmitWorkForm.buildContentRef. The stored reference is ONE
 * well-formed https URI whose encoded `purpose` parameter carries the
 * one-sentence description, so the requester sees the work URL and the
 * sentence exactly as submitted. A reference without a purpose parameter is
 * a bare work URL; anything unparsable or non-https is shown verbatim as a
 * reference rather than guessed at.
 */
export function parseContentRef(ref: string): { url: string; purpose: string | null } | null {
  try {
    const parsed = new URL(ref);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return null;
    const purpose = parsed.searchParams.get("purpose");
    if (purpose === null) return { url: parsed.toString(), purpose: null };
    parsed.searchParams.delete("purpose");
    return { url: parsed.toString().replace(/\?$/, ""), purpose };
  } catch {
    return null;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}

function actionError(caught: unknown, fallback: string): string {
  return caught instanceof ApiError && caught.status === 401
    ? "Your session has expired. Reconnect your wallet, then try again."
    : caught instanceof Error ? caught.message : fallback;
}

/**
 * Shared pending/error handling for the three creator actions. `wrap` guards
 * double-submits (the running flag lives in a ref, so a fast double-click
 * cannot fire two POSTs), maps failures to a readable message, and always
 * clears the pending state.
 */
function usePendingAction(): {
  pending: boolean;
  error: string | null;
  wrap: (action: () => Promise<void>, fallback: string) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  function wrap(action: () => Promise<void>, fallback: string): Promise<void> {
    if (running.current) return Promise.resolve();
    running.current = true;
    setPending(true);
    setError(null);
    return action()
      .catch((caught: unknown) => {
        setError(actionError(caught, fallback));
      })
      .finally(() => {
        running.current = false;
        setPending(false);
      });
  }
  return { pending, error, wrap };
}

/** Creator action: SUBMITTED -> UNDER_VALIDATION -> UNDER_REVIEW, server-side. */
function ValidateAction({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const { pending, error, wrap } = usePendingAction();
  function run() {
    void wrap(async () => {
      await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/validate`, {
        method: "POST",
        cache: "no-store",
      });
      // The state machine moved the task and recorded the result; refetch the
      // authoritative bundle instead of keeping local copies.
      onRefresh();
    }, "Could not run validation.");
  }
  return (
    <div className="mt-4">
      <p className="text-sm leading-relaxed text-ink-soft">
        Runs the deterministic checks first: reference format, submitter, deadline and rubric. No
        judgment of the actual content happens here.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-fail">{error}</p>}
      <div className="mt-4">
        <Button onClick={run} disabled={pending}>{pending ? "Validating…" : "Run validation"}</Button>
      </div>
    </div>
  );
}

/** Creator action: the advisory AI evaluation over the current submission. */
function ReviewAction({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const { pending, error, wrap } = usePendingAction();
  function run() {
    void wrap(async () => {
      await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/review`, {
        method: "POST",
        cache: "no-store",
      });
      onRefresh();
    }, "Could not run the AI review.");
  }
  return (
    <div className="mt-4">
      <p className="text-sm leading-relaxed text-ink-soft">
        The model reads the submitted reference against the rubric and returns a recommendation.
        Deterministic policy makes the actual decision, and approving here never authorizes payment.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-fail">{error}</p>}
      <div className="mt-4">
        <Button onClick={run} disabled={pending}>{pending ? "Reviewing…" : "Run AI review"}</Button>
      </div>
    </div>
  );
}

/** Creator action: the authoritative human confirmation gate. Moves no money. */
function ConfirmAction({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const { pending, error, wrap } = usePendingAction();
  function run() {
    void wrap(async () => {
      // Authoritative human step. No request body; the server derives every
      // parameter. Settlement is NOT triggered here.
      await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/confirm`, {
        method: "POST",
        cache: "no-store",
      });
      onRefresh();
    }, "Could not confirm the submission.");
  }
  return (
    <div className="mt-4">
      <p className="text-sm font-medium">AI reviewed the work. You authorize the approved submission.</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Confirming marks the submission approved. It does not move money; payment settlement is a
        separate stage.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-fail">{error}</p>}
      <div className="mt-4">
        <Button onClick={run} disabled={pending}>{pending ? "Confirming…" : "Confirm submission"}</Button>
      </div>
    </div>
  );
}

function SubmissionBlock({ submission }: { submission: SubmissionJson }) {
  const parsed = parseContentRef(submission.contentRef);
  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">Submission</h3>
      <dl className="mt-4 space-y-5 text-sm">
        <Row label="Submitted by">
          <span className="break-all font-mono text-xs leading-relaxed">{submission.submitter}</span>
        </Row>
        <Row label="Received">
          <time dateTime={submission.createdAt}>
            {new Date(submission.createdAt).toLocaleString()} (your local time)
          </time>
        </Row>
        {parsed ? (
          <>
            <Row label="Work link">
              <a href={parsed.url} target="_blank" rel="noreferrer" className="break-all text-celo hover:underline">
                {parsed.url}
              </a>
            </Row>
            {parsed.purpose && <Row label="What it is for">{parsed.purpose}</Row>}
          </>
        ) : (
          <Row label="Reference">
            <span className="break-all font-mono text-xs leading-relaxed">{submission.contentRef}</span>
          </Row>
        )}
        <Row label="Submission status">
          <span className="font-mono text-xs">{submission.status}</span>
        </Row>
      </dl>
    </div>
  );
}

function ValidationBlock({ task, validation, isCreator, onRefresh }: {
  task: TaskResponse;
  validation: PublicValidation | null;
  isCreator: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">Deterministic validation</h3>
      {validation ? (
        <>
          <p className="mt-3 text-sm leading-relaxed">
            {validation.valid ? "All deterministic checks passed." : "Deterministic checks failed."}
          </p>
          {validation.failureReasons.length > 0 && (
            <p className="mt-2 break-words font-mono text-xs leading-relaxed text-fail">
              Failure reasons: {validation.failureReasons.join(", ")}
            </p>
          )}
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {validation.checks.map((check) => (
              <li key={check.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0">{check.label}</span>
                  <span className={check.passed ? "shrink-0 text-ink-soft" : "shrink-0 font-medium text-fail"}>
                    {check.passed ? "Passed" : "Failed"}
                  </span>
                </div>
                {check.detail && (
                  <p className="mt-1 break-words font-mono text-xs leading-relaxed text-fail">{check.detail}</p>
                )}
              </li>
            ))}
          </ul>
          <dl className="mt-5 space-y-5 text-sm">
            <Row label="Content proven">
              {validation.contentProven
                ? "Yes"
                : "No. A reference alone never proves the work; content is judged during review."}
            </Row>
            <Row label="Validated">
              <time dateTime={validation.validatedAt}>
                {new Date(validation.validatedAt).toLocaleString()} (your local time)
              </time>
            </Row>
          </dl>
        </>
      ) : isCreator && task.status === "SUBMITTED" ? (
        <ValidateAction taskId={task.id} onRefresh={onRefresh} />
      ) : task.status === "UNDER_VALIDATION" ? (
        <p role="status" className="mt-3 text-sm text-ink-soft">Validation is running.</p>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">
          {isCreator ? "Validation has not run yet." : "Awaiting the requester to run deterministic validation."}
        </p>
      )}
    </div>
  );
}

function EvaluationSummary({ evaluation, criteria }: {
  evaluation: PublicEvaluation;
  criteria: TaskResponse["criteria"];
}) {
  const results = evaluation.criterionResults;
  const ordered = criteria.map((criterion) => ({
    criterion,
    result: results.find((entry) => entry.criterionId === criterion.id) ?? null,
  }));
  const extras = results.filter((entry) => !criteria.some((criterion) => criterion.id === entry.criterionId));
  return (
    <div className="mt-4">
      <dl className="space-y-5 text-sm">
        <Row label="AI recommendation">
          <span className="font-mono text-xs">{evaluation.recommendation}</span>
          <span className="ml-2 text-ink-soft">Advisory. It is not payment authorization.</span>
        </Row>
        <Row label="Decision">
          <span className="font-mono text-xs">{evaluation.decision}</span>
          <span className="ml-2 text-ink-soft">The deterministic policy applied to the recommendation.</span>
        </Row>
        {evaluation.downgraded && (
          <Row label="Downgraded">
            <span className="text-fail">The deterministic policy overrode the recommendation.</span>
            {evaluation.reason && (
              <span className="ml-2 break-all font-mono text-xs text-fail">{evaluation.reason}</span>
            )}
          </Row>
        )}
        <Row label="Provider and model">
          <span className="break-all font-mono text-xs">{evaluation.providerId} · {evaluation.modelId}</span>
        </Row>
        <Row label="Outcome">
          <span className="font-mono text-xs">{evaluation.outcome}</span>
        </Row>
      </dl>
      <h4 className="mt-5 text-sm font-medium text-ink-soft">Feedback</h4>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{evaluation.overallFeedback}</p>
      <h4 className="mt-5 text-sm font-medium text-ink-soft">Criterion results</h4>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {ordered.map(({ criterion, result }) => (
          <li key={criterion.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0">{criterion.description}</span>
              <span className={result?.satisfied ? "shrink-0 text-ink-soft" : "shrink-0 font-medium text-fail"}>
                {result ? (result.satisfied ? "Satisfied" : "Not satisfied") : "Not reported"}
              </span>
            </div>
            {result && (
              <p className="mt-1 break-words text-sm leading-relaxed text-ink-soft">{result.reasoning}</p>
            )}
          </li>
        ))}
        {extras.map((result) => (
          <li key={result.criterionId} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 break-all font-mono text-xs">{result.criterionId}</span>
              <span className="shrink-0 font-medium text-fail">Not in the rubric</span>
            </div>
            <p className="mt-1 break-words text-sm leading-relaxed text-ink-soft">{result.reasoning}</p>
          </li>
        ))}
      </ul>
      <h4 className="mt-5 text-sm font-medium text-ink-soft">Policy checks</h4>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {evaluation.policyChecks.map((check) => (
          <li key={check.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
            <span className="min-w-0">{check.label}</span>
            <span className={check.passed ? "shrink-0 text-ink-soft" : "shrink-0 font-medium text-fail"}>
              {check.passed ? "Passed" : "Failed"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewBlock({ task, evaluation, criteria, submissionStatus, isCreator, onRefresh }: {
  task: TaskResponse;
  evaluation: PublicEvaluation | null;
  criteria: TaskResponse["criteria"];
  submissionStatus: string;
  isCreator: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">AI review</h3>
      {evaluation ? (
        <EvaluationSummary evaluation={evaluation} criteria={criteria} />
      ) : isCreator && task.status === "UNDER_REVIEW" ? (
        <ReviewAction taskId={task.id} onRefresh={onRefresh} />
      ) : task.status === "UNDER_REVIEW" ? (
        <p className="mt-3 text-sm text-ink-soft">
          Validation passed. Awaiting the requester to run the AI review.
        </p>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">
          {submissionStatus === "REJECTED"
            ? "The submission did not pass deterministic validation, so no AI review runs."
            : "The AI review has not run yet."}
        </p>
      )}
    </div>
  );
}

function ConfirmationBlock({ task, submission, evaluation, isCreator, onRefresh }: {
  task: TaskResponse;
  submission: SubmissionJson;
  evaluation: PublicEvaluation | null;
  isCreator: boolean;
  onRefresh: () => void;
}) {
  if (!isCreator || !evaluation) return null;
  // The AI review outcome is PENDING_HUMAN_CONFIRMATION when the requester CAN confirm.
  // Check both decision and outcome fields since the review service records the outcome
  // in both fields but we should be robust to either.
  const isPendingConfirmation =
    (evaluation.decision === "PENDING_HUMAN_CONFIRMATION" ||
      evaluation.outcome === "PENDING_HUMAN_CONFIRMATION") &&
    task.status === "UNDER_REVIEW" &&
    submission.status === "PENDING";
  const awaitingConfirmation = isPendingConfirmation;
  return (
    <div className="mt-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink-soft">Requester confirmation</h3>
      {awaitingConfirmation ? (
        <ConfirmAction taskId={task.id} onRefresh={onRefresh} />
      ) : submission.status === "APPROVED" ? (
        <p role="status" className="mt-3 text-sm leading-relaxed text-ink-soft">
          Submission approved. Payment settlement is the next stage.
        </p>
      ) : evaluation.decision === "REVISION_REQUESTED" || evaluation.outcome === "REVISION_REQUESTED" ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The review requested a revision from the worker. Reconfirm here after the revised work is
          reviewed again.
        </p>
      ) : evaluation.decision === "REJECTED" || evaluation.outcome === "TASK_REJECTED" ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The review rejected the submission. The task is closed.
        </p>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">Confirmation is not available in this state.</p>
      )}
    </div>
  );
}

/**
 * One coherent sequence for both roles: what was submitted, what the
 * deterministic validator found, what the AI review says, and who confirms.
 * Creator-only actions are rendered only for the creator; workers see the
 * same authoritative results read-only.
 */
export function RequesterReview({ state, isCreator, isWorker, onRefresh }: {
  state: TaskStateJson;
  isCreator: boolean;
  isWorker: boolean;
  onRefresh: () => void;
}) {
  const { task, submission, validation, evaluation } = state;
  if (!submission) return null;
  return (
    <section aria-labelledby="review-flow-heading" className="mt-8">
      <h2 id="review-flow-heading" className="text-lg font-medium">Review flow</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Deterministic validation, then an AI review, then the requester confirmation.
        {isCreator ? " The AI recommendation never authorizes payment; your confirmation does." : ""}
      </p>
      <SubmissionBlock submission={submission} />
      <ValidationBlock task={task} validation={validation} isCreator={isCreator} onRefresh={onRefresh} />
      <ReviewBlock
        task={task}
        evaluation={evaluation}
        criteria={task.criteria}
        submissionStatus={submission.status}
        isCreator={isCreator}
        onRefresh={onRefresh}
      />
      <ConfirmationBlock
        task={task}
        submission={submission}
        evaluation={evaluation}
        isCreator={isCreator}
        onRefresh={onRefresh}
      />
      {isWorker && evaluation?.decision === "PENDING_HUMAN_CONFIRMATION" && (
        <p className="mt-6 border-t border-line pt-6 text-sm text-ink-soft">
          The review satisfied the approval policy. The requester confirms the work next.
        </p>
      )}
      {isWorker && submission.status === "APPROVED" && (
        <p role="status" className="mt-6 border-t border-line pt-6 text-sm text-ink-soft">
          Your submission was approved. Payment is the next stage.
        </p>
      )}
    </section>
  );
}
