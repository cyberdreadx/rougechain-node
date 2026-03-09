import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { Footer } from "@/components/Footer";
import Index from "./pages/Index";
import Blockchain from "./pages/Blockchain";
import Messenger from "./pages/Messenger";
import Wallet from "./pages/Wallet";
import Validators from "./pages/Validators";
import Node from "./pages/Node";
import Transactions from "./pages/Transactions";
import Swap from "./pages/Swap";
import Pools from "./pages/Pools";
import PoolDetail from "./pages/PoolDetail";
import TokenExplorer from "./pages/TokenExplorer";
import Bridge from "./pages/Bridge";
import Mail from "./pages/Mail";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Scroll to top on route change
function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    // Don't scroll to top on messenger route (it manages its own scroll)
    if (pathname !== '/messenger' && pathname !== '/mail') {
      window.scrollTo(0, 0);
    }
  }, [pathname]);

  return null;
}

// Hide footer on fullscreen pages like messenger
function ConditionalFooter() {
  const { pathname } = useLocation();
  if (pathname === '/messenger' || pathname === '/mail') return null;
  return <Footer />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <ScrollToTop />
        <div className="min-h-screen flex flex-col">
          <Sidebar>
            <div className="flex-1">
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/blockchain" element={<Blockchain />} />
                <Route path="/messenger" element={<Messenger />} />
                <Route path="/wallet" element={<Wallet />} />
                <Route path="/validators" element={<Validators />} />
                <Route path="/node" element={<Node />} />
                <Route path="/transactions" element={<Transactions />} />
                <Route path="/swap" element={<Swap />} />
                <Route path="/pools" element={<Pools />} />
                <Route path="/pool/:poolId" element={<PoolDetail />} />
                <Route path="/token/:symbol" element={<TokenExplorer />} />
                <Route path="/bridge" element={<Bridge />} />
                <Route path="/mail" element={<Mail />} />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </div>
            <ConditionalFooter />
          </Sidebar>
        </div>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
