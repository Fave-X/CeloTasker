import { getAuthenticatedActor } from "@/lib/security/authorization";
import {
  readSessionToken,
  destroySession,
  buildClearedSessionCookie,
} from "@/lib/auth/session";

/**
 * POST /api/auth/logout — invalidate the current session server-side and
 * clear the cookie. Idempotent: safe to call when already logged out.
 */
export async function POST(request: Request) {
  const actor = await getAuthenticatedActor(request);
  if (actor.authenticated) {
    const token = readSessionToken(request);
    if (token) await destroySession(token);
  }
  return Response.json(
    { ok: true },
    { status: 200, headers: { "Set-Cookie": buildClearedSessionCookie() } }
  );
}
