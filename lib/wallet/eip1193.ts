/**
 * CeloTasker — thin EIP-1193 wallet layer (Step 1).
 *
 * Scope (per product decision): INJECTED wallets + MiniPay detection only.
 * WalletConnect is deliberately deferred. No wallet SDK, no duplicate
 * settlement logic — this layer only talks to the browser provider and the
 * wallet, and signs ONLY the SIWE-style authentication message.
 *
 * All transactions remain server-side (Approve & Relay); nothing here can
 * broadcast anything.
 */

/** Minimal EIP-1193 provider surface actually used by the product. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(eventName: string, listener: (...args: unknown[]) => void): void;
  removeListener?(eventName: string, listener: (...args: unknown[]) => void): void;
  /** MiniPay flags itself on the injected provider. */
  isMiniPay?: boolean;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/** Celo Mainnet — the only chain this product operates on. */
export const CELO_CHAIN_ID = 42220;
export const CELO_CHAIN_ID_HEX = "0xa4ec";

export type WalletKind = "minipay" | "injected" | null;

/** Locate the injected browser provider (MiniPay included). Null when absent. */
export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

export function walletKind(provider: Eip1193Provider | null): WalletKind {
  if (!provider) return null;
  return provider.isMiniPay ? "minipay" : "injected";
}

/** Human-facing wallet name for quiet, honest UI copy. */
export function walletName(kind: WalletKind): string | null {
  if (kind === "minipay") return "MiniPay";
  if (kind === "injected") return "Browser wallet";
  return null;
}

/** The chain the wallet is currently on (number). */
export async function getChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * Ensure the wallet is on Celo Mainnet, switching when needed. Returns the
 * confirmed chain id. Rejects with the provider's error when the user declines
 * or the wallet cannot switch.
 */
export async function ensureCeloChain(provider: Eip1193Provider): Promise<number> {
  const chainId = await getChainId(provider);
  if (chainId === CELO_CHAIN_ID) return chainId;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CELO_CHAIN_ID_HEX }],
    });
  } catch (err) {
    // 4902 = chain not added to the wallet. We do NOT invent a chain entry —
    // surface the failure; MiniPay and major injected wallets ship Celo.
    throw err instanceof Error ? err : new Error("wallet_chain_switch_failed");
  }
  const confirmed = await getChainId(provider);
  return confirmed;
}

/** Request account authorization (prompts when not yet connected). */
export async function requestAccounts(provider: Eip1193Provider): Promise<string[]> {
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  return Array.isArray(accounts) ? accounts : [];
}

/** Silent account probe (no prompt) for restoring an existing connection. */
export async function getAccounts(provider: Eip1193Provider): Promise<string[]> {
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  return Array.isArray(accounts) ? accounts : [];
}

/**
 * Sign the server-generated SIWE-style message with personal_sign. The UTF-8
 * message is hex-encoded first (the most portable encoding across injected
 * wallets and MiniPay).
 */
export async function personalSign(
  provider: Eip1193Provider,
  message: string,
  address: string
): Promise<string> {
  const { stringToHex } = await import("viem");
  const signature = (await provider.request({
    method: "personal_sign",
    params: [stringToHex(message), address],
  })) as string;
  return signature;
}