/**
 * CeloTasker — Wallet signature verification.
 *
 * Verifies the COMPLETE authentication message: structure, domain, URI,
 * version, chain ID, nonce, issuedAt, expirationTime — then recovers the
 * signer locally (EIP-191 personal_sign) and requires it to equal the
 * challenge-bound address. Signature recovery is local (no RPC).
 */
import { recoverMessageAddress } from "viem";
import {
  parseSiweMessage,
  MalformedMessageError,
  AUTH_CHAIN_ID,
  AUTH_VERSION,
  isConsistentAuthOrigin,
} from "./siwe.ts";
import { consumeChallenge } from "./challenge.ts";

export type VerifyFailureReason =
  | "malformed_message"
  | "wrong_domain"
  | "wrong_uri"
  | "wrong_version"
  | "wrong_chain_id"
  | "invalid_address"
  | "challenge_not_found"
  | "challenge_expired"
  | "nonce_replayed"
  | "challenge_address_mismatch"
  | "invalid_signature"
  | "signer_mismatch"
  | "expired_challenge_time"
  | "issued_at_invalid";

export type VerifyResult =
  | { ok: true; address: string }
  | { ok: false; reason: VerifyFailureReason };

const CLOCK_SKEW_MS = 60_000;

export async function verifySignedChallenge(
  message: string,
  signature: string
): Promise<VerifyResult> {
  // Safety net: guarantee this function NEVER throws to Next.js (which causes a 500).
  try {
    // 1. Full structural + field validation (never trust the raw message).
    let parsed;
    try {
      parsed = parseSiweMessage(message);
    } catch {
      // Catch MalformedMessageError AND any unexpected TypeError/RangeError from the parser
      return { ok: false, reason: "malformed_message" };
    }

    if (!parsed || !parsed.domain || !parsed.uri) {
      return { ok: false, reason: "wrong_domain" };
    }

    // 2. Application binding, validated from the signed message itself.
    let originConsistent = false;
    try {
      originConsistent = isConsistentAuthOrigin(parsed.domain, parsed.uri);
    } catch {
      // Catch any URL constructor errors from malformed URIs
      return { ok: false, reason: "wrong_domain" };
    }
    if (!originConsistent) return { ok: false, reason: "wrong_domain" };

    if (parsed.version !== AUTH_VERSION) return { ok: false, reason: "wrong_version" };
    if (parsed.chainId !== AUTH_CHAIN_ID) return { ok: false, reason: "wrong_chain_id" };

    if (!/^0x[0-9a-fA-F]{40}$/.test(parsed.address)) {
      return { ok: false, reason: "invalid_address" };
    }

    const issuedAt = new Date(parsed.issuedAt).getTime();
    const expiration = new Date(parsed.expirationTime).getTime();
    if (Number.isNaN(issuedAt) || issuedAt > Date.now() + CLOCK_SKEW_MS) {
      return { ok: false, reason: "issued_at_invalid" };
    }
    if (Number.isNaN(expiration) || expiration <= Date.now()) {
      return { ok: false, reason: "expired_challenge_time" };
    }

    // 3. Consume the single-use challenge (prevents replay, binds address).
    const challenge = consumeChallenge(parsed.nonce, parsed.address);
    if (!challenge.ok) {
      return { ok: false, reason: `challenge_${challenge.reason}` as VerifyFailureReason };
    }

    // 4. Local signature recovery (EIP-191). Reject malformed signatures.
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      return { ok: false, reason: "invalid_signature" };
    }
    if (!recovered || recovered.toLowerCase() !== parsed.address.toLowerCase()) {
      return { ok: false, reason: "signer_mismatch" };
    }

    return { ok: true, address: parsed.address.toLowerCase() };
  } catch (err) {
    // Absolute fallback: log it but never crash the serverless function.
    console.error("[verifySignedChallenge] Unexpected error:", err);
    return { ok: false, reason: "malformed_message" };
  }
}