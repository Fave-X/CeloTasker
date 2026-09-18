/**
 * CeloTasker — READ-ONLY relayer configuration check (manual, opt-in).
 *
 * Purpose: verify `.env → relayer configuration → derived PUBLIC wallet
 * address` BEFORE any funding or on-chain activity.
 *
 * Safety properties:
 * - READ-ONLY and FULLY OFFLINE: no RPC client is constructed, no network
 *   request of any kind is made, no transaction is signed or sent, no
 *   balance/faucet interaction exists.
 * - The private key value is NEVER printed, echoed or serialized: only its
 *   presence and 0x-hex SHAPE are reported, and it is used solely as input to
 *   viem's `privateKeyToAccount` to derive the public address.
 * - Errors carry only the variable NAME / a stable reason — never a value.
 *
 * Usage:
 *   npm run config:relayer
 *   node --env-file=.env scripts/relayer-config-check.ts
 */
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  getRelayerConfig,
  RelayerConfigError,
  RELAYER_CHAIN_ID,
  resolveSettlementConfirmationDepth,
} from "../lib/settlement/RelayerConfig.ts";
import { SETTLEMENT_TOKEN_WHITELIST } from "../lib/security/SecurityPolicy.ts";

function log(line: string): void {
  console.log(`[relayer-check] ${line}`);
}

/** Presence only — the VALUE of a secret variable is never read into output. */
function present(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
}

const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;
const keyPresent = present("AGENT_RELAYER_PRIVATE_KEY");
const keyShapeValid =
  keyPresent && KEY_SHAPE.test((process.env.AGENT_RELAYER_PRIVATE_KEY ?? "").trim());

// 1. Chain: the configured/pinned chain (no network call — the constant and
//    the viem chain object are compared offline).
log(`chain_id_configured=${RELAYER_CHAIN_ID}`);
log(`viem_celo_chain_id=${celo.id} pinned_match=${celo.id === RELAYER_CHAIN_ID}`);

// 2. Required environment variables: presence (and key SHAPE) only.
log(
  `env CELO_RPC_URL=${present("CELO_RPC_URL")} ` +
    `AGENT_RELAYER_PRIVATE_KEY=${keyPresent}(shape_valid=${keyShapeValid}) ` +
    `ATTRIBUTION_TAG=${present("ATTRIBUTION_TAG")} ` +
    `SETTLEMENT_CONFIRMATION_DEPTH=${present("SETTLEMENT_CONFIRMATION_DEPTH")}`
);

// 3. Confirmation depth (M-2): resolved server-side value or fail-closed null.
const depthEnv = process.env.SETTLEMENT_CONFIRMATION_DEPTH;
const depth = resolveSettlementConfirmationDepth();
log(
  `confirmation_depth=${depth === null ? "INVALID_FAIL_CLOSED" : depth}` +
    `${depthEnv === undefined ? " (default)" : ` (from env)`}`
);

// 4. Settlement token whitelist for the configured chain.
log(
  `token_whitelist[chain_${RELAYER_CHAIN_ID}]=${SETTLEMENT_TOKEN_WHITELIST[
    RELAYER_CHAIN_ID
  ].join(",")}`
);

// 5. Full configuration validation + PUBLIC address derivation.
try {
  const config = getRelayerConfig();
  // The ONLY use of the private key: derive the public address. The key is
  // never logged, never stringified, never leaves this call.
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  log(`relayer_address=${account.address}`);
  log(`attribution_tag_length=${config.attributionTag.length}`);
  log(
    "RESULT: PASS — relayer configuration is complete and valid; the executor would build relayer deps."
  );
} catch (err) {
  if (err instanceof RelayerConfigError) {
    log(`config_error=${err.reason}`);
    log(
      "RESULT: FAIL — the relayer is not fully configured; the executor fails safe (stays PENDING, never broadcasts)."
    );
  } else {
    log(
      `unexpected_error name=${err instanceof Error ? err.name : "unknown"}`
    );
    log("RESULT: FAIL — unexpected configuration failure.");
  }
  process.exitCode = 1;
}