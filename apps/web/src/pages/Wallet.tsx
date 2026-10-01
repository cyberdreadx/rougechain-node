import { useState, useEffect, useCallback, useRef } from "react";
import QuickActions from "@/components/wallet/QuickActions";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Loader2, 
  RefreshCw, 
  Droplets,
  Send,
  Download,
  Plus,
  FileKey2,
  Wifi,
  WifiOff,
  TrendingUp,
  TrendingDown,
  Puzzle,
  ExternalLink,
  Shield,
  ShieldOff,
  DollarSign,
  AlertTriangle,
  Copy,
  Check,
  Settings as SettingsIcon
} from "lucide-react";
import { useBlockchainWs, type WsNewTransactionEvent } from "@/hooks/use-blockchain-ws";
import { useRougeAddress } from "@/hooks/useRougeAddress";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useMajorPrices } from "@/hooks/use-eth-price";
import { useHideBalances, MASKED_AMOUNT } from "@/hooks/use-hide-balances";
import { describeAsset } from "@/lib/asset-display";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { formatUsd } from "@/lib/price-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import WalletCard from "@/components/wallet/WalletCard";
import AssetList from "@/components/wallet/AssetList";
import BaseWalletCard from "@/components/wallet/BaseWalletCard";
import TransactionHistory from "@/components/wallet/TransactionHistory";
import NetworkBadge from "@/components/wallet/NetworkBadge";
import SecurityStatus from "@/components/wallet/SecurityStatus";
import { WalletPageSkeleton, BalanceCardSkeleton, AssetListSkeleton, ActivitySkeleton } from "@/components/wallet/WalletSkeleton";
import WalletBackup from "@/components/wallet/WalletBackup";
import { 
  getWalletBalance, 
  getWalletTransactions, 
  getCirculatingSupply,
  TOTAL_SUPPLY,
  TOKEN_NAME,
  CHAIN_ID,
  WalletBalance,
  WalletTransaction
} from "@/lib/pqc-wallet";
import { generateKeypair } from "@/lib/pqc-blockchain";
import { generateEncryptionKeypair, registerWalletOnNode } from "@/lib/pqc-messenger";
import { createWalletViaNode } from "@/lib/node-api";
import { NETWORK_STORAGE_KEY, getCoreApiHeaders, getNetworkLabel, getNodeApiBaseUrl } from "@/lib/network";
import SendTokensDialog from "@/components/wallet/SendTokensDialog";
import ReceiveDialog from "@/components/wallet/ReceiveDialog";
import CreateTokenDialog from "@/components/wallet/CreateTokenDialog";
import TokenDetailDialog from "@/components/wallet/TokenDetailDialog";
import ShieldDialog from "@/components/wallet/ShieldDialog";
import UnshieldDialog from "@/components/wallet/UnshieldDialog";
import { getShieldedBalance } from "@/lib/note-store";
import { 
  UnifiedWallet,
  VaultSettings,
  autoLockWallet,
  getLockedWalletMetadata,
  getVaultSettings,
  hasEncryptedWallet,
  isWalletLocked,
  loadUnifiedWallet,
  lockUnifiedWallet,
  saveUnifiedWallet,
  saveVaultSettings,
  unlockUnifiedWallet,
  clearUnifiedWallet 
} from "@/lib/unified-wallet";
import { useTranslation } from "react-i18next";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { setOnboardingActive } from "@/lib/tour";

