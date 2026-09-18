/**
 * CeloTasker — Gemini evaluator provider (Stage 6 / M-3).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → HUMAN CONFIRMATION MUST AUTHORIZE REAL-MONEY RELEASE → BLOCKCHAIN MUST
 * CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * This module implements the EXISTING `EvaluatorProvider` interface. It:
 * - reads the API key ONLY from server environment via the env choke point
 *   (`requireServerEnv` / `optionalServerEnv`), never from a request body,
 *   never from a client-reachable module, and never logs it;
 * - sends the key in the `x-goog-api-key` HEADER (never in a URL, so it can
 *   never land in a proxy/access log);
 * - calls a FIXED, hardcoded Google endpoint. The submission `contentRef` is
 *   passed to the model as an OPAQUE identifier and is NEVER fetched — there
 *   is no attacker-controlled URL anywhere in this module (no SSRF surface);
 * - bounds the request payload and the response body size;
 * - applies a provider-level timeout via AbortController (independent of, and
 *   shorter than, ReviewService's authoritative evaluation timeout);
 * - returns RAW model output only. Parsing/authorization stays in the
 *   deterministic review layer (strict Zod schema). There is NO fallback to a
 *   weaker or synthesized evaluation: any failure throws a secret-free error.
 */
import { optionalServerEnv, requireServerEnv } from "../security/env.ts";
import type { EvaluationInput, EvaluatorProvider } from "./EvaluatorProvider.ts";

/** FIXED upstream endpoint. Never derived from input or configuration. */
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Default model. Overridable server-side via GEMINI_MODEL.
 *
 * Live-compatibility note: `gemini-2.0-flash` is retired and `gemini-2.5-flash`
 * is closed to new users — both make `generateContent` fail closed with
 * `http_404`. `gemini-3.6-flash` is the GA model Google's own 404 message
 * recommends; it is listed by ListModels on both v1beta and v1 and returns
 * schema-valid JSON. Verified live via `npm run smoke:gemini`.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/** Provider timeout default (ms). Must stay below EVALUATION_TIMEOUT_MS. */
export const DEFAULT_GEMINI_TIMEOUT_MS = 60_000;

/** Hard response-body cap (bytes) default. */
export const DEFAULT_GEMINI_MAX_RESPONSE_BYTES = 256_000;

/** Model identifiers are a restricted charset — no path/URL injection. */
const MODEL_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Input truncation bounds: keep the prompt small and predictable. */
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_CRITERION_CHARS = 500;
const MAX_CONTENT_REF_CHARS = 300;
const MAX_OUTPUT_TOKENS = 4_096;

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  if (!/^[0-9]+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Resolve the server-side Gemini configuration. Returns null when no API key
 * is configured, so the review layer fails SAFE (`evaluation_unavailable`).
 * Invalid model/timeout/size values fall back to safe defaults; the API key
 * itself is required and is never returned in any error message.
 */
export function resolveGeminiConfig(): GeminiConfig | null {
  let apiKey: string;
  try {
    apiKey = optionalServerEnv("GEMINI_API_KEY");
  } catch {
    return null;
  }
  if (!apiKey || apiKey.trim() === "") return null;

  const requestedModel = optionalServerEnv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).trim();
  const model = MODEL_SHAPE.test(requestedModel) ? requestedModel : DEFAULT_GEMINI_MODEL;

  return {
    apiKey,
    model,
    timeoutMs: clampInt(
      optionalServerEnv("GEMINI_TIMEOUT_MS", String(DEFAULT_GEMINI_TIMEOUT_MS)),
      DEFAULT_GEMINI_TIMEOUT_MS,
      1_000,
      110_000
    ),
    maxResponseBytes: clampInt(
      optionalServerEnv(
        "GEMINI_MAX_RESPONSE_BYTES",
        String(DEFAULT_GEMINI_MAX_RESPONSE_BYTES)
      ),
      DEFAULT_GEMINI_MAX_RESPONSE_BYTES,
      1_000,
      4_000_000
    ),
  };
}

