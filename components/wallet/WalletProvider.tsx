"use client";

/**
 * CeloTasker — wallet session context (Step 1).
 *
 * Wraps the REAL backend auth flow. This layer:
 * - detects an injected wallet (MiniPay included) — WalletConnect is deferred;
 * - restores an existing server session on load;
 * - signs in by personal_sign of the server-built SIWE message;
 * - reads the requester's cUSD balance client-side with viem.
 *
 * It never holds a session token (HttpOnly cookie), never signs anything but
 * the auth message, and can never broadcast a transaction.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPublicClient, custom, erc20Abi, http } from "viem";
import { celo } from "viem/chains";
import { CUSD_ADDRESS, PUBLIC_RPC_URL } from "@/lib/celo";
import { fetchSession, signInWithWallet, signOut } from "@/lib/auth/client";
import {
  CELO_CHAIN_ID,
  ensureCeloChain,
  getAccounts,
  getChainId,
  getInjectedProvider,
  personalSign,
  requestAccounts,
  walletKind,
  walletName,
  type Eip1193Provider,
  type WalletKind,
} from "@/lib/wallet/eip1193";

export type WalletStatus =
  | "detecting"
  /** No injected provider in this browser (open in MiniPay or install one). */
  | "unavailable"
  /** Provider present, no server session yet. */
  | "disconnected"
  /** Awaiting the wallet prompt / signature. */
  | "connecting"
  /** Server-verified session. */
  | "authenticated";

