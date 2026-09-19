/**
 * CeloTasker — Deterministic submission validator (Stage 5A).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * This module is the DETERMINISTIC layer that gates the workflow between
 * submission and review. It is PURE:
 * - no LLM, no network, no clock-dependent branching, no randomness — the
 *   same (task, submission) input always yields the same result;
 * - it never approves work: it only checks well-formedness, consistency and
 *   rubric presence. Judgement of the actual CONTENT is deferred to the
 *   review stage (human/AI) under UNDER_REVIEW;
 * - a contentRef is a REFERENCE, never proof: an evidence URL by itself is
 *   never treated as proof that the evidence exists or matches the rubric.
 *   Every result therefore carries contentProven: false.
 */
import type { RubricCriteria, Submission, Task } from "@prisma/client";
// Reuses the SINGLE authoritative dev-override predicate from the evaluator, so
// the two relaxed paths (evaluation fallback + free-text submissions) can never
// drift apart on what "dev mode" means.
import { isDevOverrideArmed } from "../evaluation/GeminiEvaluator.ts";

/** URI schemes a submission content reference may use. */
const ALLOWED_SCHEMES = ["ipfs", "https"] as const;

/** Max contentRef length (mirrors the submission Zod schema bound). */
const MAX_CONTENT_REF_LENGTH = 2048;

/**
 * IPFS CID: CIDv0 ("Qm" + 44 base58 chars) or CIDv1 in base32
 * (59 lowercase base32 chars for sha2-256 payloads).
 */
const IPFS_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|[a-z2-7]{59})$/;

export interface CriterionCheck {
  /** Stable machine-readable check id — doubles as the failure reason. */
  id: string;
  /** Human-readable description of what was checked. */
  label: string;
  passed: boolean;
  /** Deterministic detail (null when the check passed). */
  detail: string | null;
}

export interface ValidationResult {
  submissionId: string;
  taskId: string;
  /** Overall deterministic verdict: all checks passed. */
  valid: boolean;
  /** Criterion-level checks, in deterministic order. */
  checks: CriterionCheck[];
  /** Stable ids of the failed checks (empty when valid). */
  failureReasons: string[];
  /**
   * ALWAYS false: a contentRef is only a reference. Deterministic validation
   * can never prove the referenced content exists or satisfies the rubric —
   * content verification is exclusively the review stage's job.
   */
  contentProven: false;
  /** ISO-8601 timestamp of when the deterministic validation ran. */
  validatedAt: string;
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail: string | null
): CriterionCheck {
  return { id, label, passed, detail };
}

/** Syntactic well-formedness of the content reference (no fetching). */
function isWellFormedContentRef(ref: string): { ok: boolean; detail: string | null } {
  if (ref.startsWith("ipfs://")) {
    const cid = ref.slice("ipfs://".length);
    if (!IPFS_CID.test(cid)) {
      return { ok: false, detail: "not_a_valid_ipfs_cid" };
    }
    return { ok: true, detail: null };
  }
  try {
    const url = new URL(ref);
    if (url.hostname.length === 0) {
      return { ok: false, detail: "missing_host" };
    }
    return { ok: true, detail: null };
  } catch {
    return { ok: false, detail: "unparseable_url" };
  }
}

/**
 * Pure deterministic validation of a submission against its trusted task and
 * rubric. Both arguments must be loaded server-side by the caller (the
 * service never trusts client-supplied task/submission data).
 */
export function validateSubmissionContent(
  task: Task & { criteria: RubricCriteria[] },
  submission: Submission
): ValidationResult {
  const contentRef = submission.contentRef ?? "";
  const trimmed = contentRef.trim();

  // 1. Content presence (whitespace-only is empty).
  const presentCheck = check(
    "content_ref_present",
    "Submission content reference is present and non-empty",
    trimmed.length > 0,
    trimmed.length > 0 ? null : "content_ref_missing"
  );

  // 2. Content size bound.
  const sizeCheck = check(
    "content_ref_size",
    `Content reference length is within 1..${MAX_CONTENT_REF_LENGTH}`,
    contentRef.length >= 1 && contentRef.length <= MAX_CONTENT_REF_LENGTH,
    contentRef.length > MAX_CONTENT_REF_LENGTH ? "content_ref_too_long" : null
  );

  // 3 & 4. URI shape checks (allowed scheme + syntactic well-formedness).
  //
  // These two — and ONLY these two — are waived when the dev override is armed
  // (AI_AUTO_APPROVE=true, non-production, and not under the test runner), so a
  // demo worker can submit free prose as the contentRef. Checks 1, 2, 5, 6 and 7
  // (presence, size, assignee, deadline, rubric) stay fully enforced, and every
  // production and test run keeps the strict URI contract.
  const freeTextWaiver = isDevOverrideArmed();
  const waiverNote = freeTextWaiver
    ? " — WAIVED (AI_AUTO_APPROVE dev override)"
    : "";

  let scheme = "";
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) scheme = schemeMatch[1].toLowerCase();
  const schemeAllowed =
    freeTextWaiver || (ALLOWED_SCHEMES as readonly string[]).includes(scheme);
  const schemeCheck = check(
    "content_ref_scheme_allowed",
    "Content reference uses an allowed scheme (ipfs or https)" + waiverNote,
    schemeAllowed,
    schemeAllowed ? null : `scheme_not_allowed:${scheme || "none"}`
  );

  // 4. Syntactic well-formedness.
  const wellFormed = presentCheck.passed
    ? isWellFormedContentRef(trimmed)
    : { ok: false, detail: "content_ref_missing" };
  const wellFormedPassed = freeTextWaiver || wellFormed.ok;
  const wellFormedCheck = check(
    "content_ref_well_formed",
    "Content reference is syntactically well formed (no fetching)" + waiverNote,
    wellFormedPassed,
    wellFormedPassed ? null : wellFormed.detail
  );

  // 5. Consistency: the submission must come from the task's assigned worker.
  const submitterCheck = check(
    "submitter_is_assignee",
    "Submission was made by the task's assigned worker",
    task.assignee !== null && task.assignee === submission.submitter,
    task.assignee === submission.submitter ? null : "submitter_mismatch"
  );

  // 6. Consistency: the submission was made before the task deadline.
  const withinDeadline =
    task.deadline === null ||
    submission.createdAt.getTime() <= task.deadline.getTime();
  const deadlineCheck = check(
    "submitted_within_deadline",
    "Submission was made before the task deadline",
    withinDeadline,
    withinDeadline ? null : "submitted_after_deadline"
  );

  // 7. Rubric presence and shape (the review stage needs criteria to score).
  const rubricOk =
    task.criteria.length >= 1 &&
    task.criteria.every(
      (c) =>
        c.weight >= 1 &&
        c.weight <= 100 &&
        c.order >= 0 &&
        c.description.trim().length > 0
    );
  const rubricCheck = check(
    "rubric_present",
    "Task has a well-formed rubric (>= 1 criterion, weights 1..100)",
    rubricOk,
    rubricOk ? null : "rubric_missing_or_invalid"
  );

  const checks = [
    presentCheck,
    sizeCheck,
    schemeCheck,
    wellFormedCheck,
    submitterCheck,
    deadlineCheck,
    rubricCheck,
  ];
  const failureReasons = checks.filter((c) => !c.passed).map((c) => c.id);

  return {
    submissionId: submission.id,
    taskId: task.id,
    valid: failureReasons.length === 0,
    checks,
    failureReasons,
    // A reference is NEVER proof: content verification is deferred to review.
    contentProven: false,
    validatedAt: new Date().toISOString(),
  };
}