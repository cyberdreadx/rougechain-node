import { NavLink } from "@/components/NavLink";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { 
  Home, 
  Wallet, 
  MessageSquare, 
  Globe2,
  Shield, 
  Network,
  Activity,
  BookOpen,
  ExternalLink
} from "lucide-react";
import xrgeLogo from "@/assets/xrge-logo.webp";
import { getActiveNetwork, getNetworkLabel, getCoreApiBaseUrl, getCoreApiHeaders, NETWORK_STORAGE_KEY } from "@/lib/network";

const navItems = [
  { to: "/", label: "Home", icon: Home },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/blockchain", label: "Blockchain", icon: Globe2 },
  { to: "/messenger", label: "Messenger", icon: MessageSquare },
  { to: "/transactions", label: "Tx Feed", icon: Activity },
  { to: "/validators", label: "Validators", icon: Shield },
  { to: "/node", label: "Core Node", icon: Network },
];

export function MainNav() {
  const location = useLocation();
  const [chainId, setChainId] = useState<string | null>(null);
  const [networkLabel, setNetworkLabel] = useState<string>(() => getNetworkLabel());

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

  return (
    <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
      <div className="max-w-6xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full" />
            <span className="font-bold text-lg hidden sm:block">RougeChain</span>
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-full bg-card border border-border text-xs text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${getActiveNetwork() === "mainnet" ? "bg-success" : "bg-amber-500"}`} />
              <span className="font-medium text-foreground">{networkLabel}</span>
              {chainId && <span className="text-muted-foreground">·</span>}
              {chainId && <span className="font-mono text-[10px]">{chainId}</span>}
            </div>
          </div>

          {/* Navigation Links */}
          <div className="flex items-center gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const isActive = location.pathname === item.to;
              const Icon = item.icon;
              
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                    isActive 
                      ? "bg-primary/10 text-primary" 
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                  activeClassName="bg-primary/10 text-primary"
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden md:inline">{item.label}</span>
                </NavLink>
              );
            })}
            
            {/* External Docs Link */}
            <a
              href="https://ai-integrations.gitbook.io/rougechain-post-quantum/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <BookOpen className="w-4 h-4" />
              <span className="hidden md:inline">Docs</span>
              <ExternalLink className="w-3 h-3 opacity-50" />
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}
