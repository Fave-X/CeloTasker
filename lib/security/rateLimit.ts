/**
 * CeloTasker — In-memory fixed-window rate limiter (hackathon MVP).
 *
 * Design constraints:
 * - No external service (no Redis). Per-process memory only; acceptable for
 *   a single-instance MVP. Swap for a shared store before multi-instance deploys.
 * - Fails SAFE for availability: on any internal error the request is allowed
 *   and the error is logged. Rate limiting is a mitigation, not a correctness
 *   control — we never break the app because the limiter breaks.
 * - Keys are caller-supplied (typically IP + route). Not for login limiting
 *   (wallet auth not implemented yet).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number };

export function rateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  try {
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + options.windowMs,
      });
      return { ok: true, remaining: options.limit - 1 };
    }

    if (bucket.count >= options.limit) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return { ok: true, remaining: options.limit - bucket.count };
  } catch (err) {
    // Fail safe: allow the request, never crash the route.
    console.error("rateLimit internal error (failing open):", err);
    return { ok: true, remaining: -1 };
  }
}

/** Extract a best-effort client key from request headers (pre-auth MVP). */
export function clientKeyFromRequest(request: Request, route: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `${route}:${ip}`;
}

/** Test helper: clear all buckets. Never call from request paths. */
export function resetRateLimits(): void {
  buckets.clear();
}
