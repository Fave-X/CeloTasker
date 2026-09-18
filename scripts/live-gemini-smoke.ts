/**
 * CeloTasker — LIVE Gemini smoke test (manual, opt-in).
 *
 * NOT part of `npm test`: the automated suite must stay fully OFFLINE and must
 * never need a real API key. This script exists so a human can verify on demand
 * that the configured provider really reaches Google and that a live model
 * response satisfies the strict `ModelEvaluationSchema`.
 *
 * Usage:
 *   npm run smoke:gemini
 *   node --env-file=.env scripts/live-gemini-smoke.ts
 *
 * Safety properties:
 * - READ-ONLY: it calls the provider directly. It never touches the database,
 *   the workflow services, settlement, or the blockchain, and it makes exactly
 *   ONE live request. Nothing is authorized, recorded or applied.
 * - It NEVER prints the API key: only presence/length, and every diagnostic
 *   string is passed through a redactor that replaces the key with
 *   "[redacted]" as defence in depth.
 */
import {
  GeminiEvaluatorProvider,
  GeminiProviderError,
  resolveGeminiConfig,
} from "../lib/evaluation/GeminiEvaluator.ts";
import { ModelEvaluationSchema } from "../lib/evaluation/EvaluationSchemas.ts";
import type { EvaluationInput } from "../lib/evaluation/EvaluatorProvider.ts";

/** Safe synthetic fixture: no real task, no addresses, no money, no PII. */
const input: EvaluationInput = {
  taskId: "smoke-task",
  submissionId: "smoke-submission",
  taskTitle: "Write a one-sentence friendly greeting for the Celo community",
  taskDescription:
    "Produce exactly one short, friendly English sentence greeting the Celo community. Do not add extra paragraphs.",
  criteria: [
    {
      id: "c1",
      description: "The submission is exactly one sentence",
      weight: 5,
      order: 0,
    },
    {
      id: "c2",
      description: "The sentence is a friendly greeting that references Celo",
      weight: 5,
      order: 1,
    },
  ],
  contentRef: "ipfs://QmSmokeTestOnlyOpaqueReferenceNeverFetched",
};

const SECRET = (process.env.GEMINI_API_KEY ?? "").trim();

/** Clip + redact: no secret may ever reach stdout, even on an unexpected error. */
function scrub(text: string): string {
  const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  return SECRET ? clipped.split(SECRET).join("[redacted]") : clipped;
}

function describeError(err: unknown): string {
  const e = err as {
    name?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const parts = [`name=${typeof e?.name === "string" ? e.name : "unknown"}`];
  if (typeof e?.cause?.code === "string") parts.push(`causeCode=${e.cause.code}`);
  if (typeof e?.cause?.message === "string") parts.push(`cause=${scrub(e.cause.message)}`);
  if (typeof e?.message === "string") parts.push(`message=${scrub(e.message)}`);
  return parts.join(" ");
}

function log(line: string): void {
  console.log(`[smoke] ${line}`);
}

async function main(): Promise<number> {
  const config = resolveGeminiConfig();
  log(
    `key_present=${config !== null}${config ? ` key_len=${config.apiKey.trim().length}` : ""}`
  );
  if (!config) {
    log(
      "RESULT: FAIL — GEMINI_API_KEY is not configured; review fails safe (503 evaluation_unavailable)."
    );
    return 1;
  }
  log(
    `model=${config.model} timeout_ms=${config.timeoutMs} max_response_bytes=${config.maxResponseBytes}`
  );

  const provider = new GeminiEvaluatorProvider(config);
  log(`provider_id=${provider.providerId} model_id=${provider.modelId}`);

  const startedAt = Date.now();
  let raw: unknown;
  try {
    raw = await provider.evaluate(input);
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    if (err instanceof GeminiProviderError) {
      log(`live_request=failed elapsed_ms=${elapsed} provider_error_reason=${err.reason}`);
    } else {
      log(`live_request=failed elapsed_ms=${elapsed} unexpected_error ${describeError(err)}`);
    }
    log("RESULT: FAIL — no state was touched and no evaluation was recorded.");
    return 1;
  }
  log(`live_request=ok elapsed_ms=${Date.now() - startedAt}`);

  const parsed = ModelEvaluationSchema.safeParse(raw);
  log(`schema_valid=${parsed.success}`);
  if (!parsed.success) {
    log(
      `schema_issues=${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}:${i.code}`)
        .join(",")}`
    );
    log(`raw_top_level_keys=${Object.keys((raw ?? {}) as Record<string, unknown>).join(",") || "<none>"}`);
    log(
      "RESULT: FAIL — the live response is not schema-valid; the review layer would reject it as malformed_model_output."
    );
    return 1;
  }

  const evaluation = parsed.data;
  log(`decision=${evaluation.decision} criterion_results=${evaluation.criterionResults.length}`);
  log(`criterion_ids=${evaluation.criterionResults.map((r) => r.criterionId).join(",")}`);
  log(
    `criterion_satisfied=${evaluation.criterionResults
      .map((r) => `${r.criterionId}:${r.satisfied}`)
      .join(",")}`
  );
  log(`overall_feedback_chars=${evaluation.overallFeedback.length}`);
  log(
    "RESULT: PASS — live Gemini is reachable and the response satisfies ModelEvaluationSchema (advisory only)."
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`unexpected_error ${describeError(err)}`);
    process.exit(1);
  });