/** Secret-free provider error. The reason is a fixed token, never a payload. */
export class GeminiProviderError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Gemini evaluator error: ${reason}`);
    this.name = "GeminiProviderError";
    this.reason = reason;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Build the evaluation prompt from TRUSTED server-side data only.
 * Deliberately excludes: wallet addresses, reward amounts, tokens, settlement
 * data, session data, API keys, private keys — none of it is needed to judge
 * the work against the rubric.
 */
export function buildEvaluationPrompt(input: EvaluationInput): string {
  const criteria = input.criteria
    .map(
      (c, i) =>
        `${i + 1}. id=${c.id} weight=${c.weight} — ${truncate(c.description, MAX_CRITERION_CHARS)}`
    )
    .join("\n");

  return [
    "You are evaluating a completed microtask against its rubric.",
    "Respond with ONLY a single JSON object. No prose, no markdown fences.",
    "",
    "The JSON object MUST have exactly this shape:",
    '{ "decision": "APPROVE" | "REQUEST_REVISION" | "REJECT",',
    '  "criterionResults": [ { "criterionId": string, "satisfied": boolean,',
    '                          "score": number (0-100, optional),',
    '                          "reasoning": string } ],',
    '  "overallFeedback": string,',
    '  "extractedData": object (optional) }',
    "",
    "Rules:",
    "- Include exactly one criterionResults entry per rubric criterion below,",
    "  using the given id verbatim. Never invent criterion ids.",
    "- You cannot browse and must not request any URL. The submission is",
    "  identified by an OPAQUE reference only. If the available information is",
    "  insufficient to confirm a criterion, mark it satisfied=false.",
    "- Your output is ADVISORY. Deterministic server code and a human reviewer",
    "  make the authoritative decision; never claim to authorize payment.",
    "",
    `Task title: ${truncate(input.taskTitle, MAX_TITLE_CHARS)}`,
    `Task description: ${truncate(input.taskDescription, MAX_DESCRIPTION_CHARS)}`,
    "",
    "Rubric criteria:",
    criteria,
    "",
    `Submission reference (opaque, do not fetch): ${truncate(input.contentRef, MAX_CONTENT_REF_CHARS)}`,
  ].join("\n");
}

/** Read a response body with a hard byte cap (never unbounded). */
async function readBodyBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > maxBytes) throw new GeminiProviderError("response_too_large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GeminiProviderError("response_too_large");
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Extract the model's text from a Gemini generateContent response.
 * Strict and structural — never guesses, never synthesizes a fallback.
 */
export function extractGeminiText(payload: unknown): string {
  const root = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    promptFeedback?: { blockReason?: unknown };
  } | null;

  const parts = root?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new GeminiProviderError(
      root?.promptFeedback?.blockReason ? "prompt_blocked" : "empty_response"
    );
  }
  const text = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (text.length === 0) throw new GeminiProviderError("empty_response");
  return text;
}

/** Strip a surrounding ```json fence if the model added one (bounded, safe). */
function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

/** Real Gemini-backed evaluator. Returns RAW output for strict Zod parsing. */
export class GeminiEvaluatorProvider implements EvaluatorProvider {
  readonly providerId = "gemini";
  readonly modelId: string;

  private readonly config: GeminiConfig;

  constructor(config: GeminiConfig) {
    this.config = config;
    this.modelId = config.model;
  }

  async evaluate(input: EvaluationInput): Promise<unknown> {
    // The key is read from server env at call time and used ONLY in a header.
    const apiKey = requireServerEnv("GEMINI_API_KEY");
    const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(
      this.config.model
    )}:generateContent`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          // Header-based auth: the key never appears in the URL.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildEvaluationPrompt(input) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }),
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || controller.signal.aborted) {
        throw new GeminiProviderError("timeout");
      }
      // Never propagate the underlying message: it can contain URL/headers.
      throw new GeminiProviderError("network_error");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Status only — the error body may echo request details.
      throw new GeminiProviderError(`http_${res.status}`);
    }

    const body = await readBodyBounded(res, this.config.maxResponseBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new GeminiProviderError("invalid_transport_json");
    }

    const text = extractGeminiText(payload);
    try {
      // RAW model output. The deterministic layer validates it with the strict
      // ModelEvaluationSchema; malformed output fails closed there.
      return JSON.parse(stripCodeFence(text));
    } catch {
      throw new GeminiProviderError("invalid_model_json");
    }
  }
}

/**
 * Build the configured provider, or null when the API key is absent so the
 * review layer fails safe with `evaluation_unavailable` (503).
 */
export function createGeminiEvaluatorProvider(): GeminiEvaluatorProvider | null {
  const config = resolveGeminiConfig();
  return config ? new GeminiEvaluatorProvider(config) : null;
}