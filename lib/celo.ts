/**
 * CeloTasker — client-safe Celo constants and formatting helpers.
 *
 * These values are PUBLIC on-chain facts (chain id, the whitelisted cUSD
 * contract, a public read-only RPC endpoint). They mirror the server-side
 * SecurityPolicy whitelist for display/read purposes only — the SERVER
 * remains authoritative for every authorization decision. No secrets live in
 * this module, and nothing here can sign or broadcast.
 */
import { formatUnits } from "viem";

export const CELO_CHAIN_ID = 42220;
export const CELO_CHAIN_ID_HEX = "0xa4ec";

/** Whitelisted settlement token: cUSD on Celo Mainnet. */
export const CUSD_ADDRESS = "0x765de816845861e75a25fca122bb6898b8b1282a";

/** Public read-only RPC for balance reads (never used for sending). */
export const PUBLIC_RPC_URL = "https://rpc.ankr.com/celo";

/**
 * ERC-8021 attribution code(s) carried by USER-initiated transactions — the
 * requester's cUSD approve(spender, reward). Encoded with the SAME official
 * ox/erc8021 encoder the settlement relayer uses
 * (lib/settlement/CeloRelayer.ts → Attribution.toDataSuffix), so approvals
 * are attributable on Celoscan exactly like settlements.
 *
 * This is a PUBLIC on-chain fact: the issued hackathon code is already
 * embedded in every settlement transaction. The settlement relayer
 * additionally appends the application's own code from its server-side
 * configuration; the client bundle cannot read that server-only variable,
 * and never needs to.
 */
export const APPROVE_ATTRIBUTION_CODES: string[] = ["celo_0c607ceeb1b3"];

/** Human-readable display: 0xce09…21a7 (Plex Mono territory). */
export function truncateAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Base units → human string, trailing zeros trimmed ("12.5 cUSD" not "12.500…"). */
export function formatTokenAmount(
  baseUnits: bigint,
  decimals: number,
  symbol: string
): string {
  const raw = formatUnits(baseUnits, decimals);
  const trimmed = raw.includes(".")
    ? raw.replace(/0+$/, "").replace(/\.$/, "")
    : raw;
  return `${trimmed} ${symbol}`;
}