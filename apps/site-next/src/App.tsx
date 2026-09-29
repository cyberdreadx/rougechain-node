import { DemoWalletProvider } from "./wallet/DemoWalletProvider";
import WorkspacePage from "./WorkspacePage";
import Architecture from "./Architecture";
import SwapSections from "./SwapSections";
import Swap from "./Swap";
import Explorer from "./Explorer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NetworkProvider } from "./Network";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import DesignSystem from "./DesignSystem";
import Home from "./Home";
import { MarketingHeader, AppHeader, WorkspaceHeader, Footer } from "./Shell";
const queryClient = new QueryClient();
function Header() {
  const { pathname } = useLocation();
  if (pathname === "/workspace") return <WorkspaceHeader />;
  return pathname.startsWith("/explorer") || pathname.startsWith("/swap") ? (
    <AppHeader
      product={pathname.startsWith("/explorer") ? "Explorer" : "Swap"}
    />
  ) : (
    <MarketingHeader />
  );
}
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DemoWalletProvider>
        <NetworkProvider>
          <BrowserRouter>
            <a className="skip" href="#main">
              Skip to content
            </a>
            <Header />
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
              <Route path="/explorer" element={<Explorer />} />
              {["blocks", "transactions", "tokens", "nfts", "contracts"].map(
                (section) => (
                  <Route
                    key={section}
                    path={`/explorer/${section}`}
                    element={<Explorer section={section} />}
                  />
                ),
              )}
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
          </BrowserRouter>
        </NetworkProvider>
      </DemoWalletProvider>
    </QueryClientProvider>
  );
}