export interface WalletContextValue {
  status: WalletStatus;
  kind: WalletKind;
  /** Human name for honest copy ("MiniPay", "Browser wallet"). */
  providerLabel: string | null;
  /** Wallet account, as the wallet reports it. */
  address: string | null;
  /** Server-verified session address (authoritative for the backend). */
  sessionAddress: string | null;
  chainId: number | null;
  /** True while the wallet is on Celo Mainnet. */
  onCelo: boolean;
  cusdBalance: bigint | null;
  cusdDecimals: number;
  balanceError: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  clearError: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const CUSD_DECIMALS_FALLBACK = 18;

/** Quiet, human copy for wallet errors — never a raw provider object. */
function walletErrorMessage(err: unknown): string {
  const code =
    typeof err === "object" && err !== null
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === 4001) return "Signature declined in the wallet.";
  if (code === 4902) return "Celo Mainnet is not available in this wallet.";
  if (code === -32002) return "Open your wallet to finish the request.";
  return "Wallet connection failed. Try again.";
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [status, setStatus] = useState<WalletStatus>("detecting");
  const [address, setAddress] = useState<string | null>(null);
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [cusdBalance, setCusdBalance] = useState<bigint | null>(null);
  const [cusdDecimals, setCusdDecimals] = useState<number>(CUSD_DECIMALS_FALLBACK);
  const [balanceError, setBalanceError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decimalsLoaded = useRef(false);
  const walletRevision = useRef(0);
  const connecting = useRef(false);

  useEffect(() => {
    const injected = getInjectedProvider();
    setProvider(injected);
    if (!injected) setStatus("unavailable");
  }, []);

  useEffect(() => {
    if (!provider) return;
    let disposed = false;

    const synchronize = async () => {
      const revision = ++walletRevision.current;
      // Account authorization and network switching can emit events while
      // Connect is running; it verifies the final account/chain itself.
      if (connecting.current) return;
      setSessionAddress(null);
      setCusdBalance(null);
      setBalanceError(false);
      setStatus("disconnected");
      try {
        const [accounts, currentChain, session] = await Promise.all([
          getAccounts(provider),
          getChainId(provider),
          fetchSession(),
        ]);
        if (disposed || revision !== walletRevision.current) return;
        const account = accounts[0] ?? null;
        setAddress(account);
        setChainId(currentChain);
        if (currentChain !== CELO_CHAIN_ID) {
          setError("Switch your wallet to Celo Mainnet to continue.");
          return;
        }
        setError(null);
        if (account && session?.address.toLowerCase() === account.toLowerCase()) {
          setSessionAddress(session.address);
          setStatus("authenticated");
        }
      } catch (err) {
        if (disposed || revision !== walletRevision.current) return;
        setAddress(null);
        setChainId(null);
        setError(walletErrorMessage(err));
      }
    };

    const onWalletChange = () => { void synchronize(); };
    provider.on?.("accountsChanged", onWalletChange);
    provider.on?.("chainChanged", onWalletChange);
    void synchronize();
    return () => {
      disposed = true;
      ++walletRevision.current;
      provider.removeListener?.("accountsChanged", onWalletChange);
      provider.removeListener?.("chainChanged", onWalletChange);
    };
  }, [provider]);

  const readClient = useCallback(
    (current: Eip1193Provider | null) =>
      createPublicClient({
        chain: celo,
        transport: current ? custom(current) : http(PUBLIC_RPC_URL),
      }),
    []
  );

  const refreshBalance = useCallback(
    async (forAddress?: string | null) => {
      const holder = forAddress ?? sessionAddress ?? address;
      const revision = walletRevision.current;
      if (!holder || chainId !== CELO_CHAIN_ID) {
        setCusdBalance(null);
        return;
      }
      try {
        const client = readClient(provider);
        if (!decimalsLoaded.current) {
          const decimals = await client.readContract({
            address: CUSD_ADDRESS,
            abi: erc20Abi,
            functionName: "decimals",
          });
          if (revision !== walletRevision.current) return;
          setCusdDecimals(Number(decimals));
          decimalsLoaded.current = true;
        }
        const balance = await client.readContract({
          address: CUSD_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [holder as `0x${string}`],
        });
        if (revision !== walletRevision.current) return;
        setCusdBalance(balance);
        setBalanceError(false);
      } catch {
        if (revision !== walletRevision.current) return;
        // A read-only RPC failure is not fatal: show an honest dash instead.
        setCusdBalance(null);
        setBalanceError(true);
      }
    },
    [address, chainId, provider, readClient, sessionAddress]
  );

  useEffect(() => {
    if (status === "authenticated") void refreshBalance();
  }, [status, refreshBalance]);

  const connect = useCallback(async () => {
    if (connecting.current) return;
    setError(null);
    const injected = provider ?? getInjectedProvider();
    if (!injected) {
      setStatus("unavailable");
      setError("No wallet detected. Open CeloTasker in MiniPay or install a wallet.");
      return;
    }
    connecting.current = true;
    ++walletRevision.current;
    setProvider(injected);
    setSessionAddress(null);
    setCusdBalance(null);
    setBalanceError(false);
    setStatus("connecting");
    try {
      const accounts = await requestAccounts(injected);
      const account = accounts[0];
      if (!account) {
        setAddress(null);
        setStatus("disconnected");
        setError("No account was shared by the wallet.");
        return;
      }
      setAddress(account);

      const confirmedChain = await ensureCeloChain(injected);
      setChainId(confirmedChain);
      if (confirmedChain !== CELO_CHAIN_ID) {
        setStatus("disconnected");
        setError("Switch your wallet to Celo Mainnet to continue.");
        return;
      }

      const revision = walletRevision.current;
      const verified = await signInWithWallet(account, (message) =>
        personalSign(injected, message, account)
      );
      const [currentAccounts, currentChain] = await Promise.all([
        getAccounts(injected),
        getChainId(injected),
      ]);
      setAddress(currentAccounts[0] ?? null);
      setChainId(currentChain);
      if (
        revision !== walletRevision.current ||
        currentChain !== CELO_CHAIN_ID ||
        currentAccounts[0]?.toLowerCase() !== account.toLowerCase() ||
        verified.toLowerCase() !== account.toLowerCase()
      ) {
        throw new Error("wallet_changed_during_sign_in");
      }
      setSessionAddress(verified);
      setStatus("authenticated");
    } catch (err) {
      setSessionAddress(null);
      setStatus("disconnected");
      setError(walletErrorMessage(err));
    } finally {
      connecting.current = false;
    }
  }, [provider]);

  const disconnect = useCallback(async () => {
    ++walletRevision.current;
    setError(null);
    setSessionAddress(null);
    setCusdBalance(null);
    setStatus(provider ? "disconnected" : "unavailable");
    try {
      await signOut();
    } catch {
      setError("Could not sign out on the server. Please try again.");
    }
  }, [provider]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      kind: walletKind(provider),
      providerLabel: walletName(walletKind(provider)),
      address,
      sessionAddress,
      chainId,
      onCelo: chainId === CELO_CHAIN_ID,
      cusdBalance,
      cusdDecimals,
      balanceError,
      error,
      connect,
      disconnect,
      refreshBalance: () => refreshBalance(),
      clearError: () => setError(null),
    }),
    [
      address,
      balanceError,
      chainId,
      connect,
      cusdBalance,
      cusdDecimals,
      disconnect,
      error,
      provider,
      refreshBalance,
      sessionAddress,
      status,
    ]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) {
    throw new Error("useWallet must be used inside <WalletProvider>");
  }
  return value;
}