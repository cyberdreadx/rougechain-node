import WorkspacePage from "./WorkspacePage";
import Architecture from "./Architecture";
import SwapSections from "./SwapSections";
import Swap from "./Swap";
import { explorerRoutes, isExplorerPath } from "./explorer/routes";
import { ChainProvider } from "./explorer/chain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NetworkProvider } from "./Network";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import DesignSystem from "./DesignSystem";
import Home from "./Home";
import { MarketingHeader, AppHeader, WorkspaceHeader, Footer } from "./Shell";
import { WalletProvider } from "./wallet/WalletProvider";
import { lazy, Suspense } from "react";
// Wallet pages load on demand (Base / viem, QR and the dialogs stay out of the landing bundle).
const WalletPage = lazy(() => import("./wallet/WalletPage"));
const SettingsPage = lazy(() => import("./wallet/SettingsPage"));
function PageFallback() {
  return (
    <main id="main" className="app-main">
      <div className="container">
        <p className="muted">Loading…</p>
      </div>
    </main>
  );
}
import { IncomingTransferWatcher } from "./wallet/IncomingTransferWatcher";
import { TourHost } from "./wallet/TourHost";
import { Toaster } from "./wallet/toast";
const queryClient = new QueryClient();
export const WALLET_PATHS = ["/wallet", "/settings"];
function Header() {
  const { pathname } = useLocation();
  if (pathname === "/workspace") return <WorkspaceHeader />;
  if (WALLET_PATHS.includes(pathname)) return <AppHeader product="Wallet" />;
  const explorer = isExplorerPath(pathname);
  return explorer || pathname.startsWith("/swap") ? (
    <AppHeader product={explorer ? "Explorer" : "Swap"} />
  ) : (
    <MarketingHeader />
  );
}
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChainProvider>
        <WalletProvider>
          <NetworkProvider>
            <BrowserRouter>
              <a className="skip" href="#main">
                Skip to content
              </a>
              <Header />
              <IncomingTransferWatcher />
              <TourHost />
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/workspace" element={<WorkspacePage />} />
                <Route path="/swap" element={<Swap />} />
                <Route
                  path="/swap/pools"
                  element={<SwapSections section="pools" />}
                />
                <Route
                  path="/swap/positions"
                  element={<SwapSections section="positions" />}
                />
                {explorerRoutes}
                <Route
                  path="/wallet"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <WalletPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <SettingsPage />
                    </Suspense>
                  }
                />
                <Route path="/architecture" element={<Architecture />} />
                <Route path="/design-system" element={<DesignSystem />} />
                <Route
                  path="*"
                  element={
                    <main id="main" className="container page-intro">
                      <h1>Page not found.</h1>
                      <p>Use Apps to explore the available review routes.</p>
                      <a className="button" href="/">
                        Return to RougeChain
                      </a>
                    </main>
                  }
                />
              </Routes>
              <Footer />
              <Toaster />
            </BrowserRouter>
          </NetworkProvider>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>
  );
}
