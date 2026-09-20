/**
 * CeloTasker — Single-use authentication challenges (in-memory, MVP).
 *
 * Nonces are cryptographically secure, single-use, bound to the requesting
 * wallet address and expire after ~5 minutes. Replay is prevented by
 * consuming the challenge on the first verification attempt. Swap for a
 * shared store before multi-instance deployment.
 */
import { randomBytes } from "node:crypto";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // ~5 minutes

interface Challenge {
  address: string;
  expiresAt: number;
  used: boolean;
}

const challenges = new Map<string, Challenge>();

function cleanup(): void {
  const now = Date.now();
  for (const [nonce, c] of challenges) {
    if (c.expiresAt <= now || c.used) challenges.delete(nonce);
  }
}

export interface ChallengeOptions {
  domain: string;
  uri: string;
}

export function createChallenge(address: string, origin?: AuthOrigin): {
  nonce: string;
  message: string;
  issuedAt: string;
  expirationTime: string;
  domain: string;
  uri: string;
} {
  cleanup();
  const nonce = randomBytes(16).toString("base64url");
  const issuedAt = new Date();
  const expiresAtMs = issuedAt.getTime() + CHALLENGE_TTL_MS;
  challenges.set(nonce, {
    address: address.toLowerCase(),
    expiresAt: expiresAtMs,
    used: false,
  });

  // Challenge origin: the route passes the request's resolved origin; the
  // env/config fallback chain applies when none is available.
  const resolved = origin ?? resolveAuthOrigin(null);

  // buildSiweMessage imported lazily to keep this module dependency-light.
  const message = buildChallengeMessage(address, nonce, issuedAt, expiresAtMs, resolved);
  return {
    nonce,
    message,
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(expiresAtMs).toISOString(),
    domain: resolved.domain,
    uri: resolved.uri,
  };
}

export type ChallengeCheckResult =
  | { ok: true; address: string }
  | { ok: false; reason: "not_found" | "expired" | "replayed" | "address_mismatch" };

/**
 * Atomically consume the challenge bound to `address`. The challenge is
 * marked used immediately on the first verification attempt, so a nonce can
 * never be replayed — even across failed signature attempts.
 */
export function consumeChallenge(
  nonce: string,
  address: string
): ChallengeCheckResult {
  const challenge = challenges.get(nonce);
  if (!challenge) return { ok: false, reason: "not_found" };

  if (challenge.used) return { ok: false, reason: "replayed" };
  if (challenge.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  if (challenge.address !== address.toLowerCase()) {
    return { ok: false, reason: "address_mismatch" };
  }

  challenge.used = true;
  return { ok: true, address: challenge.address };
}

/** Test helper: clear all pending challenges. Never call from requests. */
export function resetChallenges(): void {
  challenges.clear();
}

// Imported here (module bottom) to avoid circular imports in editors.
import {
  buildSiweMessage,
  resolveAuthOrigin,
  type AuthOrigin,
} from "./siwe.ts";

function buildChallengeMessage(
  address: string,
  nonce: string,
  issuedAt: Date,
  expiresAtMs: number,
  origin: AuthOrigin
): string {
  return buildSiweMessage({
    domain: origin.domain,
    address,
    uri: origin.uri,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(expiresAtMs).toISOString(),
  });
}
