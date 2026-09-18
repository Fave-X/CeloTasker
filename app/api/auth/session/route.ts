import { getAuthenticatedActor } from "@/lib/security/authorization";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";

/**
 * GET /api/auth/session — check the current session.
 * Returns the verified wallet address only; never tokens or secrets.
 */
export async function GET(request: Request) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "GET /api/auth/session"),
    { limit: 30, windowMs: 60_000 }
  );
  if (!limit.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const actor = await getAuthenticatedActor(request);
  if (!actor.authenticated || !actor.address) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const expiresAt = actor.sessionId
    ? (await prisma.session.findUnique({ where: { id: actor.sessionId } }))
        ?.expiresAt ?? null
    : null;

  return Response.json(
    { address: actor.address, expiresAt },
    { status: 200 }
  );
}
