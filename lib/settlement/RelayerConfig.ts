/**
 * CeloTasker — Mainnet relayer configuration (Stage 5C).
 *
 * SECURITY INVARIANT: LLM MAY RECOMMEND → DETERMINISTIC CODE MUST AUTHORIZE
 * → BLOCKCHAIN MUST CONFIRM → AUDIT TRAIL MUST RECORD.
 *
 * Server-only configuration for the settlement relayer. All values are read
 * from server-only environment variables via the existing env choke point:
 * - CELO_RPC_URL              (never a public/browser variable)
 * - AGENT_RELAYER_PRIVATE_KEY (never a public/browser variable; never logged)
 * - ATTRIBUTION_TAG           (registered ERC-8021 tag, server-side only)
 *
 * Settlement executes on Celo MAINNET (chain 42220) only. There is no
 * fallback chain. Missing/invalid configuration FAILS SAFE: the executor
 * never broadcasts and the settlement stays PENDING.
 *
 * Errors intentionally contain ONLY the variable NAME and a reason — never
 * the secret value.
 */
import { requireServerEnv } from "../security/env.ts";
import { CHAIN_IDS, SETTLEMENT_TOKEN_WHITELIST } from "../security/SecurityPolicy.ts";
import { privateKeyToAccount } from "viem/accounts";

/** The only chain settlement may execute on: Celo Mainnet. */
export const RELAYER_CHAIN_ID = CHAIN_IDS.CELO_MAINNET; // 42220

export interface RelayerConfig {
  rpcUrl: string;
  /** Private relayer key — server-only, never logged or serialized. */
  privateKey: string;
  /** Server-configured registered ERC-8021 attribution tag. */
  attributionTag: string;
  /** Always Celo Mainnet (42220). */
  chainId: number;
}

export type RelayerConfigFailureReason =
  | "missing_celo_rpc_url"
  | "missing_relayer_private_key"
  | "invalid_relayer_private_key"
  | "missing_attribution_tag"
  | "invalid_attribution_tag";

/** Structured, secret-free configuration error. */
export class RelayerConfigError extends Error {
  readonly reason: RelayerConfigFailureReason;

  constructor(reason: RelayerConfigFailureReason) {
    super(`Relayer configuration error: ${reason}`);
    this.name = "RelayerConfigError";
    this.reason = reason;
  }
}

/** A syntactically valid secp256k1 private key: 0x + 64 hex chars. */
const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolve and validate the production relayer configuration. Throws
 * RelayerConfigError (secret-free) when required configuration is missing or
 * invalid — callers must fail safe rather than broadcast.
 */
export function getRelayerConfig(): RelayerConfig {
  let rpcUrl: string;
  let privateKey: string;
  let attributionTag: string;
  try {
    rpcUrl = requireServerEnv("CELO_RPC_URL");
    privateKey = requireServerEnv("AGENT_RELAYER_PRIVATE_KEY");
    attributionTag = requireServerEnv("ATTRIBUTION_TAG");
  } catch (err) {
    // requireServerEnv's message names the missing variable — map it to a
    // stable, secret-free reason. (The message never contains the value.)
    const msg = (err as Error).message;
    if (msg.includes("CELO_RPC_URL")) {
      throw new RelayerConfigError("missing_celo_rpc_url");
    }
    if (msg.includes("AGENT_RELAYER_PRIVATE_KEY")) {
      throw new RelayerConfigError("missing_relayer_private_key");
    }
    throw new RelayerConfigError("missing_attribution_tag");
  }

  if (!PRIVATE_KEY_SHAPE.test(privateKey)) {
    throw new RelayerConfigError("invalid_relayer_private_key");
  }
  if (attributionTag.trim().length === 0 || attributionTag.length > 200) {
    throw new RelayerConfigError("invalid_attribution_tag");
  }

  return {
    rpcUrl,
    privateKey,
    attributionTag,
    chainId: RELAYER_CHAIN_ID,
  };
}

/** True when the relayer environment is fully configured and valid. */
/**
 * M-2 confirmation depth: the number of Celo blocks (~5s each) a settlement
 * transaction must be buried under before the settlement may be finalized.
 * A receipt at depth 0 can still be reorged out, so CONFIRMED/COMPLETED (and
 * equally the terminal FAILED decision) is deferred until this depth holds.
 * The default of 5 blocks (~25s) comfortably covers short-range reorgs while
 * keeping finalization responsive. SERVER-SIDE ONLY — the depth is never
 * accepted from a client.
 */
export const DEFAULT_SETTLEMENT_CONFIRMATION_DEPTH = 5;

/**
 * Hard upper bound on a configurable depth so a misconfiguration cannot
 * stall settlements indefinitely (e.g. "999999").
 */
const MAX_SETTLEMENT_CONFIRMATION_DEPTH = 1_000;

/**
 * Resolve the required settlement confirmation depth from the server-only
 * SETTLEMENT_CONFIRMATION_DEPTH environment variable. Returns the safe
 * default when unset/blank. Returns null for ANY invalid or unsafe value —
 * callers must then FAIL CLOSED (never finalize a settlement).
 */
export function resolveSettlementConfirmationDepth(): number | null {
  const raw = process.env.SETTLEMENT_CONFIRMATION_DEPTH;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SETTLEMENT_CONFIRMATION_DEPTH;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null; // negatives, floats, junk
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SETTLEMENT_CONFIRMATION_DEPTH
  ) {
    return null;
  }
  return parsed;
}
export function hasRelayerConfig(): boolean {
  try {
    getRelayerConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only PUBLIC relayer facts for the client (Approve & Relay): the spender
 * address the requester must approve(), the pinned chain, and the whitelisted
 * payout token. Derived OFFLINE from the same validated configuration the
 * executor uses — no RPC client is constructed, and the private key is never
 * exposed, logged or serialized (only its derived public address).
 * Returns null when the relayer is not configured (fail-safe).
 */
export interface RelayerPublicConfig {
  /** The relayer/spender address for ERC-20 approve() calls. */
  relayerAddress: string;
  /** Always Celo Mainnet (42220). */
  chainId: number;
  /** The whitelisted settlement token (cUSD) contract address. */
  token: string;
}

export function getRelayerPublicConfig(): RelayerPublicConfig | null {
  try {
    const config = getRelayerConfig();
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    return {
      relayerAddress: account.address,
      chainId: RELAYER_CHAIN_ID,
      token: SETTLEMENT_TOKEN_WHITELIST[RELAYER_CHAIN_ID][0],
    };
  } catch {
    return null;
  }
}