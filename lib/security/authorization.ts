/**
 * CeloTasker — Authorization choke point.
 *
 * Identity is established EXCLUSIVELY by a verified session (see
 * lib/auth/session.ts getAuthenticatedActor), which in turn is created only
 * after server-side verification of a wallet signature over a challenge the
 * server generated. Request-body wallet addresses are treated as untrusted
 * data at most — they can never establish identity or authorization.
 *
 * Wallet signature authentication is implemented with SIWE-style challenges
 * (lib/auth/*). No private keys or seed phrases are ever requested,
 * transmitted or stored.
 */
import { assertServerOnly } from "./SecurityPolicy.ts";
import { getAuthenticatedActor } from "../auth/session.ts";

export { getAuthenticatedActor };

export interface Actor {
  /** Verified session wallet address (lowercase); null when unauthenticated. */
  address: string | null;
  /** True only when a valid, unexpired server-side session exists. */
  authenticated: boolean;
  /** Opaque server-side session id (hash of the token); never exposed. */
  sessionId?: string;
}

export class UnauthorizedActorError extends Error {
  constructor() {
    super("Authenticated actor required");
    this.name = "UnauthorizedActorError";
  }
}

/**
 * Explicit authorization check for PRIVILEGED operations (settlement
 * requests, approvals, admin actions).
 */
export function requireAuthenticatedActor(actor: Actor): void {
  assertServerOnly();
  if (!actor.authenticated || !actor.address) {
    throw new UnauthorizedActorError();
  }
}
