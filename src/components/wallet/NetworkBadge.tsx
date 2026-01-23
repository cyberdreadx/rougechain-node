import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check } from "lucide-react";

export type NetworkType = "testnet" | "mainnet";

interface NetworkConfig {
  id: NetworkType;
  name: string;
  chainName: string;
  color: string;
  dotColor: string;
}

const networks: NetworkConfig[] = [
  {
    id: "testnet",
    name: "Testnet",
    chainName: "RougeChain Testnet",
    color: "text-amber-500",
    dotColor: "bg-amber-500",
  },
  {
    id: "mainnet",
    name: "Mainnet",
    chainName: "RougeChain",
    color: "text-success",
    dotColor: "bg-success",
  },
];

const NETWORK_STORAGE_KEY = "rougechain-network";

interface NetworkBadgeProps {
  isConnected?: boolean;
  blockNumber?: number;
  onNetworkChange?: (network: NetworkType) => void;
}

const NetworkBadge = ({ isConnected = true, blockNumber, onNetworkChange }: NetworkBadgeProps) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentNetwork, setCurrentNetwork] = useState<NetworkType>("testnet");

  // Load saved network preference
  useEffect(() => {
    const saved = localStorage.getItem(NETWORK_STORAGE_KEY) as NetworkType;
    if (saved && (saved === "testnet" || saved === "mainnet")) {
      setCurrentNetwork(saved);
    }
  }, []);

  const handleNetworkChange = (networkId: NetworkType) => {
    setCurrentNetwork(networkId);
    localStorage.setItem(NETWORK_STORAGE_KEY, networkId);
    setShowDropdown(false);
    onNetworkChange?.(networkId);
  };

  const activeNetwork = networks.find(n => n.id === currentNetwork) || networks[0];

  return (
    <div className="relative">
      <motion.button
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.5 }}
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex items-center gap-2 px-3 py-2 rounded-full bg-card border border-border shadow-lg hover:border-primary/50 transition-colors"
      >
        <div className="relative">
          <div className={`w-3 h-3 rounded-full ${activeNetwork.dotColor}`} />
          {isConnected && (
            <motion.div
              animate={{ scale: [1, 1.5, 1], opacity: [1, 0, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
              className={`absolute inset-0 w-3 h-3 rounded-full ${activeNetwork.dotColor}`}
            />
          )}
        </div>
        <span className={`text-xs font-medium ${activeNetwork.color}`}>
          {activeNetwork.chainName}
        </span>
        {blockNumber && (
          <span className="text-xs text-muted-foreground">#{blockNumber}</span>
        )}
        <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
      </motion.button>

      <AnimatePresence>
        {showDropdown && (
          <>
            {/* Backdrop */}
            <div 
              className="fixed inset-0 z-40" 
              onClick={() => setShowDropdown(false)}
            />
            
            {/* Dropdown */}
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="absolute bottom-full left-0 mb-2 w-56 bg-card rounded-xl border border-border shadow-xl z-50 overflow-hidden"
            >
              <div className="p-2 border-b border-border">
                <p className="text-xs font-medium text-muted-foreground px-2">Select Network</p>
              </div>
              
              <div className="p-1">
                {networks.map((network) => (
                  <button
                    key={network.id}
                    onClick={() => handleNetworkChange(network.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                      currentNetwork === network.id 
                        ? 'bg-secondary' 
                        : 'hover:bg-secondary/50'
                    }`}
                  >
                    <div className={`w-3 h-3 rounded-full ${network.dotColor}`} />
                    <div className="flex-1 text-left">
                      <p className={`text-sm font-medium ${network.color}`}>
                        {network.chainName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {network.id === "testnet" ? "For testing & development" : "Production network"}
                      </p>
                    </div>
                    {currentNetwork === network.id && (
                      <Check className="w-4 h-4 text-primary" />
                    )}
                  </button>
                ))}
              </div>

              {currentNetwork === "mainnet" && (
                <div className="p-2 border-t border-border bg-destructive/5">
                  <p className="text-[10px] text-destructive text-center">
                    ⚠️ Mainnet uses real XRGE tokens
                  </p>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

export default NetworkBadge;
