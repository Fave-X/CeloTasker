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

test("challenge origin comes from the request and the signed message stays self-consistent", async () => {
  resetChallenges();
  const localhost = { domain: "localhost:3000", uri: "http://localhost:3000" };
  const challenge = createChallenge(WALLET.address, localhost);
  assert.ok(
    challenge.message.startsWith("localhost:3000 wants you to sign in"),
    `unexpected domain in message: ${challenge.message.split("\n")[0]}`
  );
  assert.ok(challenge.message.includes("URI: http://localhost:3000"));
  assert.equal(challenge.domain, "localhost:3000");

  // A challenge issued for the request's own origin verifies end-to-end.
  const signature = await WALLET.signMessage({ message: challenge.message });
  assert.equal((await verifySignedChallenge(challenge.message, signature)).ok, true);

  // A signed message whose URI host disagrees with its claimed domain is
  // rejected — verification reads the binding from the message itself.
  const swapped = challenge.message.replace(
    "URI: http://localhost:3000",
    "URI: http://evil.example.com"
  );
  const badSignature = await WALLET.signMessage({ message: swapped });
  const bad = await verifySignedChallenge(swapped, badSignature);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(
      ["wrong_domain", "wrong_uri", "malformed_message"].includes(bad.reason),
      `unexpected reason ${bad.reason}`
    );
  }
});
