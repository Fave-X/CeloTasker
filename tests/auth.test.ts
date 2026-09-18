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
import {
  createSession,
  getAuthenticatedActor,
  destroySession,
  validateSession,
  buildSessionCookie,
  buildClearedSessionCookie,
  readSessionToken,
  SESSION_COOKIE,
} from "../lib/auth/session.ts";
import { prisma } from "../lib/prisma.ts";

beforeEach(() => resetChallenges());

const WALLET = privateKeyToAccount(
  `0x${randomBytes(32).toString("hex")}` as `0x${string}`
);
const OTHER_WALLET = privateKeyToAccount(
  `0x${randomBytes(32).toString("hex")}` as `0x${string}`
);

async function signChallenge(wallet = WALLET) {
  const challenge = createChallenge(wallet.address);
  const signature = await wallet.signMessage({ message: challenge.message });
  return { challenge, signature };
}

test("valid wallet signature authenticates the address", async () => {
  const { challenge, signature } = await signChallenge();
  const result = await verifySignedChallenge(challenge.message, signature);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.address, WALLET.address.toLowerCase());
  }
});

test("invalid signature is rejected", async () => {
  const { challenge } = await signChallenge();
  const badSignature = "0x" + "0".repeat(64) + "1".repeat(64) + "1b";
  const result = await verifySignedChallenge(challenge.message, badSignature);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(["invalid_signature", "signer_mismatch"].includes(result.reason));
  }
});

test("wrong wallet signing the challenge is rejected", async () => {
  const challenge = createChallenge(WALLET.address);
  const signature = await OTHER_WALLET.signMessage({ message: challenge.message });
  const result = await verifySignedChallenge(challenge.message, signature);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "signer_mismatch");
});

test("expired challenge is rejected", async () => {
  const challenge = createChallenge(WALLET.address);
  const altered = challenge.message.replace(
    /Expiration Time: .*/,
    `Expiration Time: ${new Date(Date.now() - 1000).toISOString()}`
  );
  const signature = await WALLET.signMessage({ message: altered });
  const result = await verifySignedChallenge(altered, signature);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired_challenge_time");
});

test("nonce replay is rejected", async () => {
  const { challenge, signature } = await signChallenge();
  const first = await verifySignedChallenge(challenge.message, signature);
  assert.equal(first.ok, true);
  const second = await verifySignedChallenge(challenge.message, signature);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "challenge_replayed");
});

test("wrong chain ID is rejected", async () => {
  const challenge = createChallenge(WALLET.address);
  const altered = challenge.message.replace("Chain ID: 42220", "Chain ID: 84532");
  const signature = await WALLET.signMessage({ message: altered });
  const result = await verifySignedChallenge(altered, signature);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "wrong_chain_id");
});
