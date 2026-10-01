import { lazy, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useWallet } from "./WalletProvider";

const SecureWallet = lazy(() => import("./SecureWallet"));

/**
 * Blocks every page while the unlocked wallet has private keys that are not protected by a
 * password (store.ts `needsPassword`), until the user sets one. The /wallet page's own create /
 * import steps (recovery phrase → password) are left alone while they run.
 */
export function SecureWalletGate({ children }: { children: ReactNode }) {
  const { needsPassword, flow } = useWallet();
  const { pathname } = useLocation();
  const inSetup = !!flow && (flow.step === "seed" || flow.step === "password") && pathname === "/wallet";
  if (needsPassword && !inSetup) return <SecureWallet />;
  return <>{children}</>;
}
