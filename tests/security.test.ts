import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  getAuthenticatedActor,
  requireAuthenticatedActor,
  UnauthorizedActorError,
} from "../lib/security/authorization.ts";
import { rateLimit, resetRateLimits } from "../lib/security/rateLimit.ts";
import { MAX_REVISION_ATTEMPTS } from "../lib/security/SecurityPolicy.ts";

test("MAX_REVISION_ATTEMPTS is the frozen value 2", () => {
  assert.equal(MAX_REVISION_ATTEMPTS, 2);
});

// ─── Authorization boundaries ────────────────────────────────

test("requests without a session are never authenticated", async () => {
  const request = new Request("http://localhost/api/test", { method: "POST" });
  const actor = await getAuthenticatedActor(request);
  assert.equal(actor.authenticated, false);
  assert.equal(actor.address, null);
});

test("forged/unknown session cookies are rejected", async () => {
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    headers: { cookie: "celo_tasker_session=forged-token-value" },
  });
  const actor = await getAuthenticatedActor(request);
  assert.equal(actor.authenticated, false);
});

test("privileged operations reject unauthenticated actors", () => {
  const actor = {
    address: null,
    authenticated: false,
  };
  assert.throws(() => requireAuthenticatedActor(actor), UnauthorizedActorError);
});

// ─── Rate limiting ───────────────────────────────────────────

beforeEach(() => resetRateLimits());

test("rate limiter allows up to the limit then rejects", () => {
  const opts = { limit: 3, windowMs: 60_000 };
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimit("test-key", opts).ok, true);
  }
  const blocked = rateLimit("test-key", opts);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterSeconds >= 1);
  // Independent keys are unaffected.
  assert.equal(rateLimit("other-key", opts).ok, true);
});

test("rate limiter fails open on internal errors", () => {
  const throwingKey = {
    toString() {
      throw new Error("boom");
    },
  } as unknown as string;
  const r = rateLimit(throwingKey, { limit: 1, windowMs: 1000 });
  assert.equal(r.ok, true); // fail-safe: allowed, never crashes the route
});

// ─── Secret exposure prevention (static scan) ────────────────

const SECRET_NAMES = [
  "AGENT_RELAYER_PRIVATE_KEY",
  "GEMINI_API_KEY",
  "BLOCKSCOUT_API_KEY",
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const here = import.meta.dirname ?? ".";
const clientCode = [
  ...walk(path.join(here, "../app")),
  ...walk(path.join(here, "../components")),
];

test("no NEXT_PUBLIC_ usage in any source module", () => {
  const libCode = walk(path.join(here, "../lib"));
  for (const file of [...clientCode, ...libCode]) {
    const content = readFileSync(file, "utf8");
    assert.equal(
      content.includes("NEXT_PUBLIC_"),
      false,
      `Forbidden NEXT_PUBLIC_ usage in ${file}`
    );
  }
});

test("secret env names never appear in client-reachable code", () => {
  for (const file of clientCode) {
    const content = readFileSync(file, "utf8");
    for (const secret of SECRET_NAMES) {
      assert.equal(
        content.includes(secret),
        false,
        `Secret name ${secret} referenced in ${file}`
      );
    }
  }
});

test(".env is gitignored and .env.example has placeholders only", () => {
  const gitignore = readFileSync(path.join(here, "../.gitignore"), "utf8");
  assert.match(gitignore, /^\.env$/m);

  const example = readFileSync(path.join(here, "../.env.example"), "utf8");
  for (const secret of SECRET_NAMES) {
    // .env.example may NAME the vars (placeholders) but must not contain
    // plausible real values (long hex private keys / Google-style API keys).
    const lines = example.split("\n").filter((l) => l.includes(secret));
    for (const line of lines) {
      assert.doesNotMatch(line, /["'=\s][0-9a-fA-F]{48,}["'\s]*$/);
      assert.doesNotMatch(line, /AIza[0-9A-Za-z_-]{30,}/);
    }
  }
});
