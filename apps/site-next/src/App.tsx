import "./wallet/wallet.css";
import WorkspacePage from "./WorkspacePage";
import Architecture from "./Architecture";
import { featureRoutes, featureHeaderProduct } from "./features";
import { explorerRoutes, isExplorerPath } from "./explorer/routes";
import { ExplorerSlotsProvider, type ExplorerSlots } from "./explorer/slots";
import { ChainProvider } from "./explorer/chain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NetworkProvider } from "./Network";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import DesignSystem from "./DesignSystem";
import Home from "./Home";
import { MarketingHeader, AppHeader, WorkspaceHeader, Footer } from "./Shell";
import { WalletProvider } from "./wallet/WalletProvider";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { UiText } from "./i18n/UiText";
// Wallet pages load on demand (Base / viem, QR and the dialogs stay out of the landing bundle).
const WalletPage = lazy(() => import("./wallet/WalletPage"));
const SettingsPage = lazy(() => import("./wallet/SettingsPage"));
// Wallet actions on explorer pages (the creator's "Mint" on a token page). The standalone explorer
// site provides no slots, so it carries no signing code.
const explorerSlots: ExplorerSlots = {
  TokenActions: lazy(() => import("./wallet/MintTokenDialog").then((m) => ({ default: m.ExplorerTokenMintAction }))),
};
function PageFallback() {
  const { t } = useTranslation("common");
  return (
    <main id="main" className="app-main">
      <div className="container">
        <p className="muted">{t("loading")}</p>
      </div>
    </main>
  );
}

import { IncomingTransferWatcher } from "./wallet/IncomingTransferWatcher";
import { TourHost } from "./wallet/TourHost";
import { SecureWalletGate } from "./wallet/SecureWalletGate";
import { Toaster } from "./wallet/toast";
const queryClient = new QueryClient();
export const WALLET_PATHS = ["/wallet", "/settings"];
function Header() {
  const { pathname } = useLocation();
  if (pathname === "/workspace") return <WorkspaceHeader />;
  if (WALLET_PATHS.includes(pathname)) return <AppHeader product="Wallet" />;
  if (isExplorerPath(pathname)) return <AppHeader product="Explorer" />;
  const product = featureHeaderProduct(pathname);
  return product ? <AppHeader product={product} /> : <MarketingHeader />;
}
export default function App() {
  const { t } = useTranslation("common");
  return (
    <QueryClientProvider client={queryClient}>
      <ChainProvider>
        <WalletProvider>
          <NetworkProvider>
            <BrowserRouter>
              <UiText>
                <a className="skip" href="#main">
                  {t("skipToContent")}
                </a>
                <Header />
                {/* Background UI: may wait for its namespace without blanking the page. */}
                <Suspense fallback={null}>
                  <IncomingTransferWatcher />
                  <TourHost />
                </Suspense>
                {/* Pages load their locale namespace on first visit (explorer, pages, …). */}
                <Suspense fallback={<PageFallback />}>
                  {/* A wallet whose keys no password protects must be secured before any page is used. */}
                  <SecureWalletGate>
                    <ExplorerSlotsProvider value={explorerSlots}>
                    <Routes>
                      <Route path="/" element={<Home />} />
                      <Route path="/workspace" element={<WorkspacePage />} />
                      {explorerRoutes}
                      {/* Feature areas (swap, bridge, messenger/mail, validators & pages): src/features/ */}
                      {featureRoutes}
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
                            <h1>{t("notFound.title")}</h1>
                            <p>{t("notFound.body")}</p>
                            <a className="button" href="/">
                              {t("notFound.home")}
                            </a>
                          </main>
                        }
                      />
                    </Routes>
                    </ExplorerSlotsProvider>
                  </SecureWalletGate>
                </Suspense>
                <Footer />
                <Suspense fallback={null}>
                  <Toaster />
                </Suspense>
              </UiText>
            </BrowserRouter>
          </NetworkProvider>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>
  );
}
