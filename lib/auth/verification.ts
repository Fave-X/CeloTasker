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
  // 1. Full structural + field validation (never trust the raw message).
  let parsed;
  try {
    parsed = parseSiweMessage(message);
  } catch (err) {
    if (err instanceof MalformedMessageError) {
      return { ok: false, reason: "malformed_message" };
    }
    throw err;
  }

  // 2. Application binding, validated from the signed message itself: the URI
  //    must be an absolute http(s) URL whose host equals the claimed domain.
  //    There is deliberately no hardcoded deployment domain here — the
  //    challenge carries the origin it was issued for, and identity remains
  //    bound by the single-use nonce and signer recovery below.
  if (!isConsistentAuthOrigin(parsed.domain, parsed.uri)) {
    return { ok: false, reason: "wrong_domain" };
  }
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
  if (expiration <= Date.now()) {
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
}
