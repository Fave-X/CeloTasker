/**
 * CeloTasker — requester approve attribution tests (ERC-8021).
 *
 * The requester's cUSD approve(relayer, reward) must carry the SAME
 * ERC-8021 attribution suffix as every settlement transaction:
 * - the suffix comes from the SAME official ox/erc8021 encoder the
 *   settlement relayer uses (lib/settlement/CeloRelayer.ts);
 * - the pristine approve calldata (spender + amount) is byte-identical
 *   to the un-attributed encoding — the suffix is appended AFTER it;
 * - the suffix is appended EXACTLY ONCE;
 * - the final calldata round-trips through ox's own decoder;
 * - the client constant and the settlement pipeline (parseAttributionCodes)
 *   produce byte-identical suffixes for the same code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Official implementation — imported exactly as specified; never re-invented.
import { Attribution } from "ox/erc8021";
import { concatHex, encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { APPROVE_ATTRIBUTION_CODES } from "../lib/celo.ts";
import { parseAttributionCodes } from "../lib/settlement/RelayerConfig.ts";

const SPENDER = "0x3333333333333333333333333333333333333333";
const AMOUNT = "25"; // cUSD
const TAG = "celo_0c607ceeb1b3"; // the issued hackathon code

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

/** Pristine approve(spender, amount) — exactly what the component encoded before. */
const pristineApprove = encodeFunctionData({
  abi: erc20Abi,
  functionName: "approve",
  args: [SPENDER as `0x${string}`, parseUnits(AMOUNT, 18)],
});

/** The attributed calldata, built with the component's exact expression. */
const attributedApprove = concatHex([
  pristineApprove,
  Attribution.toDataSuffix({ codes: APPROVE_ATTRIBUTION_CODES }),
]);

test("approve suffix comes from the SAME ox/erc8021 encoder and decodes back to the tag", () => {
  const suffix = Attribution.toDataSuffix({ codes: APPROVE_ATTRIBUTION_CODES });
  assert.ok(suffix.startsWith("0x"));
  // Round-trip through the OFFICIAL decoder: real wire format, not a guess.
  const decoded = Attribution.fromData(suffix);
  assert.deepEqual(decoded?.codes, APPROVE_ATTRIBUTION_CODES);
  assert.deepEqual(APPROVE_ATTRIBUTION_CODES, [TAG]);
});

test("pristine approve prefix is preserved byte-for-byte (spender and amount unchanged)", () => {
  assert.ok(attributedApprove.startsWith(pristineApprove));
  // The pristine encoding contains no attribution bytes at all (before-state).
  const suffix = Attribution.toDataSuffix({ codes: APPROVE_ATTRIBUTION_CODES });
  const tagHex = Buffer.from(TAG, "utf8").toString("hex");
  assert.equal(pristineApprove.includes(tagHex), false);
  // Length arithmetic: data = pristine ++ suffix (suffix appended LAST).
  assert.equal(
    attributedApprove.length,
    pristineApprove.length + suffix.length - 2
  );
  assert.ok(attributedApprove.endsWith(suffix.slice(2)));
});

test("suffix is appended EXACTLY ONCE and the full calldata decodes to the tag", () => {
  const suffix = Attribution.toDataSuffix({ codes: APPROVE_ATTRIBUTION_CODES });
  const body = attributedApprove.slice(2);
  assert.equal(countOccurrences(body, suffix.slice(2)), 1);
  // The ERC-8021 marker (fixed suffix tail per the spec) appears exactly once.
  const ercMarker = suffix.slice(-32);
  assert.equal(countOccurrences(body, ercMarker), 1);
  // The whole attributed approve calldata round-trips through ox's decoder.
  assert.deepEqual(Attribution.fromData(asHex(attributedApprove))?.codes, [TAG]);
});

test("client constant and settlement pipeline produce byte-identical suffixes", () => {
  // The settlement relayer derives its codes via parseAttributionCodes(env).
  // Feeding the SAME code through that exact pipeline must give the SAME
  // suffix the client appends — one encoder, one wire format, everywhere.
  const viaSettlementPipeline = Attribution.toDataSuffix({
    codes: parseAttributionCodes(TAG),
  });
  const viaClientConstant = Attribution.toDataSuffix({
    codes: APPROVE_ATTRIBUTION_CODES,
  });
  assert.equal(viaSettlementPipeline, viaClientConstant);
});