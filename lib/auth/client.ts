/**
 * CeloTasker — wallet authentication client (Step 1).
 *
 * SIWE-style flow against the REAL backend:
 *   1. POST /api/auth/challenge {address}          → server-built message
 *   2. wallet personal_sign(message)               → the ONE signature
 *   3. POST /api/auth/verify {message, signature}  → HttpOnly session cookie
 *
 * The client never touches session tokens (HttpOnly cookie, set by the
 * server) and never signs anything beyond the authentication message.
 */
import { apiFetch } from "../api/client";

export interface SessionInfo {
  address: string;
  expiresAt: string | null;
}

interface ChallengeResponse {
  message: string;
  nonce: string;
  domain: string;
  uri: string;
  issuedAt: string;
  expirationTime: string;
}

/** Ask the server for the exact message the wallet must sign. */
export async function fetchChallenge(address: string): Promise<string> {
  const data = await apiFetch<ChallengeResponse>("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  return data.message;
}

/** Verify the signature server-side; the success response sets the cookie. */
export async function verifySignature(
  message: string,
  signature: string
): Promise<string> {
  const data = await apiFetch<{ address: string }>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ message, signature }),
  });
  return data.address;
}

/** Full sign-in: challenge → sign → verify. Returns the verified address. */
export async function signInWithWallet(
  address: string,
  signMessage: (message: string) => Promise<string>
): Promise<string> {
  const message = await fetchChallenge(address);
  const signature = await signMessage(message);
  return verifySignature(message, signature);
}

/** Check the current session (null when signed out). */
export async function fetchSession(): Promise<SessionInfo | null> {
  try {
    return await apiFetch<SessionInfo>("/api/auth/session");
  } catch {
    return null;
  }
}

/** Invalidate the session server-side and clear the cookie. Idempotent. */
export async function signOut(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}