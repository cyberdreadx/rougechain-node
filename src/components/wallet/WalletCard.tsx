import { motion, useMotionValue, useSpring, useReducedMotion } from "framer-motion";
import { Shield, Copy, ExternalLink, Wallet, TrendingUp, TrendingDown, Upload, Puzzle, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { pubkeyToAddress, formatAddress } from "@/lib/address";
import { MASKED_AMOUNT } from "@/hooks/use-hide-balances";
import { Link } from "react-router-dom";
import { WalletAvatar } from "@/components/WalletAvatar";
import { useMyProfile } from "@/hooks/use-my-profile";
import { tiltFromPointer } from "@/lib/token-visual";

interface WalletCardProps {
  address?: string | null;
  balance?: string | null;
  shieldedBalance?: number;
  usdValue?: string | null;
  /** XRGE market 24h % change (real data only; hidden when null). */
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
  const me = useMyProfile();
  const [copied, setCopied] = useState(false);
  const [extensionDetected, setExtensionDetected] = useState(false);
  const [rougeAddress, setRougeAddress] = useState<string | null>(null);

  // Subtle pointer tilt (mouse/pen only; off for reduced motion).
  const reduceMotion = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const rotateX = useSpring(rx, { stiffness: 180, damping: 18, mass: 0.4 });
  const rotateY = useSpring(ry, { stiffness: 180, damping: 18, mass: 0.4 });
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (reduceMotion || e.pointerType === "touch" || !cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const tilt = tiltFromPointer(px, py, r.width, r.height, 4);
    rx.set(tilt.rotateX);
    ry.set(tilt.rotateY);
    cardRef.current.style.setProperty("--glare-x", `${Math.round((px / r.width) * 100)}%`);
    cardRef.current.style.setProperty("--glare-y", `${Math.round((py / r.height) * 100)}%`);
  };
  const onPointerLeave = () => {
    rx.set(0);
    ry.set(0);
  };

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

  const hasUsd = !!usdValue && usdValue !== "N/A";

  const truncatedAddress = rougeAddress
    ? formatAddress(rougeAddress)
    : address
      ? `${address.slice(0, 8)}...${address.slice(-4)}`
      : null;

  return (
    <div style={{ perspective: 1200 }}>
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      style={reduceMotion ? undefined : { rotateX, rotateY }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="wallet-hero relative overflow-hidden rounded-3xl p-5 sm:p-7 glow-quantum gradient-ring hud-corners"
    >
      {/* Background circuit pattern + pointer glare */}
      <div className="absolute inset-0 circuit-bg opacity-30" />
      <div className="wallet-hero__glare" aria-hidden="true" />
      
      {/* Quantum security badge */}
      <div className="relative flex items-center gap-2 mb-6">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/30">
          <Shield className="w-4 h-4 text-primary" />
          <span className="text-xs font-medium text-primary">{t("visual.hero.pqc")}</span>
        </div>
        <span className="text-xs text-muted-foreground hidden min-[380px]:inline">CRYSTALS-Dilithium</span>
        {isConnected && address && (
          <Link
            to="/settings"
            title={t("settings.title")}
            className="ml-auto flex items-center gap-2 rounded-full pl-1 pr-1 sm:pr-3 py-1 hover:bg-primary/10 transition-colors min-w-0"
          >
            <WalletAvatar id={address} uri={me.avatar} name={me.displayName} size={32} ring />
            <span className="hidden sm:inline text-xs font-medium text-foreground/90 truncate max-w-[8rem]">{me.displayName}</span>
          </Link>
        )}
      </div>

      {isConnected && address ? (
        <>
          {/* Portfolio hero: USD total first (when priced), XRGE underneath */}
          <div className="relative mb-6">
            <div className="flex items-center gap-1.5 mb-2">
              <p className="hud-label">{t("visual.hero.portfolio")}</p>
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
              className="hero-amount text-shimmer break-all"
            >
              {hasUsd
                ? (balancesHidden ? `$${MASKED_AMOUNT}` : usdValue)
                : `${balancesHidden ? MASKED_AMOUNT : balance || "0"} XRGE`}
            </motion.h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2">
              {hasUsd ? (
                <p className="text-base sm:text-lg text-foreground/90 font-medium font-mono break-all">
                  {balancesHidden ? MASKED_AMOUNT : balance || "0"} <span className="text-muted-foreground">XRGE</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("visual.hero.noPrice")}</p>
              )}
              {priceChange24h !== null && priceChange24h !== undefined && Number.isFinite(priceChange24h) && (
                <span
                  className={`hero-chip ${priceChange24h >= 0 ? "text-success" : "text-destructive"}`}
                  title={t("visual.hero.changeHint")}
                >
                  {priceChange24h >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                  {priceChange24h >= 0 ? "+" : ""}{priceChange24h.toFixed(2)}%
                  <span className="font-mono font-normal opacity-80">{t("visual.hero.xrge24h")}</span>
                </span>
              )}
            </div>
            {shieldedBalance && shieldedBalance > 0 ? (
              <div className="flex items-center gap-1.5 mt-2">
                <Shield className="w-3.5 h-3.5 text-primary" />
                <span className="text-sm text-primary font-medium">
                  {balancesHidden ? MASKED_AMOUNT : shieldedBalance.toLocaleString()} XRGE {t("visual.hero.shielded")}
                </span>
              </div>
            ) : null}
          </div>

          {/* Address section */}
          <div className="relative flex items-center gap-3 p-3 rounded-xl bg-background/40 border border-border/70">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">{t("visual.hero.address")}</p>
              <p className="font-mono text-sm text-foreground truncate">{truncatedAddress}</p>
              <div className="mt-1 flex items-center gap-3">
                <button
                  type="button"
                  onClick={copyAddress}
                  className="text-xs text-primary hover:underline"
                >
                  {copied ? t("visual.hero.copied") : t("visual.hero.copy")}
                </button>
                <a
                  href="/blockchain"
                  className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1"
                >
                  {t("visual.hero.viewOnChain")} <ExternalLink className="w-3 h-3" />
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
              aria-label={t("visual.hero.copy")}
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
              {t("visual.hero.copied")}
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
    </div>
  );
};

export default WalletCard;
