"use client";

/**
 * CeloTasker — application shell (Step 1).
 *
 * One header: the product mark (home), the three real sections, and the wallet
 * control. Navigation is a disclosure of the actual routes — nothing here shows
 * a balance, a task or an activity entry it does not have.
 *
 * The wallet notice region is the single place wallet/session errors surface, so
 * a declined signature is never silent.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { TaskRelayLogo } from "@/components/brand/TaskRelayMark";
import { Button } from "@/components/ui/Button";
import { WalletControl } from "@/components/wallet/WalletControl";
import { useWallet } from "@/components/wallet/WalletProvider";

const NAV = [
  { href: "/tasks", label: "Tasks" },
  { href: "/my-work", label: "My Work" },
  { href: "/activity", label: "Activity" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const wallet = useWallet();

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur-[3px]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-7 gap-y-1.5 px-5 py-2.5 sm:px-7">
          <Link
            href="/"
            aria-label="CeloTasker — home"
            className="mr-auto flex items-center rounded-control py-1"
          >
            <TaskRelayLogo className="inline-flex items-center gap-2.5" />
          </Link>

          <div className="order-2 sm:order-3">
            <WalletControl />
          </div>

          <nav aria-label="Sections" className="order-3 -ml-1 w-full sm:order-2 sm:ml-0 sm:w-auto">
            <ul className="flex items-center gap-5">
              {NAV.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href} className="flex">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={
                        "flex h-8 items-center border-b-2 text-[14px] transition-colors duration-150 " +
                        (active
                          ? "border-celo font-medium text-ink"
                          : "border-transparent text-ink-soft hover:border-line-strong hover:text-ink")
                      }
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </header>

      {wallet.error && (
        <div className="border-b border-warn/25 bg-warn-wash">
          <div className="mx-auto flex w-full max-w-[1120px] items-start justify-between gap-4 px-5 py-2.5 sm:px-7">
            <p className="text-[13.5px] leading-relaxed text-ink">
              {wallet.error}
            </p>
            <Button variant="quiet" size="sm" onClick={wallet.clearError}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1120px] flex-1 px-5 py-8 sm:px-7 sm:py-10">
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-2 px-5 py-5 sm:px-7">
          <p className="text-[12.5px] text-ink-faint">
            Rewards are paid in cUSD. Payments settle on Celo Mainnet.
          </p>
          <p className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-ink-faint">
            Celo 42220
          </p>
        </div>
      </footer>
    </div>
  );
}
