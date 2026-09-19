/**
 * CeloTasker — Celo Mainnet settlement relayer (Stage 5C).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * This module is the BLOCKCHAIN step: it builds the ERC-20 transferFrom
 * calldata, appends the ERC-8021 attribution suffix (official ox/erc8021
 * implementation — the wire format is never invented here), broadcasts via a
 * dedicated server-side relayer wallet on Celo Mainnet (42220), and waits
 * for the receipt. It NEVER authorizes anything — authorization is the
 * Stage 4.2 SettlementService gate, and only a verified receipt authorizes
 * SETTLED/COMPLETED.
 *
 * Client input is structurally absent: every parameter comes from trusted
 * server-side records or server-only configuration. No arbitrary calldata,
 * no arbitrary tokens/recipients, no native CELO transfers.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAbiItem,
  http,
  parseEventLogs,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { concatHex } from "viem";
// Official ERC-8021 implementation — the suffix format is never re-invented.
import { Attribution } from "ox/erc8021";
import { getRelayerConfig, RELAYER_CHAIN_ID, parseAttributionCodes } from "./RelayerConfig.ts";

/** Minimal structural receipt (mockable in tests). */
export interface RelayerReceipt {
  status: "success" | "reverted";
  blockNumber: bigint | null;
  transactionHash: string;
  /** Raw receipt logs — verified with the ERC-20 Transfer event ABI. */
  logs: readonly unknown[];
}

/** Minimal structural public client surface used by the executor. */
export interface RelayerPublicClient {
  getChainId(): Promise<number>;
  readContract(args: {
    address: string;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  waitForTransactionReceipt(args: {
    hash: string;
    timeout?: number;
    /** viem-native confirmation depth: the receipt is only returned once the
     * transaction is buried under this many blocks (M-2). */
    confirmations?: number;
  }): Promise<RelayerReceipt>;
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: string;
    event?: unknown;
    args?: unknown;
    fromBlock?: bigint;
    toBlock?: bigint;
  }): Promise<unknown[]>;
  getTransaction(args: {
    hash: string;
  }): Promise<{ hash: string; from: string | null; to: string | null; input: string }>;
}

/** Minimal structural wallet client surface used by the executor. */
export interface RelayerWalletClient {
  account: { address: string };
  sendTransaction(args: {
    to: string;
    data: string;
    chain?: unknown;
    account?: unknown;
  }): Promise<string>;
}

/** Everything the executor needs; fully injectable so tests never touch mainnet. */
export interface RelayerDeps {
  /** Must always be Celo Mainnet (42220). */
  chainId: number;
  /** The dedicated relayer wallet address (transferFrom spender / gas payer). */
  relayerAddress: string;
  /** Server-side registered ERC-8021 attribution tag. */
  attributionTag: string;
  publicClient: RelayerPublicClient;
  walletClient: RelayerWalletClient;
}

/**
 * Build the production relayer deps from server-only configuration.
 * Returns null (never throws) when configuration is missing/invalid so that
 * callers fail safe without broadcasting.
 */
export function createDefaultRelayerDeps(): RelayerDeps | null {
  let config;
  try {
    config = getRelayerConfig();
  } catch {
    return null;
  }
  try {
    // Chain is pinned to Celo Mainnet. No Alfajores/other-chain fallback
    // exists anywhere in this path.
    if (celo.id !== RELAYER_CHAIN_ID) return null;
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const publicClient = createPublicClient({
      chain: celo,
      transport: http(config.rpcUrl),
    });
    const walletClient = createWalletClient({
      chain: celo,
      transport: http(config.rpcUrl),
      account,
    });
    return {
      chainId: RELAYER_CHAIN_ID,
      relayerAddress: account.address,
      attributionTag: config.attributionTag,
      publicClient: publicClient as unknown as RelayerPublicClient,
      walletClient: walletClient as unknown as RelayerWalletClient,
    };
  } catch {
    return null;
  }
}

/**
 * Read the token's decimals() from the verified ERC-20 contract — decimals are
 * NEVER hardcoded and NEVER client-supplied. Fails safely on values outside
 * the sane ERC-20 range.
 */
