import { motion } from "framer-motion";
import { Shield, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface WalletCardProps {
  address: string;
  balance: string;
  usdValue: string;
}

const WalletCard = ({ address, balance, usdValue }: WalletCardProps) => {
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const truncatedAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-2xl bg-card p-6 glow-quantum"
    >
      {/* Background circuit pattern */}
      <div className="absolute inset-0 circuit-bg opacity-30" />
      
      {/* Quantum security badge */}
      <div className="relative flex items-center gap-2 mb-6">
        <motion.div
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/30"
        >
          <Shield className="w-4 h-4 text-primary" />
          <span className="text-xs font-medium text-primary">PQC Protected</span>
        </motion.div>
        <span className="text-xs text-muted-foreground">CRYSTALS-Dilithium</span>
      </div>

      {/* Balance display */}
      <div className="relative mb-6">
        <p className="text-sm text-muted-foreground mb-1">Total Balance</p>
        <motion.h2
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className="text-4xl font-bold text-gradient-quantum"
        >
          {balance} ETH
        </motion.h2>
        <p className="text-lg text-muted-foreground mt-1">≈ ${usdValue} USD</p>
      </div>

      {/* Address section */}
      <div className="relative flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-border">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground mb-0.5">Wallet Address</p>
          <p className="font-mono text-sm text-foreground">{truncatedAddress}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={copyAddress}
          className="h-8 w-8 text-muted-foreground hover:text-primary"
        >
          <Copy className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-primary"
        >
          <ExternalLink className="w-4 h-4" />
        </Button>
      </div>

      {copied && (
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="absolute bottom-2 right-2 text-xs text-primary"
        >
          Copied!
        </motion.p>
      )}

      {/* Decorative elements */}
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-primary/10 rounded-full blur-3xl" />
      <div className="absolute -bottom-20 -left-20 w-40 h-40 bg-accent/10 rounded-full blur-3xl" />
    </motion.div>
  );
};

export default WalletCard;
