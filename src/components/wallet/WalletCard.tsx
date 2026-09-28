import { motion } from "framer-motion";
import { Shield, Copy, ExternalLink, Wallet, TrendingUp, TrendingDown, Upload, Puzzle, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { pubkeyToAddress, formatAddress } from "@/lib/address";
import { MASKED_AMOUNT } from "@/hooks/use-hide-balances";

interface WalletCardProps {
  address?: string | null;
  balance?: string | null;
  shieldedBalance?: number;
  usdValue?: string | null;
  priceChange24h?: number | null;
  isConnected?: boolean;
  onConnect?: () => void;
  onImport?: () => void;
  onConnectExtension?: () => void;
  /** Mask the balance / USD figures (privacy toggle). */
  balancesHidden?: boolean;
  onToggleBalancesHidden?: () => void;
  /** Forget this wallet on this device (shown as a small link, away from the main actions). */
  onDisconnect?: () => void;
}

const WalletCard = ({ address, balance, shieldedBalance, usdValue, priceChange24h, isConnected = false, onConnect, onImport, onConnectExtension, balancesHidden = false, onToggleBalancesHidden, onDisconnect }: WalletCardProps) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [extensionDetected, setExtensionDetected] = useState(false);
  const [rougeAddress, setRougeAddress] = useState<string | null>(null);

  useEffect(() => {
    // Check if the RougeChain Wallet extension is installed
    const check = () => setExtensionDetected(!!(window as any).rougechain?.isRougeChain);
    check();
    // The extension fires this event after injecting the provider
    window.addEventListener("rougechain#initialized", check);
    return () => window.removeEventListener("rougechain#initialized", check);
  }, []);

  // Derive rouge1... address from public key
  useEffect(() => {
    if (address) {
      pubkeyToAddress(address).then(setRougeAddress).catch(() => {});
    }
  }, [address]);

  const copyAddress = () => {
    const textToCopy = rougeAddress || address;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const truncatedAddress = rougeAddress
    ? formatAddress(rougeAddress)
    : address
      ? `${address.slice(0, 8)}...${address.slice(-4)}`
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-2xl bg-card p-6 glow-quantum gradient-ring hud-corners"
    >
      {/* Background circuit pattern */}
      <div className="absolute inset-0 circuit-bg opacity-30" />
      
      {/* Quantum security badge */}
      <div className="relative flex items-center gap-2 mb-6">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/30">
          <Shield className="w-4 h-4 text-primary" />
          <span className="text-xs font-medium text-primary">PQC Protected</span>
        </div>
        <span className="text-xs text-muted-foreground">CRYSTALS-Dilithium</span>
      </div>

      {isConnected && address ? (
        <>
          {/* Balance display */}
          <div className="relative mb-6">
            <div className="flex items-center gap-1.5 mb-1">
              <p className="hud-label">Total Balance</p>
              {onToggleBalancesHidden && (
                <button
                  type="button"
                  onClick={onToggleBalancesHidden}
                  aria-pressed={balancesHidden}
                  aria-label={balancesHidden ? t("wallet.balance.show") : t("wallet.balance.hide")}
                  title={balancesHidden ? t("wallet.balance.show") : t("wallet.balance.hide")}
                  className="p-1 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {balancesHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              )}
            </div>
            <motion.h2
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="text-3xl sm:text-4xl font-bold text-shimmer break-all"
            >
              {balancesHidden ? MASKED_AMOUNT : balance || "0"} XRGE
            </motion.h2>
            <div className="flex items-center gap-3 mt-1">
              {usdValue && usdValue !== "N/A" ? (
                <p className="text-lg text-foreground font-medium">{balancesHidden ? `$${MASKED_AMOUNT}` : usdValue}</p>
              ) : (
                <p className="text-lg text-muted-foreground">RougeChain</p>
              )}
              {priceChange24h !== null && priceChange24h !== undefined && (
                <span className={`flex items-center gap-1 text-sm ${priceChange24h >= 0 ? 'text-success' : 'text-destructive'}`}>
                  {priceChange24h >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
                </span>
              )}
            </div>
            {shieldedBalance && shieldedBalance > 0 ? (
              <div className="flex items-center gap-1.5 mt-1">
                <Shield className="w-3.5 h-3.5 text-primary" />
                <span className="text-sm text-primary font-medium">
                  {balancesHidden ? MASKED_AMOUNT : shieldedBalance.toLocaleString()} XRGE shielded
                </span>
              </div>
            ) : null}
          </div>

          {/* Address section */}
          <div className="relative flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-border">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Wallet Address</p>
              <p className="font-mono text-sm text-foreground truncate">{truncatedAddress}</p>
              <div className="mt-1 flex items-center gap-3">
                <button
                  type="button"
                  onClick={copyAddress}
                  className="text-xs text-primary hover:underline"
                >
                  {copied ? "Copied" : "Copy address"}
                </button>
                <a
                  href="/blockchain"
                  className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1"
                >
                  View on chain <ExternalLink className="w-3 h-3" />
                </a>
                {onDisconnect && (
                  <button
                    onClick={onDisconnect}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors ml-auto"
                  >
                    {t("wallet.actions.disconnect")}
                  </button>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={copyAddress}
              className="h-8 w-8 text-muted-foreground hover:text-primary"
            >
              <Copy className="w-4 h-4" />
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
        </>
      ) : (
        /* Not connected state */
        <div className="relative text-center py-6">
          <Wallet className="w-16 h-16 mx-auto mb-4 text-muted-foreground/50" />
          <h2 className="text-xl font-semibold text-foreground mb-2">No Wallet Connected</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Connect your wallet to view balance and transact with quantum-safe security
          </p>
          <div className="flex flex-col items-center gap-3 w-full max-w-xs mx-auto">
            {extensionDetected && onConnectExtension && (
              <Button onClick={onConnectExtension} className="w-full bg-primary hover:bg-primary/90 gap-2">
                <Puzzle className="w-4 h-4" />
                Connect Extension
              </Button>
            )}
            <div className="flex items-center gap-3">
              {onConnect && (
                <Button onClick={onConnect} variant={extensionDetected ? "outline" : "default"} className={extensionDetected ? "" : "bg-primary hover:bg-primary/90"}>
                  Create Wallet
                </Button>
              )}
              {onImport && (
                <Button onClick={onImport} variant="outline" className="gap-2">
                  <Upload className="w-4 h-4" />
                  Import
                </Button>
              )}
            </div>
            {!extensionDetected && (
              <a
                href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
              >
                <Puzzle className="w-3 h-3" />
                Get RougeChain Wallet Extension
              </a>
            )}
          </div>
        </div>
      )}

      {/* Decorative elements */}
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-primary/10 rounded-full blur-3xl" />
      <div className="absolute -bottom-20 -left-20 w-40 h-40 bg-accent/10 rounded-full blur-3xl" />
    </motion.div>
  );
};

export default WalletCard;
