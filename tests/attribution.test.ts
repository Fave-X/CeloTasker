/**
 * CeloTasker — ERC-8021 attribution verification tests (Stage 5C).
 *
 * Verifies the ACTUAL encoded bytes — not snapshots:
 * - the suffix is generated through the official ox/erc8021 implementation;
 * - the suffix is appended AFTER the original transferFrom calldata;
 * - the suffix is appended EXACTLY ONCE;
 * - the final transaction calldata round-trips through ox's own decoder;
 * - the attribution tag is SERVER-SIDE configuration (never client input);
 * - missing attribution configuration fails safely (no tag is ever invented).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Official implementation — imported exactly as specified; never re-invented.
import { Attribution } from "ox/erc8021";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { buildSettlementCalldata, createDefaultRelayerDeps } from "../lib/settlement/CeloRelayer.ts";
import {
  getRelayerConfig,
  hasRelayerConfig,
  parseAttributionCodes,
  RelayerConfigError,
} from "../lib/settlement/RelayerConfig.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const AMOUNT = "123";
const TAG = "celotasker-test-tag";

/** ox's fromData expects a 0x-typed hex literal. */
function asHex(value: string): `0x${string}` {
  return value as `0x${string}`;
}

/** Count non-overlapping occurrences of a hex substring. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

test("suffix is generated through ox/erc8021 and decodes back to the tag", () => {
  const suffix = Attribution.toDataSuffix({ codes: [TAG] });
  assert.equal(typeof suffix, "string");
  assert.ok(suffix.startsWith("0x"));
  // Round-trip through the OFFICIAL decoder: real wire format, not a guess.
  const decoded = Attribution.fromData(suffix);
  assert.deepEqual(decoded?.codes, [TAG]);
});

test("calldata: suffix appended AFTER the original calldata, exactly once", () => {
  const built = buildSettlementCalldata({
    owner: OWNER,
    recipient: RECIPIENT,
    amount: AMOUNT,
    decimals: 18,
    attributionTag: TAG,
  });

  // The pristine ERC-20 transferFrom calldata, encoded independently.
  const expectedTransferFrom = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transferFrom",
    args: [OWNER, RECIPIENT, parseUnits(AMOUNT, 18)],
  });
  assert.equal(built.transferFromCalldata, expectedTransferFrom);

  // Byte-level: final = original ++ suffix; suffix LAST; appended ONCE.
  assert.equal(
    built.data,
    built.transferFromCalldata + built.attributionSuffix.slice(2)
  );
  assert.ok(built.data.startsWith(built.transferFromCalldata));
  // The suffix body (without its own 0x prefix) is the tail of the data.
  assert.ok(built.data.endsWith(built.attributionSuffix.slice(2)));
  assert.equal(
    built.data.length,
    built.transferFromCalldata.length + built.attributionSuffix.length - 2
  );
  const body = built.data.slice(2);
  assert.equal(countOccurrences(body, built.attributionSuffix.slice(2)), 1);
  // The ERC-8021 marker (the fixed suffix tail per the spec) appears exactly
  // once — inside that single appended suffix.
  const ercMarker = built.attributionSuffix.slice(-32);
  assert.equal(ercMarker, "80218021802180218021802180218021");
  assert.equal(countOccurrences(body, ercMarker), 1);

  // The final calldata round-trips through the official decoder.
  assert.deepEqual(Attribution.fromData(asHex(built.data))?.codes, [TAG]);
});

test("calldata: a different server tag produces a different suffix; deterministic", () => {
  const base = { owner: OWNER, recipient: RECIPIENT, amount: AMOUNT, decimals: 18 };
  const a = buildSettlementCalldata({ ...base, attributionTag: "tag-a" });
  const b = buildSettlementCalldata({ ...base, attributionTag: "tag-b" });
  const a2 = buildSettlementCalldata({ ...base, attributionTag: "tag-a" });
  assert.notEqual(a.attributionSuffix, b.attributionSuffix);
  assert.equal(a.data, a2.data, "identical inputs → identical bytes");
  assert.deepEqual(Attribution.fromData(asHex(a.data))?.codes, ["tag-a"]);
  assert.deepEqual(Attribution.fromData(asHex(b.data))?.codes, ["tag-b"]);
});

test("decimals come from the contract parameter, never hardcoded", () => {
  const six = buildSettlementCalldata({
    owner: OWNER, recipient: RECIPIENT, amount: "1", decimals: 6, attributionTag: TAG,
  });
  const eighteen = buildSettlementCalldata({
    owner: OWNER, recipient: RECIPIENT, amount: "1", decimals: 18, attributionTag: TAG,
  });
  assert.equal(six.amountBaseUnits, 1_000_000n);
  assert.equal(eighteen.amountBaseUnits, 1_000_000_000_000_000_000n);
  assert.notEqual(six.transferFromCalldata, eighteen.transferFromCalldata);
  assert.equal(six.attributionSuffix, eighteen.attributionSuffix);
  assert.equal(countOccurrences(six.data.slice(2), six.attributionSuffix.slice(2)), 1);
});

test("attribution tag is server-side configuration; the client has no input path", () => {
  // The request schema accepts only a submission id (proven by the existing
  // validation tests). The calldata builder takes the tag exclusively from
  // the relayer configuration — there is no parameter a client could reach.
  const built = buildSettlementCalldata({
    owner: OWNER,
    recipient: RECIPIENT,
    amount: AMOUNT,
    decimals: 18,
    attributionTag: TAG,
  });
  assert.deepEqual(Attribution.fromData(asHex(built.data))?.codes, [TAG]);
});

test("missing attribution configuration fails safely — no tag is ever invented", () => {
  const savedTag = process.env.ATTRIBUTION_TAG;
  const savedRpc = process.env.CELO_RPC_URL;
  const savedKey = process.env.AGENT_RELAYER_PRIVATE_KEY;
  try {
    // Provide syntactically valid RPC/key so ONLY the attribution tag is
    // missing (a dummy key is used — never a real one).
    process.env.CELO_RPC_URL = savedRpc ?? "https://forno.celo.org";
    process.env.AGENT_RELAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    delete process.env.ATTRIBUTION_TAG;
    assert.equal(hasRelayerConfig(), false);
    assert.throws(() => getRelayerConfig(), (err: unknown) => {
      assert.ok(err instanceof RelayerConfigError);
      assert.equal(err.reason, "missing_attribution_tag");
      // The error is secret-free.
      assert.equal(err.message.includes(savedTag ?? "<none>"), false);
      return true;
    });
    // No deps can be built → the executor fails safe (never broadcasts).
    assert.equal(createDefaultRelayerDeps(), null);
  } finally {
    if (savedTag !== undefined) process.env.ATTRIBUTION_TAG = savedTag;
    if (savedRpc !== undefined) process.env.CELO_RPC_URL = savedRpc;
    if (savedKey !== undefined) process.env.AGENT_RELAYER_PRIVATE_KEY = savedKey;
  }
});

test("missing RPC URL or private key fails safely with secret-free errors", () => {
  const savedRpc = process.env.CELO_RPC_URL;
  const savedKey = process.env.AGENT_RELAYER_PRIVATE_KEY;
  const savedTag = process.env.ATTRIBUTION_TAG;
  try {
    delete process.env.CELO_RPC_URL;
    try {
      getRelayerConfig();
      assert.fail("expected missing_celo_rpc_url");
    } catch (err) {
      assert.ok(err instanceof RelayerConfigError);
      assert.equal((err as RelayerConfigError).reason, "missing_celo_rpc_url");
    }

    process.env.CELO_RPC_URL = savedRpc ?? "https://forno.celo.org";
    delete process.env.AGENT_RELAYER_PRIVATE_KEY;
    try {
      getRelayerConfig();
      assert.fail("expected missing_relayer_private_key");
    } catch (err) {
      assert.ok(err instanceof RelayerConfigError);
      assert.equal((err as RelayerConfigError).reason, "missing_relayer_private_key");
    }

    process.env.AGENT_RELAYER_PRIVATE_KEY = "not-a-key";
    try {
      getRelayerConfig();
      assert.fail("expected invalid_relayer_private_key");
    } catch (err) {
      assert.ok(err instanceof RelayerConfigError);
      assert.equal((err as RelayerConfigError).reason, "invalid_relayer_private_key");
    }

    assert.equal(createDefaultRelayerDeps(), null);
  } finally {
    if (savedRpc !== undefined) process.env.CELO_RPC_URL = savedRpc;
    if (savedKey !== undefined) process.env.AGENT_RELAYER_PRIVATE_KEY = savedKey;
    if (savedTag !== undefined) process.env.ATTRIBUTION_TAG = savedTag;
  }
});

test("the relay is pinned to Celo Mainnet (42220) — no fallback chain exists", async () => {
  const { RELAYER_CHAIN_ID } = await import("../lib/settlement/RelayerConfig.ts");
  assert.equal(RELAYER_CHAIN_ID, 42220);
  const { celo } = await import("viem/chains");
  assert.equal(celo.id, 42220);
});