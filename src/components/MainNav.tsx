import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import { 
  Home, 
  Blocks, 
  Wallet, 
  MessageSquare, 
  Shield, 
  Network 
} from "lucide-react";
import xrgeLogo from "@/assets/xrge-logo.webp";

const navItems = [
  { to: "/", label: "Home", icon: Home },
  { to: "/blockchain", label: "Blockchain", icon: Blocks },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/messenger", label: "Messenger", icon: MessageSquare },
  { to: "/validators", label: "Validators", icon: Shield },
  { to: "/node", label: "P2P Node", icon: Network },
];

export function MainNav() {
  const location = useLocation();

  return (
    <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
      <div className="max-w-6xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full" />
            <span className="font-bold text-lg hidden sm:block">RougeChain</span>
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
          </div>
        </div>
      </div>
    </nav>
  );
}
