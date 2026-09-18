/**
 * CeloTasker — Security Policy (Stage 1A)
 *
 * Central, server-only source of truth for security constants.
 * DO NOT import this module from client components ("use client") —
 * it references secret material names and policy constants that must
 * never reach the browser bundle.
 */

/** Chain ID for Celo mainnet (42220) and Alfajores testnet (44787). */
export const CHAIN_IDS = {
  CELO_MAINNET: 42220,
  ALFAJORES: 44787,
} as const;

/** Approved token contracts (addresses, lowercase) that settlements may use. */
export const SETTLEMENT_TOKEN_WHITELIST: Record<string, readonly string[]> = {
  [CHAIN_IDS.CELO_MAINNET]: [
    // cUSD
    "0x765de816845861e75a25fca122bb6898b8b1282a",
  ],
  [CHAIN_IDS.ALFAJORES]: [
    // cUSD on Alfajores
    "0x874069fa1eb16d44d622f2e0ca254a81a1e0c679",
  ],
} as const;

/**
 * Minimum and maximum settlement amounts in WHOLE TOKEN units (Stage 5C
 * convention: task rewardAmount is a whole-token decimal-integer string,
 * converted to base units via the token's on-chain decimals at execution).
 *
 * MIN_AMOUNT "1" strictly rejects zero-value settlements — a "paid" task with
 * no transfer can never complete the lifecycle.
 * MAX_AMOUNT "1000" caps the reward at 1000 whole tokens per task.
 *
 * Exact integer semantics only (BigInt comparisons); no floating point, no
 * rounding.
 */
export const SETTLEMENT_LIMITS = {
  MIN_AMOUNT: "1",
  MAX_AMOUNT: "1000",
} as const;

/** Timeout windows (ms) used by workflow and relayer logic in later stages. */
export const TIMEOUTS = {
  RELAYER_TX_TIMEOUT_MS: 60_000,
  EVALUATION_TIMEOUT_MS: 120_000,
} as const;

/** Maximum revision rounds allowed per task before it can no longer be revised. */
export const MAX_REVISION_ATTEMPTS = 2 as const;

/**
 * File-upload policy (metadata validation only — no upload/storage system yet).
 * Used by lib/validation/FileValidation.ts and later by the submission system.
 */
export const UPLOAD_POLICY = {
  /** 10 MiB hard cap per file. */
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  /** Whitelisted MIME types. Anything not listed is rejected. */
  ALLOWED_MIME_TYPES: [
    "image/png",
    "image/jpeg",
    "application/pdf",
    "text/plain",
    "application/zip",
  ] as const,
  /** Whitelisted extensions (lowercase, with dot). */
  ALLOWED_EXTENSIONS: [".png", ".jpg", ".jpeg", ".pdf", ".txt", ".zip"] as const,
  /** Always-rejected extensions regardless of claimed MIME type. */
  BLOCKED_EXTENSIONS: [
    ".exe",
    ".bat",
    ".cmd",
    ".sh",
    ".ps1",
    ".js",
    ".mjs",
    ".html",
    ".htm",
    ".svg", // SVG can host scripts — excluded to prevent stored XSS
    ".php",
  ] as const,
  /** Maximum filename length. */
  MAX_FILENAME_LENGTH: 255,
} as const;

/**
 * Environment variable names that are strictly server-only.
 * Never mark these with any public/exposed env prefix; never inline their
 * values into client components.
 */
export const SERVER_ONLY_ENV = [
  "AGENT_RELAYER_PRIVATE_KEY",
  "GEMINI_API_KEY",
  "BLOCKSCOUT_API_KEY",
  "CELO_RPC_URL",
  "DATABASE_URL",
  "ATTRIBUTION_TAG",
] as const;

/**
 * Runtime guard: throws if called from a client bundle.
 * Import only from server-side modules (route handlers, server actions, lib).
 */
export function assertServerOnly(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "SecurityPolicy must not be imported into client code. " +
        "This module is server-only."
    );
  }
}
