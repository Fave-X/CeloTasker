"use client";

/**
 * CeloTasker — wallet control (Step 1).
 *
 * The single place the header talks to the wallet. It renders one of five
 * honest states and never shows an address, a balance or a network it does not
 * actually have. Read-only reads (cUSD balance) come from the wallet context;
 * nothing here can sign or broadcast.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useWallet } from "./WalletProvider";
import { CELO_CHAIN_ID } from "@/lib/wallet/eip1193";
import { formatTokenAmount, truncateAddress } from "@/lib/celo";

export function WalletControl() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The panel closes on outside click / Escape — it is a disclosure, not a modal.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // A lost session must never leave a stale panel open.
  useEffect(() => {
    if (!wallet.sessionAddress) setOpen(false);
  }, [wallet.sessionAddress]);

  if (wallet.status === "detecting") {
    return (
      <span className="flex h-10 items-center px-1 text-[13px] text-ink-faint">
        Checking wallet…
      </span>
    );
  }

  const account = wallet.sessionAddress ?? wallet.address;
  const signedIn = wallet.status === "authenticated" && account !== null;

  // Connected but on another chain: one honest action, not a silent fallback.
  if (!signedIn && wallet.address !== null && wallet.chainId !== CELO_CHAIN_ID) {
    return (
      <Button variant="secondary" size="md" onClick={() => void wallet.connect()}>
        Switch to Celo Mainnet
      </Button>
    );
  }

  if (!signedIn) {
    return (
      <Button
        variant="primary"
        size="md"
        onClick={() => void wallet.connect()}
        disabled={wallet.status === "connecting"}
      >
        {wallet.status === "connecting" ? "Check your wallet…" : "Connect wallet"}
      </Button>
    );
  }

  const balanceLabel =
    wallet.balanceError || wallet.cusdBalance === null
      ? "—"
      : formatTokenAmount(wallet.cusdBalance, wallet.cusdDecimals, "cUSD");

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <span className="hidden h-10 items-center rounded-control border border-line bg-paper-sunken px-3 font-mono text-[13px] text-ink sm:flex">
        {balanceLabel}
      </span>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-10 items-center gap-2 rounded-control border border-line-strong bg-paper-raised px-3 transition-colors duration-150 hover:border-ink-faint hover:bg-paper-sunken"
      >
        <span className="font-mono text-[13px] text-ink">
          {truncateAddress(account)}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Wallet details"
          className="absolute right-0 top-12 z-40 w-[302px] rounded-card border border-line bg-paper-raised p-4 shadow-[0_14px_34px_-14px_rgba(25,28,26,0.3)]"
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.09em] text-ink-faint">
            Signed in as
          </p>
          <p className="mt-1.5 break-all font-mono text-[12.5px] leading-relaxed text-ink">
            {account}
          </p>

          <dl className="mt-4 space-y-2.5 border-t border-line pt-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[13px] text-ink-soft">cUSD balance</dt>
              <dd className="font-mono text-[13px] text-ink">{balanceLabel}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[13px] text-ink-soft">Network</dt>
              <dd className="text-[13px] text-ink">
                {wallet.onCelo ? "Celo Mainnet" : "Not Celo Mainnet"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[13px] text-ink-soft">Wallet</dt>
              <dd className="text-[13px] text-ink">{wallet.providerLabel ?? "—"}</dd>
            </div>
          </dl>

          {wallet.balanceError && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-warn">
              The read-only RPC did not return a balance. Your funds are
              unaffected.
            </p>
          )}
          {!wallet.onCelo && (
            <p className="mt-3 text-[12.5px] leading-relaxed text-warn">
              Payments settle on Celo Mainnet only. Switch networks before
              approving anything.
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3.5">
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void wallet.refreshBalance()}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void wallet.disconnect()}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}