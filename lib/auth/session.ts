/**
 * CeloTasker — Server-side sessions.
 *
 * - Session tokens are 256-bit cryptographically random values delivered
 *   ONLY in an HttpOnly cookie. The database stores SHA-256(token), never
 *   the token itself.
 * - Sessions expire (7 days) and are validated server-side on every request.
 * - Logout deletes the stored hash, irreversibly invalidating the token.
 * - No signatures, tokens or session data are ever logged.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../prisma.ts";
import type { Actor } from "../security/authorization.ts";

export const SESSION_COOKIE = "celo_tasker_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

/** Create a session for an authenticated address. */
export async function createSession(address: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      id: hashToken(token),
      address: address.toLowerCase(),
      expiresAt,
    },
  });
  return { token, expiresAt };
}

/** Read the session token from a request's Cookie header. */
export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return part.slice(idx + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Validate a token against the store. Returns the session row or null.
 * Expired sessions are treated as absent (and lazily deleted).
 */
export async function validateSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session;
}

/**
 * THE authorization choke point. Identity comes exclusively from the
 * verified session cookie — NEVER from request-body wallet addresses.
 */
export async function getAuthenticatedActor(request: Request): Promise<Actor> {
  const token = readSessionToken(request);
  if (!token) return { address: null, authenticated: false };
  const session = await validateSession(token);
  if (!session) return { address: null, authenticated: false };
  return { address: session.address, authenticated: true, sessionId: session.id };
}

/** Invalidate a session by token (logout). Idempotent. */
export async function destroySession(token: string): Promise<void> {
  await prisma.session
    .delete({ where: { id: hashToken(token) } })
    .catch(() => {});
}

// ─── Cookie construction (plain Set-Cookie — no framework coupling) ───

export interface CookieOptions {
  maxAgeSeconds: number;
}

export function buildSessionCookie(token: string, opts: CookieOptions): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` +
    `${secure}; Max-Age=${opts.maxAgeSeconds}`
  );
}

export function buildClearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

/** Constant-time comparison helper exposed for tests. */
export { safeEqual };