export async function readTokenDecimals(
  deps: RelayerDeps,
  token: string
): Promise<number> {
  const raw = (await deps.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  })) as unknown;
  const decimals = Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`invalid_decimals:${String(raw)}`);
  }
  return decimals;
}

/** Read allowance(owner, spender) from the verified token contract. */
export async function readAllowance(
  deps: RelayerDeps,
  params: { token: string; owner: string; spender: string }
): Promise<bigint> {
  return (await deps.publicClient.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [params.owner, params.spender],
  })) as bigint;
}

export interface SettlementCalldata {
  /** The complete broadcast calldata: transferFrom + ERC-8021 suffix. */
  data: string;
  /** transferFrom amount in base units (parseUnits with on-chain decimals). */
  amountBaseUnits: bigint;
  /** The ERC-8021 attribution suffix actually appended (exactly once). */
  attributionSuffix: string;
  /** The pristine ERC-20 transferFrom calldata before the suffix. */
  transferFromCalldata: string;
}

/**
 * Build the settlement transaction calldata. PURE — used verbatim by tests to
 * verify the actual encoded bytes.
 *
 *   data = encodeFunctionData(transferFrom(owner, recipient, parseUnits(
 *            amount, on-chain decimals))) + Attribution.toDataSuffix({
 *            codes: [server-side codes] })
 *
 * The suffix is appended AFTER the original calldata, exactly once, using the
 * official ox/erc8021 implementation. ERC-8021 suffixes carry MULTIPLE codes,
 * so the application's own code and any issued/registered code (e.g. a
 * hackathon attribution tag) are encoded together, in configured order: a
 * transaction can never be re-tagged after it is sent.
 */
export function buildSettlementCalldata(params: {
  owner: string;
  recipient: string;
  /** Human/token-unit amount string from the trusted task record. */
  amount: string;
  /** Decimals read from the verified token contract. */
  decimals: number;
  /**
   * Server-side ERC-8021 code(s), comma-separated when more than one (never
   * client-supplied). Order is preserved.
   */
  attributionTag: string;
}): SettlementCalldata {
  const amountBaseUnits = parseUnits(params.amount, params.decimals);
  const transferFromCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transferFrom",
    args: [
      params.owner as `0x${string}`,
      params.recipient as `0x${string}`,
      amountBaseUnits,
    ],
  });
  // Every configured code is encoded into the single suffix (official
  // ox/erc8021 encoder — the wire format is never re-invented here).
  const attributionSuffix = Attribution.toDataSuffix({
    codes: parseAttributionCodes(params.attributionTag),
  });
  return {
    data: concatHex([transferFromCalldata, attributionSuffix]),
    amountBaseUnits,
    attributionSuffix,
    transferFromCalldata,
  };
}

/**
 * Broadcast the pre-built transferFrom calldata through the relayer wallet.
 * Returns the transaction hash — which is NOT settlement success; only a
 * verified receipt is (see SettlementExecutor).
 */
export async function broadcastTransferFrom(
  deps: RelayerDeps,
  params: { token: string; data: string }
): Promise<string> {
  // The walletClient was created with the relayer's private key account.
  // Passing a plain address string as `account` would cause viem to use
  // eth_sendTransaction (requires node-side key). Omit `account` to use
  // the walletClient's pre-configured account and sign locally via
  // eth_sendRawTransaction.
  return deps.walletClient.sendTransaction({
    to: params.token,
    data: params.data,
  });
}

/**
 * Wait for the receipt of a broadcast transaction (no new tx is ever sent).
 * Uses viem's own confirmation-depth primitive when a depth is given: viem
 * only resolves once the transaction has `confirmations` blocks on top of it.
 * The executor independently re-verifies the depth against the chain head —
 * the viem wait is a convenience, the explicit gate is authoritative.
 */
export async function waitForSettlementReceipt(
  deps: RelayerDeps,
  txHash: string,
  timeoutMs: number,
  confirmations?: number
): Promise<RelayerReceipt> {
  return deps.publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: timeoutMs,
    confirmations,
  });
}

