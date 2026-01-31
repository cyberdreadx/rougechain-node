import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useLocation } from "react-router-dom";
import { 
  Home, 
  Wallet, 
  MessageSquare, 
  Globe2,
  Shield, 
  Network,
  Activity,
  Menu,
  X,
  BookOpen,
  ExternalLink,
  ArrowLeftRight,
  Droplets,
} from "lucide-react";
import xrgeLogo from "@/assets/xrge-logo.webp";
import { getActiveNetwork, getNetworkLabel, getCoreApiBaseUrl, getCoreApiHeaders, NETWORK_STORAGE_KEY } from "@/lib/network";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Home", icon: Home },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/swap", label: "Swap", icon: ArrowLeftRight },
  { to: "/pools", label: "Pools", icon: Droplets },
  { to: "/blockchain", label: "Blockchain", icon: Globe2 },
  { to: "/messenger", label: "Messenger", icon: MessageSquare },
  { to: "/transactions", label: "Tx Feed", icon: Activity },
  { to: "/validators", label: "Validators", icon: Shield },
  { to: "/node", label: "Core Node", icon: Network },
];

interface SidebarProps {
  children: React.ReactNode;
}

export function Sidebar({ children }: SidebarProps) {
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [chainId, setChainId] = useState<string | null>(null);
  const [networkLabel, setNetworkLabel] = useState<string>(() => getNetworkLabel());

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const updateFromSelection = () => {
      setNetworkLabel(getNetworkLabel(chainId ?? undefined));
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === NETWORK_STORAGE_KEY) {
        updateFromSelection();
        void fetchChainId();
      }
    };

    const fetchChainId = async () => {
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) {
          return;
        }
        const response = await fetch(`${apiBase}/stats`, {
          headers: getCoreApiHeaders(),
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { chain_id?: string; chainId?: string } | null;
        const detected = data?.chain_id || data?.chainId;
        if (detected) {
          setChainId(detected);
          setNetworkLabel(getNetworkLabel(detected));
        }
      } catch {
        updateFromSelection();
      }
    };

    updateFromSelection();
    void fetchChainId();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [chainId]);

  const SidebarContent = ({ isMobile = false }: { isMobile?: boolean }) => (
    <>
      {/* Logo Section */}
      <div className="flex items-center gap-3 p-4 border-b border-border">
        <img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full flex-shrink-0" />
        <div className={cn(
          "overflow-hidden transition-all duration-300",
          (expanded || isMobile) ? "opacity-100 w-auto" : "opacity-0 w-0"
        )}>
          <span className="font-bold text-lg whitespace-nowrap">RougeChain</span>
        </div>
        {isMobile && (
          <button 
            onClick={() => setMobileOpen(false)}
            className="ml-auto p-2 rounded-lg hover:bg-muted"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Network Badge */}
      <div className={cn(
        "px-3 py-2 border-b border-border transition-all duration-300",
        (expanded || isMobile) ? "opacity-100 h-auto" : "opacity-0 h-0 py-0 overflow-hidden"
      )}>
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-card border border-border text-xs">
          <span className={`h-2 w-2 rounded-full flex-shrink-0 ${getActiveNetwork() === "mainnet" ? "bg-success" : "bg-amber-500"}`} />
          <span className="font-medium text-foreground truncate">{networkLabel}</span>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.to;
          const Icon = item.icon;
          
          return (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => isMobile && setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive 
                  ? "bg-primary/10 text-primary" 
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              <span className={cn(
                "whitespace-nowrap overflow-hidden transition-all duration-300",
                (expanded || isMobile) ? "opacity-100 w-auto" : "opacity-0 w-0"
              )}>
                {item.label}
              </span>
            </NavLink>
          );
        })}
        
        {/* External Docs Link */}
        <a
          href="https://ai-integrations.gitbook.io/rougechain-post-quantum/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <BookOpen className="w-5 h-5 flex-shrink-0" />
          <span className={cn(
            "whitespace-nowrap overflow-hidden transition-all duration-300 flex items-center gap-1",
            (expanded || isMobile) ? "opacity-100 w-auto" : "opacity-0 w-0"
          )}>
            Docs
            <ExternalLink className="w-3 h-3 opacity-50" />
          </span>
        </a>
      </nav>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 z-50 md:hidden bg-background border-b border-border px-4 py-3 flex items-center gap-3">
        <button 
          onClick={() => setMobileOpen(true)}
          className="p-2 rounded-lg hover:bg-muted"
        >
          <Menu className="w-5 h-5" />
        </button>
        <img src={xrgeLogo} alt="XRGE" className="w-7 h-7 rounded-full" />
        <span className="font-bold">RougeChain</span>
        <div className="ml-auto flex items-center gap-2 px-2 py-1 rounded-full bg-card border border-border text-xs">
          <span className={`h-2 w-2 rounded-full ${getActiveNetwork() === "mainnet" ? "bg-success" : "bg-amber-500"}`} />
          <span className="font-medium">{networkLabel}</span>
        </div>
      </div>

      {/* Mobile Sidebar Overlay */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 z-50 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside className={cn(
        "fixed left-0 top-0 z-50 h-screen w-64 bg-background border-r border-border flex flex-col transition-transform duration-300 md:hidden",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <SidebarContent isMobile />
      </aside>

      {/* Desktop Sidebar */}
      <aside 
        className={cn(
          "fixed left-0 top-0 z-40 h-screen bg-background border-r border-border flex-col transition-all duration-300 ease-in-out hidden md:flex",
          expanded ? "w-52" : "w-16"
        )}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
      >
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <main className="flex-1 md:ml-16 mt-14 md:mt-0">
        {children}
      </main>
    </div>
  );
}
