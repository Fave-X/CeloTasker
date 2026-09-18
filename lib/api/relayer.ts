/**
 * CeloTasker — read-only relayer surface (UI Step 1).
 *
 * The client needs exactly one public fact to build the ERC-20 approve():
 * the address the requester must approve as spender. That is the PUBLIC
 * on-chain identity derived from the server-side key; the key itself is never
 * read here and never leaves RelayerConfig.
 *
 * Lives in lib/ (not the route) so it is testable through Node's test runner,
 * matching the existing convention: services in lib/, routes are thin
 * transport wrappers.
 */
import { getRelayerPublicConfig } from "../settlement/RelayerConfig.ts";

export interface RelayerPublicInfo {
  relayerAddress: string;
  chainId: number;
  token: string;
}

export type RelayerInfoResult =
  | { ok: true; data: RelayerPublicInfo }
  | { ok: false; reason: string; status: number };

/**
 * Public relayer facts, or a fail-safe refusal when the relayer is not
 * configured — the client must never guess a spender address.
 */
export function getRelayerPublicInfo(): RelayerInfoResult {
  const config = getRelayerPublicConfig();
  if (!config) {
    return { ok: false, reason: "relayer_unconfigured", status: 503 };
  }
  return { ok: true, data: config };
}