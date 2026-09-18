import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  createChallenge,
  consumeChallenge,
  resetChallenges,
} from "../lib/auth/challenge.ts";
import { verifySignedChallenge } from "../lib/auth/verification.ts";

beforeEach(() => resetChallenges());

const WALLET = privateKeyToAccount(
  `0x${randomBytes(32).toString("hex")}` as `0x${string}`
);
const OTHER_WALLET = privateKeyToAccount(
  `0x${randomBytes(32).toString("hex")}` as `0x${string}`
);

test("altered domain and URI are rejected", async () => {
  const cases: [RegExp, string][] = [
    [/^.* wants you to sign in/, "evil.example.com wants you to sign in"],
    [/URI: .*/, "URI: https://evil.example.com"],
  ];
  for (const [from, to] of cases) {
    resetChallenges();
    const challenge = createChallenge(WALLET.address);
    const altered = challenge.message.replace(from, to);
    const signature = await WALLET.signMessage({ message: altered });
    const result = await verifySignedChallenge(altered, signature);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        ["wrong_domain", "wrong_uri", "malformed_message"].includes(result.reason),
        `unexpected reason ${result.reason}`
      );
    }
  }
});

test("missing or altered authentication fields are rejected", async () => {
  const challenge = createChallenge(WALLET.address);
  const signature = await WALLET.signMessage({ message: challenge.message });

  const noVersion = challenge.message
    .split("\n")
    .filter((l) => !l.startsWith("Version:"))
    .join("\n");
  assert.equal((await verifySignedChallenge(noVersion, signature)).ok, false);

  const noNonce = challenge.message
    .split("\n")
    .filter((l) => !l.startsWith("Nonce:"))
    .join("\n");
  assert.equal((await verifySignedChallenge(noNonce, signature)).ok, false);

  const altStatement = challenge.message.replace(
    "Sign in to CeloTasker.",
    "Sign in to EvilTasker."
  );
  assert.equal((await verifySignedChallenge(altStatement, signature)).ok, false);

  assert.equal((await verifySignedChallenge("hello world", signature)).ok, false);
});

test("challenge is bound to the intended wallet address", () => {
  const challenge = createChallenge(WALLET.address);
  const check = consumeChallenge(challenge.nonce, OTHER_WALLET.address);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.reason, "address_mismatch");
});

// body-address tampering: identity must come from session, not request body
test("body wallet addresses can never establish identity", async () => {
  const { getAuthenticatedActor } = await import(
    "../lib/security/authorization.ts"
  );
  // A request whose BODY claims a wallet address but has no session cookie:
  // actor must be unauthenticated regardless of the body.
  const request = new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creator: WALLET.address, title: "x" }),
  });
  const actor = await getAuthenticatedActor(request);
  assert.equal(actor.authenticated, false);
  assert.equal(actor.address, null);
});
