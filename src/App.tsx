import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Blockchain from "./pages/Blockchain";
import Messenger from "./pages/Messenger";
import Wallet from "./pages/Wallet";
import Validators from "./pages/Validators";
import Node from "./pages/Node";
import Transactions from "./pages/Transactions";
import NotFound from "./pages/NotFound";
const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/blockchain" element={<Blockchain />} />
          <Route path="/messenger" element={<Messenger />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/validators" element={<Validators />} />
          <Route path="/node" element={<Node />} />
          <Route path="/transactions" element={<Transactions />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
