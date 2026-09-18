import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../next.config.ts";

test("security headers are configured for all routes", async () => {
  assert.equal(typeof nextConfig.headers, "function");
  const entries = await nextConfig.headers!();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "/:path*");

  const headers = Object.fromEntries(
    entries[0].headers.map((h) => [h.key, h.value])
  );

  // CSP present and restrictive enough for the current app.
  const csp = headers["Content-Security-Policy"];
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("base-uri 'self'"));
  assert.ok(csp.includes("form-action 'self'"));
  // Production CSP must not include unsafe-eval (dev-only allowance).
  if (process.env.NODE_ENV === "production") {
    assert.ok(!csp.includes("unsafe-eval"));
  }

  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.ok(headers["Permissions-Policy"].includes("camera=()"));
  assert.ok(headers["Permissions-Policy"].includes("microphone=()"));
  assert.ok(headers["Permissions-Policy"].includes("geolocation=()"));
});
