import { verifySignedChallenge } from "@/lib/auth/verification";
import { createSession, buildSessionCookie, SESSION_TTL_MS } from "@/lib/auth/session";
import { VerifyRequestSchema } from "@/lib/validation/AuthSchemas";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";

/**
 * POST /api/auth/verify — verify the signed challenge and establish a session.
 *
 * The complete message is re-validated server-side (domain, URI, version,
 * chainId 42220, nonce single-use, issuedAt/expirationTime, signer recovery).
 * On success, sets an HttpOnly SameSite cookie. The session token itself is
 * never exposed to client scripts.
 */
export async function POST(request: Request) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/auth/verify"),
    { limit: 10, windowMs: 60_000 }
  );
  if (!limit.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = VerifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await verifySignedChallenge(parsed.data.message, parsed.data.signature);
  if (!result.ok) {
    // Do not leak which specific check failed to unauthenticated callers.
    return Response.json({ error: "Authentication failed" }, { status: 401 });
  }

  const session = await createSession(result.address);
  return Response.json(
    { address: result.address },
    {
      status: 200,
      headers: {
        "Set-Cookie": buildSessionCookie(session.token, {
          maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        }),
      },
    }
  );
}
