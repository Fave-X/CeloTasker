import { getRelayerPublicConfig } from "@/lib/settlement/RelayerConfig";
import { rateLimit, clientKeyFromRequest } from "@/lib/security/rateLimit";

/**
 * GET /api/relayer — read-only PUBLIC relayer facts for the client
 * (Approve & Relay). Returns the spender address the requester must approve(),
 * the pinned Celo Mainnet chain id, and the whitelisted settlement token.
 * No secrets: the address is the public on-chain identity derived from the
 * server-side key; the key itself is never exposed. Fails safe with 503 when
 * the relayer is not configured — the client must never guess an address.
 */
export async function GET(request: Request) {
  const limit = rateLimit(clientKeyFromRequest(request, "GET /api/relayer"), {
    limit: 30,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const config = getRelayerPublicConfig();
  if (!config) {
    return Response.json(
      { error: "Settlement relayer is not configured" },
      { status: 503 }
    );
  }

  return Response.json(config, { status: 200 });
}