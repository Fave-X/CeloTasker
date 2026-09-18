/**
 * CeloTasker — shell layout (Step 1).
 *
 * Every product surface lives under this route group so the header, the wallet
 * control and the page frame exist exactly once. The wallet provider is the
 * outermost client boundary: nothing rendered below it can exist without a
 * wallet session to read from.
 */
import { AppShell } from "@/components/app/AppShell";
import { WalletProvider } from "@/components/wallet/WalletProvider";

export default function ShellLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <WalletProvider>
      <AppShell>{children}</AppShell>
    </WalletProvider>
  );
}
