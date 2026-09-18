/**
 * CeloTasker — LIVE READ-ONLY Celo Mainnet relayer check (manual, opt-in).
 *
 * Purpose: before funding or any on-chain activity, verify that the configured
 * RPC actually serves Celo Mainnet (42220) and report the relayer wallet's
 * native CELO (gas) and whitelisted cUSD balances in human-readable units.
 *
 * Safety properties:
 * - READ-ONLY: only a viem PUBLIC client is created. There is no wallet
 *   client, no account signing, no transaction, no approval, no faucet
 *   request — nothing on chain can be mutated by this script.
 * - The private key is used ONLY to derive the public relayer address
 *   (offline, via the project's own configuration) and is NEVER printed,
 *   echoed or serialized.
 * - The RPC URL is NEVER printed (it may embed credentials); only the chain
 *   ID the endpoint serves is reported.
 * - The RPC must answer chain 42220 or the check FAILS and no further reads
 *   are trusted.
 * - cUSD decimals are read from the token contract itself — never hardcoded.
 */
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  getRelayerConfig,
  RelayerConfigError,
  RELAYER_CHAIN_ID,
} from "../lib/settlement/RelayerConfig.ts";
import { SETTLEMENT_TOKEN_WHITELIST } from "../lib/security/SecurityPolicy.ts";

function log(line: string): void {
  console.log(`[relayer-live] ${line}`);
}

async function main(): Promise<number> {
  // Configuration through the project's own choke point (secret-free errors).
  let rpcUrl: string;
  let address: `0x${string}`;
  try {
    const config = getRelayerConfig();
    rpcUrl = config.rpcUrl;
    address = privateKeyToAccount(config.privateKey as `0x${string}`).address;
  } catch (err) {
    log(
      `config_error=${err instanceof RelayerConfigError ? err.reason : "unknown"}`
    );
    log("RESULT: FAIL — relayer configuration incomplete; nothing was queried.");
    return 1;
  }
  log(`relayer_address=${address}`);
  // URL SHAPE diagnostics only — the host, path and credentials are NEVER
  // printed. These booleans catch the common misconfigurations (missing
  // scheme, embedded quotes, missing API-key query parameter).
  try {
    const parsedUrl = new URL(rpcUrl);
    const queryParams = [...parsedUrl.searchParams.keys()];
    log(
      `rpc_url_shape scheme=${parsedUrl.protocol.replace(":", "")}` +
        ` has_userinfo=${parsedUrl.username !== "" || parsedUrl.password !== ""}` +
        ` query_params=${queryParams.length > 0 ? queryParams.join(",") : "none"}`
    );
  } catch {
    log("rpc_url_shape=INVALID — CELO_RPC_URL is not a parsable absolute URL");
  }

  // READ-ONLY client: no signing capability exists on this object.
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });

  // 1. What chain is this endpoint actually serving?
  let chainId: number;
  const startedAt = Date.now();
  try {
    chainId = await publicClient.getChainId();
    log(`configured_endpoint_latency_ms=${Date.now() - startedAt}`);
  } catch (err) {
    // Only the error NAME / HTTP STATUS / timing are reported — never the
    // message, which may embed the URL (possibly with credentials).
    const status = (err as { status?: unknown } | null)?.status;
    const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    const name = err instanceof Error ? err.name : "unknown";
    log(
      `rpc_error=chain_id_unreachable name=${name}` +
        `${typeof status === "number" ? ` http_status=${status}` : ""}` +
        `${typeof causeCode === "string" ? ` cause_code=${causeCode}` : ""}`
    );
    log(`configured_endpoint_failed_after_ms=${Date.now() - startedAt}`);
    // Diagnostic hint (no URLs printed): can this machine reach the project's
    // documented public mainnet endpoint at all? Distinguishes a bad/credentialed
    // CONFIGURED endpoint from a general network problem.
    try {
      const probe = createPublicClient({
        chain: celo,
        transport: http("https://forno.celo.org", { timeout: 15_000 }),
      });
      const probeChainId = await probe.getChainId();
      log(`public_endpoint_probe=ok rpc_chain_id=${probeChainId}`);
    } catch {
      log("public_endpoint_probe=failed");
    }
    log(
      "RESULT: FAIL — the CONFIGURED RPC is not reachable; balances not read."
    );
    return 1;
  }
  log(`rpc_chain_id=${chainId} expected=${RELAYER_CHAIN_ID} match=${chainId === RELAYER_CHAIN_ID}`);
  log("rpc_endpoint=reachable (URL not printed)");
  if (chainId !== RELAYER_CHAIN_ID) {
    log("RESULT: FAIL — the RPC does NOT serve Celo Mainnet; balances not read.");
    return 1;
  }

  // 2. Native CELO balance (the gas asset for settlement broadcasts).
  let weiBalance: bigint;
  try {
    weiBalance = await publicClient.getBalance({ address });
  } catch {
    log("rpc_error=native_balance_unreadable");
    log("RESULT: FAIL — native balance could not be read.");
    return 1;
  }
  log(`celo_balance_baseunits=${weiBalance.toString()}`);
  log(`celo_balance=${formatUnits(weiBalance, 18)} CELO`);

  // 3. Whitelisted cUSD balance; decimals come from the token contract.
  const token = SETTLEMENT_TOKEN_WHITELIST[RELAYER_CHAIN_ID][0] as `0x${string}`;
  let decimals: number;
  let tokenBalance: bigint;
  try {
    decimals = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
    tokenBalance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  } catch {
    log("rpc_error=cusd_balance_unreadable");
    log("RESULT: FAIL — the whitelisted token balance could not be read.");
    return 1;
  }
  log(`cusd_token=${token} decimals=${decimals}`);
  log(`cusd_balance_baseunits=${tokenBalance.toString()}`);
  log(`cusd_balance=${formatUnits(tokenBalance, decimals)} cUSD`);

  log(
    "RESULT: PASS — the RPC serves Celo Mainnet (42220); balances read read-only."
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`unexpected_error name=${err instanceof Error ? err.name : "unknown"}`);
    process.exit(1);
  });