/** The ERC-20 Transfer event item from the standard erc20Abi. */
const TRANSFER_EVENT = getAbiItem({ abi: erc20Abi, name: "Transfer" });

export interface ExpectedTransfer {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

export interface TransferVerification {
  ok: boolean;
  /** Deterministic detail explaining a mismatch (secret-free). */
  detail: string | null;
  /** The matching log when verification succeeds. */
  matched: { address: string; args: { from: string; to: string; value: bigint } } | null;
}

/**
 * Verify that the receipt logs contain the expected ERC-20 Transfer event:
 * token contract, from (payment owner), to (worker recipient) and value
 * (exact base-unit amount). Decodes through the actual ERC-20 event ABI
 * (parseEventLogs) — never string matching.
 *
 * Pure function over the raw logs: deterministic and unit-testable.
 */
export function verifyTransferEvent(
  logs: readonly unknown[],
  expected: ExpectedTransfer
): TransferVerification {
  let parsed: unknown[] = [];
  try {
    parsed = parseEventLogs({
      abi: erc20Abi,
      logs: logs as Parameters<typeof parseEventLogs>[0]["logs"],
      strict: false,
    });
  } catch {
    parsed = [];
  }

  const lower = (a: string) => a.toLowerCase();
  for (const log of parsed) {
    const entry = log as {
      eventName?: string;
      address?: string;
      args?: { from?: string; to?: string; value?: unknown };
    };
    if (entry.eventName !== "Transfer") continue;
    const from = entry.args?.from ?? "";
    const to = entry.args?.to ?? "";
    const value = entry.args?.value;
    if (typeof value !== "bigint") continue;

    const tokenMatches = lower(entry.address ?? "") === lower(expected.token);
    if (!tokenMatches) continue;

    if (lower(from) !== lower(expected.from) || lower(to) !== lower(expected.to)) {
      return {
        ok: false,
        detail: "transfer_party_mismatch",
        matched: null,
      };
    }
    if (value !== expected.value) {
      return {
        ok: false,
        detail: `transfer_value_mismatch:expected ${expected.value.toString()},got ${value.toString()}`,
        matched: null,
      };
    }
    return {
      ok: true,
      detail: null,
      matched: {
        address: lower(entry.address ?? ""),
        args: { from: lower(from), to: lower(to), value },
      },
    };
  }
  // No Transfer log on the expected token contract matched the parties.
  const tokenTransferExists = parsed.some(
    (log) =>
      (log as { eventName?: string; address?: string }).eventName === "Transfer" &&
      lower((log as { address?: string }).address ?? "") === lower(expected.token)
  );
  return {
    ok: false,
    detail: tokenTransferExists
      ? "transfer_event_mismatch"
      : "missing_transfer_event",
    matched: null,
  };
}

/**
 * Default block window scanned when recovering an ambiguous broadcast:
 * ~100,000 Celo blocks (~5s each ≈ 5.8 days).
 */
export const RECOVERY_BLOCK_WINDOW = 100_000n;

/**
 * DETERMINISTIC BROADCAST RECOVERY — used only when a transaction was
 * broadcast but its hash was never persisted (crash window). This NEVER
 * sends a transaction. It scans the token's Transfer logs, decodes each one
 * through the actual ERC-20 event ABI, and returns EVERY candidate that is
 * FULLY verified as this settlement's broadcast:
 *
 *   1. a decoded Transfer event on the exact expected token contract;
 *   2. exact expected parties (from = payment owner, to = worker recipient);
 *   3. exact expected value (the amount is NON-INDEXED so the RPC log filter
 *      cannot check it — it is decoded here and compared exactly);
 *   4. the candidate log is inside the bounded recovery window;
 *   5. the transaction was sent by OUR configured relayer address;
 *   6. the transaction's destination is the expected token contract;
 *   7. the transaction's input is BYTE-IDENTICAL to the calldata this server
 *      builds (transferFrom + the ERC-8021 attribution suffix).
 *
 * The caller (never this function) resolves multiple candidates fail-closed:
 * a wrong attachment is worse than a stuck settlement.
 *
 * Returns the verified transaction hashes (may be more than one — identical
 * settlements produce identical calldata, so ambiguity is possible).
 */
export async function findMatchingBroadcast(
  deps: RelayerDeps,
  params: {
    expected: ExpectedTransfer;
    /** The exact calldata this server builds (transferFrom + suffix). */
    calldata: string;
    /** The configured relayer wallet — the ONLY sender of a settlement tx. */
    relayerAddress: string;
    /** Settlement creation time — bounds the scan window (M-1). */
    broadcastAfter?: Date;
    fromBlock?: bigint;
    toBlock?: bigint;
  }
): Promise<string[]> {
  const toBlock = params.toBlock ?? (await deps.publicClient.getBlockNumber());

  // Bound the scan (M-1): never scan more than RECOVERY_BLOCK_WINDOW blocks,
  // and when the settlement's creation time is known, scan only the blocks
  // that have elapsed since then (plus a clock-skew buffer of ~8 minutes).
  let fromBlock = params.fromBlock;
  if (fromBlock === undefined) {
    const ageMs = params.broadcastAfter
      ? Date.now() - params.broadcastAfter.getTime()
      : Number(RECOVERY_BLOCK_WINDOW * 5_000n);
    const ageBlocks =
      BigInt(Math.max(0, Math.floor(ageMs / 5_000))) + 100n; // skew buffer
    const capped = ageBlocks > RECOVERY_BLOCK_WINDOW ? RECOVERY_BLOCK_WINDOW : ageBlocks;
    fromBlock = toBlock > capped ? toBlock - capped : 0n;
  }

  const logs = (await deps.publicClient.getLogs({
    address: params.expected.token,
    event: TRANSFER_EVENT,
    args: { from: params.expected.from, to: params.expected.to },
    fromBlock,
    toBlock,
  })) as Array<unknown>;

  const lower = (a: string) => a.toLowerCase();

  // Decode every log through the actual ERC-20 Transfer event ABI — never
  // string matching — and keep only logs proving THIS settlement's transfer.
  let parsed: unknown[] = [];
  try {
    parsed = parseEventLogs({
      abi: erc20Abi,
      logs: logs as Parameters<typeof parseEventLogs>[0]["logs"],
      strict: false,
    });
  } catch {
    parsed = [];
  }

  const seen = new Set<string>();
  const candidateHashes: string[] = [];
  for (const log of parsed) {
    const entry = log as {
      eventName?: string;
      address?: string;
      transactionHash?: string;
      blockNumber?: bigint | number;
      args?: { from?: unknown; to?: unknown; value?: unknown };
    };
    if (entry.eventName !== "Transfer") continue;
    if (lower(entry.address ?? "") !== lower(params.expected.token)) continue;
    const from = entry.args?.from;
    const to = entry.args?.to;
    const value = entry.args?.value;
    if (typeof from !== "string" || typeof to !== "string" || typeof value !== "bigint") {
      continue;
    }
    if (lower(from) !== lower(params.expected.from) || lower(to) !== lower(params.expected.to)) {
      continue;
    }
    if (value !== params.expected.value) continue; // EXACT amount (M-1)
    // Defense in depth: an RPC that ignores the requested range must not
    // smuggle in a candidate from outside the bounded window.
    if (typeof entry.blockNumber === "bigint" && entry.blockNumber < fromBlock) {
      continue;
    }
    const hash = entry.transactionHash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    candidateHashes.push(hash);
  }

  // Independently verify each candidate transaction: it must be SENT BY OUR
  // RELAYER, to the expected token contract, with byte-identical calldata.
  const verified: string[] = [];
  for (const hash of candidateHashes) {
    let tx: { hash: string; from: string | null; to: string | null; input: string };
    try {
      tx = await deps.publicClient.getTransaction({ hash });
    } catch {
      continue;
    }
    if (tx.from === null || lower(tx.from) !== lower(params.relayerAddress)) {
      continue; // not our relayer — never this settlement's broadcast (M-1)
    }
    if (tx.to !== null && lower(tx.to) !== lower(params.expected.token)) continue;
    if (tx.to === null) continue;
    if (lower(tx.input) !== lower(params.calldata)) continue;
    verified.push(hash);
  }
  return verified;
}