const Wallet = () => {
  const { t } = useTranslation();
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [circulatingSupply, setCirculatingSupply] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [showSend, setShowSend] = useState<string | boolean>(false); // true = open with the default token, string = preselected symbol
  const [showReceive, setShowReceive] = useState(false);
  const [showShield, setShowShield] = useState(false);
  const [showUnshield, setShowUnshield] = useState(false);
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<{
    symbol: string;
    name: string;
    balance: string;
    usdValue?: string | null;
    pricePerToken?: string | null;
    change: number;
    imageUrl?: string | null;
  } | null>(null);
  const [isMainnet, setIsMainnet] = useState(false); // Default based on network selection
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [chainIdLabel, setChainIdLabel] = useState<string>(CHAIN_ID);
  const [activeNetwork, setActiveNetwork] = useState<"testnet" | "mainnet">(
    (localStorage.getItem(NETWORK_STORAGE_KEY) as "testnet" | "mainnet" | null) || "mainnet"
  );
  // The 5-second network check below lives in a mount-once effect; read the CURRENT network from
  // this ref (its closure would otherwise keep the network the page opened on, see "switch
  // network → balance stuck at 0").
  const activeNetworkRef = useRef(activeNetwork);
  useEffect(() => { activeNetworkRef.current = activeNetwork; }, [activeNetwork]);
  const [isLocked, setIsLocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>(() => getVaultSettings());
  const [lastActivity, setLastActivity] = useState(Date.now());

  // Recovery-phrase reveal after wallet creation (must be seen before password)
  const [showSeedReveal, setShowSeedReveal] = useState(false);
  const [newMnemonic, setNewMnemonic] = useState("");
  const [seedSaved, setSeedSaved] = useState(false);
  const [seedRevealCopied, setSeedRevealCopied] = useState(false);

  // Password setup after wallet creation
  const [showPasswordSetup, setShowPasswordSetup] = useState(false);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);

  // Qwalla-style onboarding (mail name → profile → done → tour) after create / import.
  const [onboardingMode, setOnboardingMode] = useState<"create" | "import" | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Load wallet from storage
  useEffect(() => {
    const locked = isWalletLocked();
    setIsLocked(locked);
    if (locked) {
      setWallet(null);
      setLoading(false);
      return;
    }
    const unified = loadUnifiedWallet();
    if (unified) {
      setWallet(unified);
    } else {
      // Auto-connect if inside Qwalla dApp browser or extension is injected
      const provider = (window as any).rougechain;
      if (provider?.isRougeChain) {
        (async () => {
          try {
            const result = await provider.connect() as { publicKey: string; displayName?: string; encryptionPublicKey?: string };
            if (result?.publicKey) {
              const extensionWallet: UnifiedWallet = {
                id: `ext-${Date.now()}`,
                displayName: result.displayName || "Extension Wallet",
                createdAt: Date.now(),
                signingPublicKey: result.publicKey,
                signingPrivateKey: "",
                encryptionPublicKey: result.encryptionPublicKey || "",
                encryptionPrivateKey: "",
                version: 2,
              };
              saveUnifiedWallet(extensionWallet);
              setWallet(extensionWallet);
            }
          } catch {
            // Auto-connect failed silently — user can still connect manually
          } finally {
            setLoading(false);
          }
        })();
        return;
      }
    }
    setLoading(false);
  }, [activeNetwork]);

  useEffect(() => {
    setVaultSettings(getVaultSettings());
  }, [activeNetwork]);

  // Check network selection from NetworkBadge (localStorage) - prioritize UI selection
  useEffect(() => {
    const checkNetwork = () => {
      // Check the user's explicit network selection from NetworkBadge
      const savedNetwork = localStorage.getItem(NETWORK_STORAGE_KEY) as "testnet" | "mainnet" | null;
      const nextNetwork = savedNetwork ?? "mainnet";

      if (nextNetwork !== activeNetworkRef.current) {
        activeNetworkRef.current = nextNetwork;
        setActiveNetwork(nextNetwork);
        const unified = loadUnifiedWallet();
        setWallet(unified);
        setBalances([]);
        setTransactions([]);
        setCirculatingSupply(0);
        setLastUpdated(null);
        
        // Only log on actual network change
        if (savedNetwork === "mainnet") {
          console.log(`[Wallet] Network changed to mainnet`);
        } else if (savedNetwork === "testnet") {
          console.log(`[Wallet] Network changed to testnet`);
        }
      }
      
      // Prioritize UI selection: if user selected testnet, show faucet; if mainnet, hide it
      if (savedNetwork === "mainnet") {
        setIsMainnet(true);
        setChainIdLabel("rougechain-mainnet");
        return;
      }
      
      if (savedNetwork === "testnet") {
        setIsMainnet(false);
        setChainIdLabel("rougechain-testnet");
        return;
      }
      
      // No UI selection - fall back to checking node's chainId
      const checkNodeChainId = async () => {
        try {
          const NODE_API_URL = getNodeApiBaseUrl();
          if (!NODE_API_URL) {
            return;
          }
          const res = await fetch(`${NODE_API_URL}/stats`, {
            signal: AbortSignal.timeout(8000), // 8 second timeout (API can be slow under load)
            headers: getCoreApiHeaders(),
          });
          if (res.ok) {
            const data = await res.json() as { chainId?: string; chain_id?: string };
            const detected = data.chainId || data.chain_id;
            if (detected) {
              // Hide faucet on mainnet (chainId doesn't contain "devnet" or "testnet")
              const isMainnetNetwork = !detected.includes("devnet") && !detected.includes("testnet");
              setIsMainnet(isMainnetNetwork);
              // Only update and log if chainId actually changed
              setChainIdLabel(prev => {
                if (prev !== detected) {
                  console.log(`[Wallet] Using node chainId: ${detected}`);
                }
                return detected;
              });
            } else {
              // No chainId in response - default to testnet (show faucet)
              setIsMainnet(false);
            }
          } else {
            // API error - default to testnet (show faucet)
            setIsMainnet(false);
          }
        } catch {
          // If can't reach node, default to testnet (show faucet)
          setIsMainnet(false);
        }
      };
      
      checkNodeChainId();
    };
    
    checkNetwork();
    // Listen for network changes from NetworkBadge (storage events work across tabs)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === NETWORK_STORAGE_KEY) {
        checkNetwork();
      }
    };
    window.addEventListener("storage", handleStorageChange);
    // Check periodically in case localStorage changed in same tab (storage event doesn't fire in same tab)
    const interval = setInterval(checkNetwork, 5000); // Check every 5s, not 1s
    return () => {
      clearInterval(interval);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  // Fetch token prices (XRGE from DexScreener, others from pool reserves)
  const { tokenPrices, getTokenValue, xrgeUsdPrice: priceUsd, xrgePriceChange24h, loading: priceLoading } = useTokenPrices(60_000);
  // XRGE market 24h change (GeckoTerminal / DexScreener). The sources coerce a missing figure to 0,
  // so an exact 0 is treated as "unknown" rather than shown as +0.00%. Custom tokens have no 24h data.
  const priceChange24h = xrgePriceChange24h ? xrgePriceChange24h : null;
  
  // Fetch token metadata (for images, descriptions, etc.)
  const { getTokenImage, getMetadata } = useTokenMetadata(60_000);

  // WebSocket for real-time updates
  const handleNewBlock = useCallback(() => {
    if (wallet) {
      refreshWalletData();
    }
  }, [wallet?.signingPublicKey]);

  // Incoming-transfer toasts are app-wide (IncomingTransferWatcher). Here, a NewTransaction frame on
  // my account topics only refreshes the page early. The node publishes them to `account:<from>`
  // and `account:<to>` with `to` exactly as submitted (rouge1 address OR public key): watch both.
  const { full: rougeAddress } = useRougeAddress(wallet?.signingPublicKey);
  const refreshRef = useRef<() => void>(() => {});
  const frameRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (frameRefreshTimer.current) clearTimeout(frameRefreshTimer.current); }, []);
  const handleNewTransaction = useCallback((_frame: WsNewTransactionEvent) => {
    // The history is read from blocks: refresh shortly after, once the transfer is mined.
    if (frameRefreshTimer.current) clearTimeout(frameRefreshTimer.current);
    frameRefreshTimer.current = setTimeout(() => refreshRef.current(), 1500);
  }, []);
  const wsTopics = wallet
    ? ["blocks", `account:${wallet.signingPublicKey}`, ...(rougeAddress ? [`account:${rougeAddress}`] : [])]
    : ["blocks"];

  const { isConnected: wsConnected, connectionType: wsConnectionType } = useBlockchainWs({
    onNewBlock: handleNewBlock,
    onNewTransaction: handleNewTransaction,
    topics: wsTopics,
    fallbackPollInterval: 15000,
  });

  // Load balance and transactions when the wallet or the network changes (the same wallet has a
  // different balance on each network).
  // Also once the rouge1 address resolves: transfers sent to it only show up with it.
  useEffect(() => {
    if (wallet) {
      refreshWalletData();
    }
  }, [wallet?.signingPublicKey, activeNetwork, rougeAddress]);

  useEffect(() => {
    const handleActivity = () => setLastActivity(Date.now());
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("touchstart", handleActivity);
    return () => {
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
    };
  }, []);

  useEffect(() => {
    if (!wallet) return;
    if (!hasEncryptedWallet()) return;
    const minutes = vaultSettings.autoLockMinutes;
    if (!minutes || minutes <= 0) return;
    const timeout = window.setTimeout(() => {
      autoLockWallet();
      setWallet(null);
      setIsLocked(true);
      toast.info(t("wallet.toasts.locked"), {
        description: t("wallet.toasts.lockedDesc"),
      });
    }, minutes * 60 * 1000);
    return () => window.clearTimeout(timeout);
  }, [wallet, lastActivity, vaultSettings.autoLockMinutes]);

  const refreshWalletData = async () => {
    if (!wallet) return;
    setRefreshing(true);
    setSyncError(null);
    
    try {
      const [newBalances, newTxs, supply] = await Promise.all([
        getWalletBalance(wallet.signingPublicKey),
        getWalletTransactions(wallet.signingPublicKey, rougeAddress ? [rougeAddress] : []),
        getCirculatingSupply("XRGE"),
      ]);
      
      setBalances(newBalances);
      setTransactions(newTxs);
      setCirculatingSupply(supply);
      setLastUpdated(Date.now());
    } catch (error) {
      console.error("Failed to refresh wallet data:", error);
      const message = error instanceof Error ? error.message : t("wallet.errors.loadFailed");
      setSyncError(message);
      toast.error(t("wallet.errors.loadFailed"));
    } finally {
      setRefreshing(false);
    }
  };

  refreshRef.current = () => { void refreshWalletData(); };

  const createNewWallet = async () => {
    setLoading(true);
    try {
      // Generate a BIP-39 mnemonic and derive ML-DSA-65 keys from it
      const { generateMnemonic, keypairFromMnemonic } = await import("@/lib/mnemonic");
      const mnemonic = generateMnemonic();
      const { publicKey: signingPublicKey, secretKey: signingPrivateKey } = keypairFromMnemonic(mnemonic);

      // Generate encryption keys for messenger E2EE (ML-KEM-768)
      const encryptionKeys = generateEncryptionKeypair();
      
      const newWallet: UnifiedWallet = {
        id: `wallet-${Date.now()}`,
        displayName: "My Wallet",
        createdAt: Date.now(),
        signingPublicKey,
        signingPrivateKey,
        encryptionPublicKey: encryptionKeys.publicKey,
        encryptionPrivateKey: encryptionKeys.privateKey,
        version: 2,
        mnemonic,
      };
      
      saveUnifiedWallet(newWallet);
      setWallet(newWallet);

      try {
        await registerWalletOnNode({
          id: newWallet.id,
          displayName: newWallet.displayName,
          signingPublicKey: newWallet.signingPublicKey,
          encryptionPublicKey: newWallet.encryptionPublicKey,
        });
      } catch (err) {
        console.warn("Failed to register wallet on node:", err);
      }

      // Show the recovery phrase FIRST — the user must see and save it before we
      // move on to the password. This is the only moment it's surfaced proactively.
      setNewMnemonic(mnemonic);
      setSeedSaved(false);
      setShowSeedReveal(true);
      setOnboardingMode("create");
      setOnboardingActive(true);
    } catch (error) {
      console.error("Failed to create wallet:", error);
      const errorMessage = error instanceof Error ? error.message : t("wallet.errors.unknown");
      toast.error(t("wallet.errors.createFailed"), {
        description: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSetup = async () => {
    if (setupPassword.length < 6) {
      setSetupError(t("wallet.passwordSetup.errors.tooShort"));
      return;
    }
    if (setupPassword !== setupConfirm) {
      setSetupError(t("wallet.passwordSetup.errors.mismatch"));
      return;
    }
    setSetupError("");
    setSetupBusy(true);
    try {
      await lockUnifiedWallet(setupPassword);
      const w = await unlockUnifiedWallet(setupPassword);
      setWallet(w);
      setShowPasswordSetup(false);
      toast.success(t("wallet.toasts.createdSecured"), {
        description: t("wallet.toasts.createdSecuredDesc")
      });
      if (onboardingMode) setShowOnboarding(true);
    } catch (err) {
      setSetupError(t("wallet.passwordSetup.errors.encryptFailed"));
    }
    setSetupBusy(false);
  };

  const disconnectWallet = () => {
    clearUnifiedWallet();
    setWallet(null);
    setIsLocked(false);
    setBalances([]);
    setTransactions([]);
    toast.info(t("wallet.toasts.disconnected"));
  };

  const connectExtensionWallet = async () => {
    try {
      const provider = (window as any).rougechain;
      if (!provider?.isRougeChain) {
        toast.error(t("wallet.errors.extensionNotFound"), {
          description: t("wallet.errors.extensionNotFoundDesc"),
        });
        return;
      }
      setLoading(true);
      const result = await provider.connect() as { publicKey: string; displayName?: string; encryptionPublicKey?: string };
      if (!result?.publicKey) {
        throw new Error(t("wallet.errors.extensionNoPublicKey"));
      }
      const extensionWallet: UnifiedWallet = {
        id: `ext-${Date.now()}`,
        displayName: result.displayName || "Extension Wallet",
        createdAt: Date.now(),
        signingPublicKey: result.publicKey,
        signingPrivateKey: "",
        encryptionPublicKey: result.encryptionPublicKey || "",
        encryptionPrivateKey: "",
        version: 2,
      };
      saveUnifiedWallet(extensionWallet);
      setWallet(extensionWallet);
      toast.success(t("wallet.toasts.extensionConnected"), {
        description: `${result.publicKey.slice(0, 8)}...${result.publicKey.slice(-4)}`,
      });
    } catch (error) {
      console.error("Extension connect failed:", error);
      const msg = error instanceof Error ? error.message : t("wallet.errors.extensionConnectFailed");
      toast.error(t("wallet.errors.extensionConnectFailed"), { description: msg });
    } finally {
      setLoading(false);
    }
  };

  const handleUnlock = async () => {
    if (!unlockPassword.trim()) {
      toast.error(t("wallet.locked.enterPassword"));
      return;
    }
    setUnlocking(true);
    try {
      const unlocked = await unlockUnifiedWallet(unlockPassword.trim());
      setWallet(unlocked);
      setIsLocked(false);
      setUnlockPassword("");
      toast.success(t("wallet.toasts.unlocked"));
    } catch (error) {
      console.error("Unlock failed:", error);
      toast.error(t("wallet.locked.unlockFailed"), {
        description: t("wallet.locked.unlockFailedDesc"),
      });
    } finally {
      setUnlocking(false);
    }
  };

  const handleVaultSettings = (settings: VaultSettings) => {
    saveVaultSettings(settings);
    setVaultSettings(settings);
  };

  const handleWalletImport = (importedWallet: UnifiedWallet) => {
    saveUnifiedWallet(importedWallet);
    setWallet(importedWallet);
    setOnboardingMode("import");
    setOnboardingActive(true);
    if (!hasEncryptedWallet()) {
      setShowPasswordSetup(true);
    } else {
      setShowOnboarding(true);
    }
    refreshWalletData();
  };

  const claimFromFaucet = async () => {
    if (!wallet) {
      toast.error(t("wallet.errors.connectFirst"));
      return;
    }

    setMinting(true);
    try {
      // Try node API faucet endpoint directly (preferred method)
          const NODE_API_URL = getNodeApiBaseUrl();
      const faucetUrl = `${NODE_API_URL}/faucet`;
      
      try {
        const res = await fetch(faucetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
          body: JSON.stringify({
            recipientPublicKey: wallet.signingPublicKey,
            amount: 10000,
          }),
        });

        const rawText = await res.text();
        let data: { success?: boolean; error?: string; message?: string } | null = null;
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch {
          if (!res.ok) {
            throw new Error(t("wallet.faucet.httpFailed", { status: res.status, statusText: res.statusText }));
          }
          throw new Error(t("wallet.faucet.invalidResponse"));
        }

        if (!res.ok) {
          const errorMsg = data?.error ?? (data ? JSON.stringify(data) : t("wallet.faucet.httpFailed", { status: res.status, statusText: res.statusText }));
          console.error(`[Faucet] API error:`, errorMsg);
          throw new Error(typeof errorMsg === "string" ? errorMsg : t("wallet.faucet.requestFailed"));
        }

        if (data.success) {
          toast.success(t("wallet.faucet.claimedXrge"), {
            description: t("wallet.faucet.balanceUpdates")
          });
          // Immediate refresh, then poll (miner runs ~1s)
          await refreshWalletData();
          for (const delayMs of [800, 1600, 2400]) {
            await new Promise((r) => setTimeout(r, delayMs));
            await refreshWalletData();
          }
        } else {
          const errorMsg = data?.error || t("wallet.faucet.notSuccessful");
          console.error(`[Faucet] Request not successful:`, errorMsg);
          throw new Error(errorMsg);
        }
      } catch (nodeError) {
        console.warn("[Faucet] Node API faucet failed:", nodeError);
        throw nodeError;
      }
    } catch (error) {
      console.error("[Faucet] Final error:", error);
      const errorMessage = error instanceof Error ? error.message : t("wallet.faucet.claimFailed");
      toast.error(t("wallet.faucet.claimFailed"), {
        description: errorMessage
      });
    } finally {
      setMinting(false);
    }
  };

  const claimBridgeFaucet = async (token: "qUSDC" | "qETH") => {
    if (!wallet) {
      toast.error(t("wallet.errors.connectFirst"));
      return;
    }
    setMinting(true);
    try {
      const NODE_API_URL = getNodeApiBaseUrl();
      const res = await fetch(`${NODE_API_URL}/faucet/bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
        body: JSON.stringify({
          recipientPublicKey: wallet.signingPublicKey,
          token,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || t("wallet.faucet.claimTokenFailed", { token }));
      }
      const displayAmount = token === "qUSDC" ? "1,000 qUSDC" : "1 qETH";
      toast.success(t("wallet.faucet.claimedAmount", { amount: displayAmount }), {
        description: t("wallet.faucet.balanceUpdates"),
      });
      await refreshWalletData();
      for (const delayMs of [800, 1600, 2400]) {
        await new Promise((r) => setTimeout(r, delayMs));
        await refreshWalletData();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("wallet.faucet.claimTokenFailed", { token });
      toast.error(t("wallet.faucet.claimTokenFailed", { token }), { description: msg });
    } finally {
      setMinting(false);
    }
  };

  // Get XRGE balance specifically for the main display (native token)
  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;
  
  const networkLabel = getNetworkLabel(chainIdLabel);
  const majorPrices = useMajorPrices(60_000);
  const { hidden: balancesHidden, toggle: toggleBalancesHidden } = useHideBalances();
  const assetDisplays = balances.map(b => ({
    b,
    d: describeAsset(b.symbol, b.balance, { poolPriceUsdPerRaw: tokenPrices[b.symbol]?.priceUsd, majors: majorPrices }),
  }));

  // Calculate total USD value for wallet display (all priced tokens, same figures as the asset rows)
  const totalUsdValue = assetDisplays.reduce((total, { d }) => total + (d.usd ?? 0), 0);
  // Show a USD total whenever at least one holding is priced (so an empty wallet reads "$0.00").
  const walletUsdValue = assetDisplays.some(({ d }) => d.usd !== null) ? formatUsd(totalUsdValue) : null;


  const formatLastUpdated = (timestamp: number | null) => {
    if (!timestamp && syncError) return t("wallet.sync.failed");
    if (!timestamp) return t("wallet.sync.notYet");
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 5) return t("wallet.sync.justNow");
    if (seconds < 60) return t("wallet.sync.secondsAgo", { seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t("wallet.sync.minutesAgo", { minutes });
    const hours = Math.floor(minutes / 60);
    return t("wallet.sync.hoursAgo", { hours });
  };

  // Convert balances to asset format with USD values (spot for bridged majors, else pools).
  // Decimals are applied generally (qBTC = 8, qETH/qUSDC = 6, daemon-provided for others).
  const assets = assetDisplays.map(({ b, d }) => ({
    id: b.symbol,
    name: b.name,
    symbol: b.symbol,
    balance: balancesHidden ? MASKED_AMOUNT : d.balance,
    value: balancesHidden ? `${MASKED_AMOUNT} ${b.symbol}` : d.value,
    usdValue: balancesHidden ? (d.usdValue ? `$${MASKED_AMOUNT}` : null) : d.usdValue,
    pricePerToken: d.pricePerToken,
    change: 0,
    icon: b.icon,
    imageUrl: getTokenImage(b.symbol),
  }));

  // Convert transactions to history format
  const txHistory = transactions.map(tx => ({
    id: tx.id,
    type: tx.type,
    amount: balancesHidden ? MASKED_AMOUNT : tx.amount,
    symbol: tx.symbol,
    address: tx.address,
    timeLabel: tx.timeLabel,
    timestamp: tx.timestamp,
    status: tx.status,
    blockIndex: tx.blockIndex,
    txHash: tx.txHash,
    fee: tx.fee,
    from: tx.from,
    to: tx.to,
    // Swap / LP / bridge memos spell out amounts ("Swap 5 XRGE for …").
    memo: balancesHidden && tx.memo ? MASKED_AMOUNT : tx.memo,
  }));

  const emptyAssetActionLabel = isMainnet ? t("wallet.empty.receiveTokens") : t("wallet.empty.claimFaucet");
  const handleEmptyAssetAction = () => {
    if (isMainnet) {
      setShowReceive(true);
    } else {
      claimFromFaucet();
    }
  };
  const emptyAssetHint = isMainnet
    ? t("wallet.empty.shareAddressHint")
    : t("wallet.empty.faucetHint");

  if (loading) {
    return <WalletPageSkeleton />;
  }

  // Wallet known but its balances / history not fetched yet: placeholders, not empty states.
  const firstDataLoad = !!wallet && lastUpdated === null && !syncError;

  if (showSeedReveal) {
    const words = newMnemonic.split(" ");
    return (
      <div className="min-h-screen">
        <div className="max-w-md mx-auto px-4 py-12">
          <Card className="border-border">
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center mb-3">
                <FileKey2 className="w-6 h-6 text-warning" />
              </div>
              <CardTitle className="text-xl">{t("wallet.seedReveal.title")}</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                {t("wallet.seedReveal.intro", { count: words.length })}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("wallet.seedReveal.warning")}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {words.map((word, i) => (
                  <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-muted/50 border border-border">
                    <span className="text-[10px] text-muted-foreground w-4 text-right">{i + 1}</span>
                    <span className="text-xs font-mono">{word}</span>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(newMnemonic);
                    setSeedRevealCopied(true);
                    setTimeout(() => setSeedRevealCopied(false), 2000);
                  } catch { /* clipboard blocked */ }
                }}
              >
                {seedRevealCopied ? <><Check className="w-4 h-4 mr-2" /> {t("wallet.seedReveal.copied")}</> : <><Copy className="w-4 h-4 mr-2" /> {t("wallet.seedReveal.copyPhrase")}</>}
              </Button>
              <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={seedSaved}
                  onChange={(e) => setSeedSaved(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">{t("wallet.seedReveal.confirmSaved")}</span>
              </label>
              <Button
                className="w-full"
                disabled={!seedSaved}
                onClick={() => { setShowSeedReveal(false); setShowPasswordSetup(true); }}
              >
                {t("wallet.seedReveal.continue")}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                {t("wallet.seedReveal.viewLater")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (showPasswordSetup) {
    return (
      <div className="min-h-screen">
        <div className="max-w-md mx-auto px-4 py-12">
          <Card className="border-border">
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="text-xl">{t("wallet.passwordSetup.title")}</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                {t("wallet.passwordSetup.intro")}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <Input
                  type="password"
                  placeholder={t("wallet.passwordSetup.createPlaceholder")}
                  value={setupPassword}
                  onChange={(e) => { setSetupPassword(e.target.value); setSetupError(""); }}
                />
                <Input
                  type="password"
                  placeholder={t("wallet.passwordSetup.confirmPlaceholder")}
                  value={setupConfirm}
                  onChange={(e) => { setSetupConfirm(e.target.value); setSetupError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handlePasswordSetup()}
                />
              </div>
              {setupError && (
                <p className="text-sm text-destructive text-center">{setupError}</p>
              )}
              <Button
                className="w-full"
                onClick={handlePasswordSetup}
                disabled={!setupPassword || !setupConfirm || setupBusy}
              >
                {setupBusy ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t("wallet.passwordSetup.encrypting")}</>
                ) : (
                  <><Shield className="w-4 h-4 mr-2" /> {t("wallet.passwordSetup.submit")}</>
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                {t("wallet.passwordSetup.neverSent")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (showOnboarding && onboardingMode) {
    return (
      <OnboardingFlow
        mode={onboardingMode}
        onFinish={() => {
          setShowOnboarding(false);
          setOnboardingMode(null);
          const latest = loadUnifiedWallet();
          if (latest) setWallet(latest);
        }}
      />
    );
  }

  if (isLocked) {
    const meta = getLockedWalletMetadata();
    return (
      <div className="min-h-screen">
        <div className="max-w-md mx-auto px-4 py-12">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>{t("wallet.locked.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {meta?.displayName ? t("wallet.locked.namedLocked", { name: meta.displayName }) : t("wallet.locked.yourWalletLocked")}
              </p>
              {meta?.signingPublicKey && (
                <p className="text-xs font-mono text-muted-foreground break-all">
                  {meta.signingPublicKey}
                </p>
              )}
              <Input
                type="password"
                placeholder={t("wallet.locked.passwordPlaceholder")}
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
              />
              <Button className="w-full" onClick={handleUnlock} disabled={unlocking}>
                {unlocking ? t("wallet.locked.unlocking") : t("wallet.locked.unlockButton")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Action Bar */}
      <div className="sticky top-0 z-40 bg-background/80 backdrop-blur-sm border-b border-border neon-hairline">
        <div className="max-w-lg mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <NetworkBadge 
              isConnected={!!wallet}
              onNetworkChange={(network) => {
                // Update isMainnet when user changes network in UI
                setIsMainnet(network === "mainnet");
              }}
            />
          </div>
          
          <div className="flex items-center gap-2">
            {wallet && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowBackup(true)}
                  className="h-9 w-9"
                  title={t("wallet.actions.backupTitle")}
                >
                  <FileKey2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9" asChild title={t("settings.title")}>
                  <Link to="/settings" aria-label={t("settings.title")}>
                    <SettingsIcon className="w-4 h-4" />
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={refreshWalletData}
                  disabled={refreshing}
                  className="h-9 w-9"
                >
                  <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
              </>
            )}
            {wallet && (
              <div className="flex items-center gap-2">
                {wsConnectionType === "websocket" ? (
                  <Wifi className="w-3 h-3 text-green-500" />
                ) : wsConnectionType === "polling" ? (
                  <RefreshCw className="w-3 h-3 text-amber-500" />
                ) : (
                  <WifiOff className="w-3 h-3 text-destructive" />
                )}
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {formatLastUpdated(lastUpdated)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {!wallet ? (
          /* No wallet connected */
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <WalletCard 
              isConnected={false}
              onConnect={createNewWallet}
              onImport={() => setShowBackup(true)}
              onConnectExtension={connectExtensionWallet}
            />

            <SecurityStatus />
          </motion.div>
        ) : (
          /* Wallet connected */
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-6"
          >
          {firstDataLoad ? <BalanceCardSkeleton /> : <WalletCard
              address={wallet.signingPublicKey}
              balance={xrgeBalance.toLocaleString()}
              shieldedBalance={getShieldedBalance(wallet.signingPublicKey)}
              usdValue={walletUsdValue}
              priceChange24h={priceChange24h}
              isConnected={true}
              balancesHidden={balancesHidden}
              onToggleBalancesHidden={toggleBalancesHidden}
              onDisconnect={disconnectWallet}
            />}

            {/* Quick actions */}
            <div className="flex items-center justify-between">
              <h3 className="hud-label">{t("wallet.actions.title")}</h3>
            </div>
            <QuickActions
              actions={[
                { key: "send", label: t("wallet.actions.send"), icon: Send, tone: "magenta", onClick: () => setShowSend(true), disabled: balances.length === 0 },
                { key: "receive", label: t("wallet.actions.receive"), icon: Download, tone: "teal", onClick: () => setShowReceive(true) },
                ...(!isMainnet ? [
                  { key: "faucet", label: "Get XRGE", title: "Testnet XRGE faucet", icon: Droplets, tone: "cyan" as const, onClick: claimFromFaucet, loading: minting },
                  { key: "faucet-qusdc", label: "Get qUSDC", title: "Testnet qUSDC faucet", icon: DollarSign, tone: "green" as const, onClick: () => claimBridgeFaucet("qUSDC"), loading: minting },
                ] : []),
                { key: "create", label: t("wallet.actions.create"), icon: Plus, tone: "violet", onClick: () => setShowCreateToken(true) },
                { key: "shield", label: t("wallet.actions.shield"), icon: Shield, tone: "amber", onClick: () => setShowShield(true), disabled: xrgeBalance <= 1 },
                { key: "unshield", label: t("wallet.actions.unshield"), icon: ShieldOff, tone: "purple", onClick: () => setShowUnshield(true) },
              ]}
            />


            {firstDataLoad ? (
              <>
                <AssetListSkeleton />
                <ActivitySkeleton />
              </>
            ) : (
              <>
                <AssetList
                  assets={assets}
                  emptyActionLabel={emptyAssetActionLabel}
                  onEmptyAction={handleEmptyAssetAction}
                  emptyHint={emptyAssetHint}
                  onAssetClick={(asset) => setSelectedAsset(asset)}
                />
                <BaseWalletCard
                  mnemonic={wallet.mnemonic}
                  ethPriceUsd={majorPrices.eth}
                  xrgePriceUsd={priceUsd}
                  balancesHidden={balancesHidden}
                />
                <TransactionHistory
                  transactions={txHistory}
                  emptyActionLabel={t("wallet.empty.receiveTokens")}
                  onEmptyAction={() => setShowReceive(true)}
                />
              </>
            )}


            {/* Token Supply Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="p-4 rounded-2xl bg-card glass-card border border-border"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="hud-label">{t("wallet.tokenInfo.title")}</h3>
                <Link
                  to="/blockchain"
                  className="text-xs text-primary hover:underline"
                >
                  {t("wallet.tokenInfo.explorer")} ↗
                </Link>
              </div>

              {/* Native Token Info */}
              <div className="p-3 rounded-lg bg-secondary/50 border border-border mb-3">
                <p className="text-xs text-muted-foreground mb-1">{t("wallet.tokenInfo.tokenType")}</p>
                <p className="text-xs font-mono text-foreground">{t("wallet.tokenInfo.nativeChainToken")}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("wallet.tokenInfo.nativeCurrency")}</p>
              </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="p-2 rounded-lg bg-secondary/30">
                  <p className="text-xs text-muted-foreground">{t("wallet.tokenInfo.name")}</p>
                  <p className="text-xs font-medium text-foreground">{TOKEN_NAME}</p>
                </div>
                <div className="p-2 rounded-lg bg-secondary/30">
                    <p className="text-xs text-muted-foreground">{t("wallet.tokenInfo.network")}</p>
                    <p className="text-xs font-medium text-foreground">{networkLabel}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="p-2 rounded-lg bg-secondary/30">
                    <p className="text-xs text-muted-foreground">{t("wallet.tokenInfo.chainId")}</p>
                    <p className="text-xs font-mono text-foreground">{chainIdLabel}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-secondary/30">
                    <p className="text-xs text-muted-foreground">{t("wallet.tokenInfo.supplyModel")}</p>
                    <p className="text-xs font-medium text-foreground">
                      {networkLabel === "Mainnet" ? t("wallet.tokenInfo.capped") : t("common.testnet")}
                    </p>
                </div>
              </div>

              <div className="space-y-2">
                {/* Live Price from DexScreener */}
                {priceUsd !== null && (
                  <div className="flex justify-between items-center p-2 rounded-lg bg-primary/10 border border-primary/20">
                    <span className="text-xs font-medium text-primary">{t("wallet.tokenInfo.livePrice")}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono font-bold text-primary">
                        ${priceUsd.toFixed(8)}
                      </span>
                      {priceChange24h !== null && (
                        <span className={`flex items-center gap-0.5 text-xs ${priceChange24h >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {priceChange24h >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">{t("wallet.tokenInfo.totalSupply")}</span>
                  <span className="text-sm font-mono text-foreground">{TOTAL_SUPPLY.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">{t("wallet.tokenInfo.circulating")}</span>
                  <span className="text-sm font-mono text-foreground">{circulatingSupply.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">{t("wallet.tokenInfo.remaining")}</span>
                  <span className="text-sm font-mono text-primary">{(TOTAL_SUPPLY - circulatingSupply).toLocaleString()}</span>
                </div>
                <div className="mt-3 h-2 bg-secondary rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-primary to-accent rounded-full transition-all duration-500"
                    style={{ width: `${(circulatingSupply / TOTAL_SUPPLY) * 100}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {t("wallet.tokenInfo.percentInCirculation", { percent: ((circulatingSupply / TOTAL_SUPPLY) * 100).toFixed(6) })}
                </p>
              </div>
            </motion.div>

            <SecurityStatus />

            {/* Chrome Extension Promo */}
            <motion.a
              href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj"
              target="_blank"
              rel="noopener noreferrer"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.35 }}
              className="flex items-center gap-3 p-4 rounded-xl bg-card border border-primary/30 hover:border-primary/60 hover:bg-primary/5 transition-all group"
            >
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Puzzle className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">{t("wallet.extensionPromo.title")}</p>
                <p className="text-xs text-muted-foreground">Chrome · Edge · Brave · Firefox · Arc · Opera</p>
              </div>
              <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
            </motion.a>
          </motion.div>
        )}
      </main>

      {/* Send Dialog */}
      <AnimatePresence>
        {showSend && wallet && (
          <SendTokensDialog
            wallet={wallet}
            balances={balances}
            initialToken={typeof showSend === "string" ? showSend : undefined}
            onClose={() => setShowSend(false)}
            onSuccess={() => {
              setShowSend(false);
              refreshWalletData();
            }}
          />
        )}
      </AnimatePresence>

      {/* Shield Dialog */}
      <AnimatePresence>
        {showShield && wallet && (
          <ShieldDialog
            wallet={wallet}
            xrgeBalance={xrgeBalance}
            onClose={() => setShowShield(false)}
            onSuccess={() => {
              setShowShield(false);
              refreshWalletData();
            }}
          />
        )}
      </AnimatePresence>

      {/* Unshield Dialog */}
      <AnimatePresence>
        {showUnshield && wallet && (
          <UnshieldDialog
            wallet={wallet}
            onClose={() => setShowUnshield(false)}
            onSuccess={() => {
              setShowUnshield(false);
              refreshWalletData();
            }}
          />
        )}
      </AnimatePresence>

      {/* Receive Dialog */}
      <AnimatePresence>
        {showReceive && wallet && (
          <ReceiveDialog
            publicKey={wallet.signingPublicKey}
            onClose={() => setShowReceive(false)}
          />
        )}
      </AnimatePresence>

      {/* Create Token Dialog */}
      <AnimatePresence>
        {showCreateToken && wallet && (
          <CreateTokenDialog
            wallet={wallet}
            balances={balances}
            onClose={() => setShowCreateToken(false)}
            onSuccess={() => {
              setShowCreateToken(false);
              refreshWalletData();
            }}
          />
        )}
      </AnimatePresence>

      {/* Backup Dialog */}
      <AnimatePresence>
        {showBackup && (
          <WalletBackup
            wallet={wallet}
            onClose={() => setShowBackup(false)}
            onImport={handleWalletImport}
            onLocked={() => {
              setWallet(null);
              setIsLocked(true);
            }}
            vaultSettings={vaultSettings}
            onUpdateVaultSettings={handleVaultSettings}
          />
        )}
      </AnimatePresence>

      {/* Token Detail Dialog */}
      <AnimatePresence>
        {selectedAsset && wallet && (
          <TokenDetailDialog
            symbol={selectedAsset.symbol}
            name={selectedAsset.name}
            balance={selectedAsset.balance}
            usdValue={selectedAsset.usdValue}
            pricePerToken={selectedAsset.pricePerToken}
            change={selectedAsset.change}
            imageUrl={selectedAsset.imageUrl}
            walletPublicKey={wallet.signingPublicKey}
            walletPrivateKey={wallet.signingPrivateKey}
            isCreator={getMetadata(selectedAsset.symbol)?.creator === wallet.signingPublicKey}
            onClose={() => setSelectedAsset(null)}
            onSend={() => setShowSend(selectedAsset.symbol)}
            onReceive={() => setShowReceive(true)}
            onSwap={() => window.location.href = `/swap?token=${selectedAsset.symbol}`}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Wallet;
