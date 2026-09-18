import { createChallenge } from "@/lib/auth/challenge";
import { ChallengeRequestSchema } from "@/lib/validation/AuthSchemas";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";

/**
 * POST /api/auth/challenge — request a sign-in challenge.
 * Generates a secure single-use nonce bound to the wallet address and
 * returns the exact message the wallet must sign. No secrets returned.
 */
export async function POST(request: Request) {
  const limit = rateLimit(
    clientKeyFromRequest(request, "POST /api/auth/challenge"),
    { limit: 5, windowMs: 60_000 }
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

  const parsed = ChallengeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Signature/nonce material is never logged.
  const challenge = createChallenge(parsed.data.address);
  return Response.json(
    {
      message: challenge.message,
      nonce: challenge.nonce,
      domain: challenge.domain,
      uri: challenge.uri,
      issuedAt: challenge.issuedAt,
      expirationTime: challenge.expirationTime,
    },
    { status: 200 }
  );
}
