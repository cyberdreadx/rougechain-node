import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Wallet, ArrowRightLeft, Coins, ArrowDown, Copy, Check, Bitcoin, ExternalLink, ChevronDown } from "lucide-react";
import { toDataURL } from "qrcode";
import { pubkeyToAddress } from "@/lib/address";
import { DeloreanLoader } from "@/components/ui/delorean-loader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { getBaseChainConfig, getUsdcAddress, isKnownBaseChain, expectedBaseChainId, BASE_MAINNET_CHAIN_ID } from "@/lib/bridge";
import { getActiveNetwork } from "@/lib/network";
import {
  getBridgeConfig,
  claimBridgeDeposit,
  claimBtcBridgeDeposit,
  getBtcDepositAddress,
  getMempoolTxUrl,
  bridgeWithdraw,
  type BridgeConfig,
  getXrgeBridgeConfig,
  claimXrgeBridgeDeposit,
  bridgeWithdrawXrge,
  type XrgeBridgeConfig,
  getBridgeHistory,
  type BridgeHistoryEntry,
  getPendingWithdrawals,
  type PendingWithdrawal,
} from "@/lib/bridge";
import { createSignedBridgeWithdraw, type TransactionPayload, generateNonce } from "@/lib/pqc-signer";
import { signViaExtension, getRougeChainProvider } from "@/lib/extension-bridge";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import { getWalletBalance } from "@/lib/pqc-wallet";
import { qethToHuman, humanToQeth, formatQethForDisplay, formatTokenAmount } from "@/hooks/use-eth-price";
import { useTranslation, Trans } from "react-i18next";

type BridgeDirection = "deposit" | "withdraw";
type BridgeAsset = "ETH" | "USDC" | "XRGE" | "BTC";

// ── EIP-6963 multi-wallet discovery ──────────────────────────────────────
// Lets the user pick which injected wallet to use (e.g. the RougeChain wallet
// extension instead of MetaMask) when more than one is present.
interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}
interface EIP6963ProviderInfo { uuid: string; name: string; icon: string; rdns: string }
interface EIP6963Detail { info: EIP6963ProviderInfo; provider: EIP1193Provider }
const ROUGECHAIN_RDNS = "io.rougechain.wallet";

const ASSETS: { id: BridgeAsset; label: string; icon: string; l1Label: string }[] = [
  { id: "ETH", label: "ETH", icon: "Ξ", l1Label: "qETH" },
  { id: "USDC", label: "USDC", icon: "$", l1Label: "qUSDC" },
  { id: "XRGE", label: "XRGE", icon: "✦", l1Label: "XRGE" },
  { id: "BTC", label: "BTC", icon: "₿", l1Label: "qBTC" },
];

const Bridge = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [xrgeConfig, setXrgeConfig] = useState<XrgeBridgeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [evmAddress, setEvmAddress] = useState("");
  const [rougechainPubkey, setRougechainPubkey] = useState("");
  const [direction, setDirection] = useState<BridgeDirection>("deposit");
  const [asset, setAsset] = useState<BridgeAsset>("ETH");
  const [amount, setAmount] = useState("");
  const [evmTarget, setEvmTarget] = useState("");
  const [processing, setProcessing] = useState(false);
  const [step, setStep] = useState("");
  const [claimTxHash, setClaimTxHash] = useState("");
  const [claimToken, setClaimToken] = useState<"ETH" | "USDC">("USDC");
  const [claimBusy, setClaimBusy] = useState(false);

  const [qethBalance, setQethBalance] = useState(0);
  const [qusdcBalance, setQusdcBalance] = useState(0);
  const [xrgeL1Balance, setXrgeL1Balance] = useState(0);
  const [qbtcBalance, setQbtcBalance] = useState(0); // raw satoshis (8-dec)

  // BTC deposit is manual (OP_RETURN + txid), so it has its own claim state.
  const [btcTxid, setBtcTxid] = useState("");
  const [btcClaimBusy, setBtcClaimBusy] = useState(false);
  const [rougeAddress, setRougeAddress] = useState(""); // rouge1… address for OP_RETURN
  const [btcCustodyQr, setBtcCustodyQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<"custody" | "recipient" | "deposit" | null>(null);

  // BTC "send from any wallet" deposit: a unique bc1… address bound to the user.
  const [btcDepositAddress, setBtcDepositAddress] = useState<string | null>(null);
  const [btcDepositQr, setBtcDepositQr] = useState<string | null>(null);
  const [btcAddrLoading, setBtcAddrLoading] = useState(false);
  const [btcAddrError, setBtcAddrError] = useState<string | null>(null);
  const [btcAdvancedOpen, setBtcAdvancedOpen] = useState(false);
  const [btcDepositReceived, setBtcDepositReceived] = useState<number | null>(null); // raw sats credited while panel open
  const btcBaselineRef = useRef<number | null>(null); // qBTC balance when the panel opened

  const [evmEthBalance, setEvmEthBalance] = useState(0);
  const [evmUsdcBalance, setEvmUsdcBalance] = useState(0);
  const [evmXrgeBalance, setEvmXrgeBalance] = useState(0);

  // Discovered EIP-6963 wallets + the one currently selected.
  const [discovered, setDiscovered] = useState<EIP6963Detail[]>([]);
  const [selectedRdns, setSelectedRdns] = useState<string | null>(null);

  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent<EIP6963Detail>).detail;
      if (!detail?.info?.rdns) return;
      setDiscovered((prev) => prev.some((p) => p.info.rdns === detail.info.rdns) ? prev : [...prev, detail]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  }, []);

  // Prefer the RougeChain wallet when present; otherwise the user's choice, else
  // the first announced provider, else the legacy evmProvider.
  const preferredDetail = discovered.find((d) => d.info.rdns === ROUGECHAIN_RDNS);
  const selectedDetail = discovered.find((d) => d.info.rdns === selectedRdns) ?? preferredDetail ?? discovered[0];
  const evmProvider = (selectedDetail?.provider
    ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum) as EIP1193Provider | undefined;

  useEffect(() => {
    Promise.all([
      getBridgeConfig().catch(() => ({ enabled: false, chainId: 84532 }) as BridgeConfig),
      getXrgeBridgeConfig().catch(() => ({ enabled: false, chainId: 84532 }) as XrgeBridgeConfig),
    ]).then(([ethCfg, xrgeCfg]) => {
      setConfig(ethCfg);
      setXrgeConfig(xrgeCfg);
    }).finally(() => setConfigLoading(false));
  }, []);

  useEffect(() => {
    const tryLoad = () => {
      const wallet = loadUnifiedWallet();
      if (wallet?.signingPublicKey) { setRougechainPubkey(wallet.signingPublicKey); return true; }
      return false;
    };
    if (!tryLoad()) {
      const retry = setTimeout(tryLoad, 1000);
      return () => clearTimeout(retry);
    }
  }, []);

  const refreshBalances = () => {
    const wallet = loadUnifiedWallet();
    if (!wallet?.signingPublicKey) return;
    getWalletBalance(wallet.signingPublicKey).then((balances) => {
      setQethBalance(balances.find((b) => b.symbol === "qETH")?.balance ?? 0);
      setQusdcBalance(balances.find((b) => b.symbol === "qUSDC")?.balance ?? 0);
      setXrgeL1Balance(balances.find((b) => b.symbol === "XRGE")?.balance ?? 0);
      setQbtcBalance(balances.find((b) => b.symbol === "qBTC")?.balance ?? 0);
    });
  };

  useEffect(refreshBalances, [config]);

  // Derive the rouge1… address from the connected wallet's signing pubkey — this
  // is the exact string the user must place in the BTC deposit's OP_RETURN.
  useEffect(() => {
    if (!rougechainPubkey) { setRougeAddress(""); return; }
    let cancelled = false;
    pubkeyToAddress(rougechainPubkey)
      .then((addr) => { if (!cancelled) setRougeAddress(addr); })
      .catch(() => { if (!cancelled) setRougeAddress(""); });
    return () => { cancelled = true; };
  }, [rougechainPubkey]);

  // Render a QR of the bitcoin: URI so users can scan the custody address.
  useEffect(() => {
    const addr = config?.btcCustodyAddress;
    if (!addr) { setBtcCustodyQr(null); return; }
    let cancelled = false;
    toDataURL(`bitcoin:${addr}`, { width: 200, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => { if (!cancelled) setBtcCustodyQr(url); })
      .catch(() => { if (!cancelled) setBtcCustodyQr(null); });
    return () => { cancelled = true; };
  }, [config?.btcCustodyAddress]);

  const copyText = (value: string, which: "custody" | "recipient" | "deposit", label: string) => {
    navigator.clipboard.writeText(value);
    setCopied(which);
    toast.success(t("bridge.toasts.copied", { label }));
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000);
  };

  // Fetch (or re-fetch) the user's unique bc1… BTC deposit address. Bound to the
  // connected wallet's rouge1… address; the daemon returns the same address each
  // call. A "pool" error means the address pool is still warming up — retry.
  const loadBtcDepositAddress = async () => {
    if (!rougeAddress) return;
    setBtcAddrLoading(true);
    setBtcAddrError(null);
    try {
      const res = await getBtcDepositAddress(rougeAddress);
      if (res.success && res.address) {
        setBtcDepositAddress(res.address);
      } else {
        setBtcDepositAddress(null);
        const err = res.error || "";
        setBtcAddrError(/pool/i.test(err)
          ? t("bridge.btc.addressWarmingUp")
          : (err || t("bridge.btc.addressFetchFailed")));
      }
    } catch (e) {
      setBtcDepositAddress(null);
      setBtcAddrError(e instanceof Error ? e.message : t("bridge.btc.addressFetchFailed"));
    } finally {
      setBtcAddrLoading(false);
    }
  };

  // Auto-fetch the deposit address once the user is on BTC + Deposit with a
  // connected RougeChain wallet.
  useEffect(() => {
    if (direction === "deposit" && asset === "BTC" && rougeAddress && !btcDepositAddress && !btcAddrLoading) {
      loadBtcDepositAddress();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, asset, rougeAddress]);

  // Render a QR of the bitcoin: URI for the deposit address so users can scan it.
  useEffect(() => {
    if (!btcDepositAddress) { setBtcDepositQr(null); return; }
    let cancelled = false;
    toDataURL(`bitcoin:${btcDepositAddress}`, { width: 200, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => { if (!cancelled) setBtcDepositQr(url); })
      .catch(() => { if (!cancelled) setBtcDepositQr(null); });
    return () => { cancelled = true; };
  }, [btcDepositAddress]);

  // While the BTC deposit panel is open, snapshot the qBTC balance as a baseline
  // and poll for an increase every ~20s. When it grows, the deposit landed.
  useEffect(() => {
    if (!(direction === "deposit" && asset === "BTC")) return;
    btcBaselineRef.current = qbtcBalance;
    setBtcDepositReceived(null);
    const timer = setInterval(() => { refreshBalances(); }, 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, asset]);

  // Detect the credited qBTC once the balance rises above the panel-open baseline.
  useEffect(() => {
    if (!(direction === "deposit" && asset === "BTC")) return;
    const baseline = btcBaselineRef.current;
    if (baseline !== null && qbtcBalance > baseline) {
      setBtcDepositReceived(qbtcBalance - baseline);
    }
  }, [qbtcBalance, direction, asset]);

  const refreshEvmBalances = async () => {
    if (!evmAddress || typeof evmProvider === "undefined") return;
    try {
      const ethHex = await evmProvider.request({ method: "eth_getBalance", params: [evmAddress, "latest"] }) as string;
      setEvmEthBalance(Number(BigInt(ethHex)) / 1e18);

      const balanceOfSig = "0x70a08231" + evmAddress.slice(2).padStart(64, "0");

      const usdcHex = await evmProvider.request({ method: "eth_call", params: [{ to: usdcAddress, data: balanceOfSig }, "latest"] }) as string;
      setEvmUsdcBalance(Number(BigInt(usdcHex)) / 1e6);

      const xrgeAddr = xrgeConfig?.tokenAddress;
      if (xrgeAddr) {
        const xrgeHex = await evmProvider.request({ method: "eth_call", params: [{ to: xrgeAddr, data: balanceOfSig }, "latest"] }) as string;
        setEvmXrgeBalance(Number(BigInt(xrgeHex)) / 1e18);
      }
    } catch (e) {
      console.log("Failed to fetch EVM balances", e);
    }
  };

  useEffect(() => { refreshEvmBalances(); }, [evmAddress, xrgeConfig]);

  // Detect chain from daemon config. No mainnet fallback: if neither config
  // reports a recognized Base chain, detectedChainId stays undefined and the
  // bridge fails closed (see the "Network not confirmed" guard in render).
  const detectedChainId = config?.chainId ?? xrgeConfig?.chainId;
  const networkKnown = isKnownBaseChain(detectedChainId);
  // L1↔Base consistency: the RougeChain network the site is pointed at dictates
  // which Base chain is legitimate. A testnet L1 reporting Base mainnet (real
  // XRGE) is a misconfig — refuse to bridge rather than move real funds.
  const activeNetwork = getActiveNetwork();
  const expectedChainId = expectedBaseChainId(activeNetwork);
  const networkMismatch = networkKnown && detectedChainId !== expectedChainId;
  const bridgeSafe = networkKnown && !networkMismatch;
  // Labels/addresses below are only ever used once networkKnown is true; the
  // fallback here just keeps the helpers total for the unknown-network render.
  const chainConfig = getBaseChainConfig(detectedChainId ?? BASE_MAINNET_CHAIN_ID);
  const chainLabel = chainConfig.name; // "Base" or "Base Sepolia"
  const usdcAddress = getUsdcAddress(detectedChainId ?? BASE_MAINNET_CHAIN_ID);

  const connectEvm = async () => {
    if (typeof evmProvider === "undefined") {
      toast.error(t("bridge.errors.installWallet"));
      return;
    }
    if (!isKnownBaseChain(detectedChainId) || networkMismatch) {
      toast.error(t("bridge.errors.networkNotConfirmed"));
      return;
    }
    try {
      const chainIdHex = `0x${detectedChainId.toString(16)}`;
      await evmProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }).catch(async () => {
        await evmProvider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: chainIdHex, chainName: chainConfig.name, nativeCurrency: chainConfig.nativeCurrency, rpcUrls: [chainConfig.rpcUrls.default.http[0]], blockExplorerUrls: [chainConfig.blockExplorers.default.url] }],
        });
      });
      const accounts = await evmProvider.request({ method: "eth_requestAccounts" }) as string[];
      setEvmAddress(accounts[0]);
      setEvmTarget(accounts[0]);
      toast.success(t("bridge.toasts.connected", { chain: chainLabel }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.errors.connectFailed"));
    }
  };

  const getL1Balance = () => {
    if (asset === "ETH") return formatQethForDisplay(qethBalance) + " qETH";
    if (asset === "USDC") return (qusdcBalance / 1e6).toFixed(2) + " qUSDC";
    if (asset === "BTC") return (qbtcBalance / 1e8).toFixed(8) + " qBTC";
    return xrgeL1Balance.toLocaleString() + " XRGE";
  };

  // Readable L1 balance for an asset, using the shared display helpers (no new
  // decimal logic): qBTC/qETH/qUSDC via formatTokenAmount, XRGE as-is.
  const assetL1Balance = (id: BridgeAsset): string => {
    if (id === "ETH") return formatTokenAmount(qethBalance, "qETH");
    if (id === "USDC") return formatTokenAmount(qusdcBalance, "qUSDC");
    if (id === "BTC") return formatTokenAmount(qbtcBalance, "qBTC");
    return xrgeL1Balance.toLocaleString();
  };

  // On deposit you're sending the SOURCE asset (ETH/USDC/XRGE on Base, BTC from any wallet),
  // so show that balance — not the qToken you'll receive. BTC is sent from an external wallet
  // the page can't read, so it shows no balance.
  const assetSourceBalance = (id: BridgeAsset): string => {
    if (id === "BTC" || !evmAddress) return "";
    if (id === "ETH") return evmEthBalance.toFixed(4);
    if (id === "USDC") return evmUsdcBalance.toFixed(2);
    return evmXrgeBalance.toLocaleString();
  };

  const currentAsset = ASSETS.find(a => a.id === asset)!;

  // Only offer BTC when the daemon actually configured the BTC bridge.
  const btcConfigured = !!config?.btcCustodyAddress
    && (config?.supportedTokens?.includes("BTC") ?? true);
  const visibleAssets = ASSETS.filter((a) => a.id !== "BTC" || btcConfigured);

  // ── Deposit: Base → RougeChain ────────────────────────────────

  // Poll a bridge claim until Base confirmations are met (~6): the deposit is on
  // Base immediately but the node only honors the claim after confirmations, so a
  // single early claim would leave funds stuck. The signature (over tx hash +
  // recipient) is stable, so it is reused across retries.
  const pollBridgeClaim = async (
    txHash: string,
    evmSignature: string,
    recipient: string,
    token: "ETH" | "USDC",
    onProgress?: (attempt: number) => void,
  ): Promise<{ success: boolean; error?: string }> => {
    let last = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      const claim = await claimBridgeDeposit({ evmTxHash: txHash, evmAddress, evmSignature, recipientRougechainPubkey: recipient, token });
      if (claim.success) return { success: true };
      last = claim.error || "";
      onProgress?.(attempt + 1);
      await new Promise((r) => setTimeout(r, 6000));
    }
    return { success: false, error: last || t("bridge.errors.baseTimeout") };
  };

  // Recover a deposit already sent to custody (e.g. a claim that ran too early).
  const handleClaimExisting = async () => {
    const tx = claimTxHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) { toast.error(t("bridge.errors.invalidBaseTxHash")); return; }
    if (!evmAddress) { toast.error(t("bridge.errors.connectSendingBaseWallet")); return; }
    if (!rougechainPubkey) { toast.error(t("bridge.errors.connectRougeToReceive")); return; }
    if (!evmProvider) { toast.error(t("bridge.errors.noBaseProvider")); return; }
    setClaimBusy(true);
    try {
      const recipient = rougechainPubkey;
      const claimMsg = `RougeChain bridge claim\nTx: ${tx}\nRecipient: ${recipient}`;
      const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map((b) => b.toString(16).padStart(2, "0")).join("");
      let sig = "";
      try {
        sig = await evmProvider.request({ method: "personal_sign", params: [msgHex, evmAddress] }) as string;
      } catch {
        toast.error(t("bridge.errors.signatureRejected"));
        setClaimBusy(false);
        return;
      }
      const claim = await pollBridgeClaim(tx, sig, recipient, claimToken);
      if (claim.success) {
        toast.success(t("bridge.toasts.claimed", { token: claimToken === "USDC" ? "qUSDC" : "qETH" }));
        setClaimTxHash("");
        setTimeout(() => { refreshBalances(); refreshEvmBalances(); }, 3000);
      } else {
        toast.error(claim.error || t("bridge.errors.claimFailed"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.errors.claimFailed"));
    } finally {
      setClaimBusy(false);
    }
  };

  // Poll a BTC claim until Bitcoin confirmations are met. The claim is idempotent
  // (dedupe key btc:{txid}) so the same txid is safely retried; an already-claimed
  // deposit returns success immediately.
  const pollBtcClaim = async (
    txid: string,
    recipient: string,
    onProgress?: (attempt: number) => void,
  ): Promise<{ success: boolean; error?: string }> => {
    let last = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      const claim = await claimBtcBridgeDeposit({ btcTxid: txid, recipientRougechainPubkey: recipient || undefined });
      if (claim.success) return { success: true };
      last = claim.error || "";
      onProgress?.(attempt + 1);
      await new Promise((r) => setTimeout(r, 6000));
    }
    return { success: false, error: last || t("bridge.errors.bitcoinTimeout") };
  };

  // Claim a BTC deposit by txid: used both for a fresh deposit and to recover an
  // existing one sent earlier (mirrors handleClaimExisting for ETH/USDC).
  const handleBtcClaim = async () => {
    const txid = btcTxid.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) { toast.error(t("bridge.errors.invalidBtcTxid")); return; }
    if (!rougechainPubkey) { toast.error(t("bridge.errors.connectRougeToReceiveQbtc")); return; }
    setBtcClaimBusy(true);
    setStep(t("bridge.steps.waitingBitcoin"));
    try {
      const claim = await pollBtcClaim(txid, rougeAddress, (a) => setStep(t("bridge.steps.waitingBitcoinAttempt", { attempt: a })));
      if (claim.success) {
        toast.success(t("bridge.toasts.claimedQbtc"));
        setBtcTxid("");
        setTimeout(() => { refreshBalances(); }, 3000);
      } else {
        toast.info(`${t("bridge.toasts.btcNotConfirmedYet")}${claim.error ? ` (${claim.error})` : ""}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.errors.btcClaimFailed"));
    } finally {
      setBtcClaimBusy(false);
      setStep("");
    }
  };

  const handleDeposit = async () => {
    if (!bridgeSafe) { toast.error(t("bridge.errors.networkNotConfirmed")); return; }
    // BTC has no wallet-connect send: the deposit is manual (OP_RETURN) and the
    // "deposit" action is really claiming by the pasted Bitcoin txid.
    if (asset === "BTC") { await handleBtcClaim(); return; }
    if (!evmAddress) { toast.error(t("bridge.errors.connectBaseFirst")); return; }
    if (!evmProvider) { toast.error(t("bridge.errors.noBaseWallet")); return; }
    if (!rougechainPubkey) { toast.error(t("bridge.errors.rougeNotConnected")); return; }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { toast.error(t("bridge.errors.invalidAmount")); return; }

    if (asset === "ETH" && amountNum > evmEthBalance) { toast.error(t("bridge.errors.insufficientOnBase", { symbol: "ETH" })); return; }
    if (asset === "USDC" && amountNum > evmUsdcBalance) { toast.error(t("bridge.errors.insufficientOnBase", { symbol: "USDC" })); return; }
    if (asset === "XRGE" && amountNum > evmXrgeBalance) { toast.error(t("bridge.errors.insufficientOnBase", { symbol: "XRGE" })); return; }

    setProcessing(true);

    try {
      if (asset === "XRGE") {
        if (!xrgeConfig?.vaultAddress || !xrgeConfig?.tokenAddress) { toast.error(t("bridge.errors.xrgeNotConfigured")); setProcessing(false); return; }
        const tokenAddr = xrgeConfig.tokenAddress;
        const vaultAddr = xrgeConfig.vaultAddress;
        const amountWei = "0x" + (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(16);

        setStep(t("bridge.steps.approvingXrge"));
        const approveData = `0x095ea7b3${vaultAddr.slice(2).padStart(64, "0")}${BigInt(amountWei).toString(16).padStart(64, "0")}`;
        const approveTxHash = await evmProvider.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: tokenAddr, data: approveData }] }) as string;

        setStep(t("bridge.steps.waitingApproval"));
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await evmProvider.request({ method: "eth_getTransactionReceipt", params: [approveTxHash] });
          if (receipt) break;
        }

        setStep(t("bridge.steps.depositingVault"));
        const pubkeyHex = Array.from(new TextEncoder().encode(rougechainPubkey)).map(b => b.toString(16).padStart(2, "0")).join("");
        const paddedPubkey = pubkeyHex.padEnd(Math.ceil(pubkeyHex.length / 64) * 64, "0");
        const depositData = "0xf1215d25" + BigInt(amountWei).toString(16).padStart(64, "0") + (64).toString(16).padStart(64, "0") + rougechainPubkey.length.toString(16).padStart(64, "0") + paddedPubkey;
        const depositTx = await evmProvider.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: vaultAddr, data: depositData, gas: "0x7A120" }] }) as string;

        setStep(t("bridge.steps.waitingDeposit"));
        let depositConfirmed = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await evmProvider.request({ method: "eth_getTransactionReceipt", params: [depositTx] }) as { status?: string } | null;
          if (receipt) {
            depositConfirmed = receipt.status === "0x1";
            break;
          }
        }
        if (!depositConfirmed) { toast.error(t("bridge.errors.depositTxFailed")); setProcessing(false); return; }

        // The claim is only honored after a minimum number of Base confirmations,
        // so the first attempt right after the deposit usually reports "pending".
        // Poll (the claim is idempotent via its SHA-256 nullifier) until it lands
        // rather than showing a one-shot "claim pending" false alarm.
        setStep(t("bridge.steps.waitingBase"));
        const claimParams = { evmTxHash: depositTx, evmAddress, amount: (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(), recipientRougechainPubkey: rougechainPubkey };
        let claimed = false;
        let lastError = "";
        for (let attempt = 0; attempt < 30; attempt++) {
          const claim = await claimXrgeBridgeDeposit(claimParams);
          if (claim.success) { claimed = true; break; }
          lastError = claim.error || "";
          setStep(t("bridge.steps.waitingBaseAttempt", { attempt: attempt + 1 }));
          await new Promise((r) => setTimeout(r, 6000));
        }
        if (claimed) {
          toast.success(t("bridge.toasts.bridgedXrge", { amount: amountNum }));
          setXrgeL1Balance((prev) => prev + amountNum);
          setEvmXrgeBalance((prev) => prev - amountNum);
        } else {
          // Still not confirmed after ~3 min — the deposit is valid and the node's
          // auto-claim will finish it; nothing more for the user to do.
          toast.info(`${t("bridge.toasts.xrgeArrivesAutomatically")}${lastError ? ` (${lastError})` : ""}`);
        }
      } else {
        if (!config?.custodyAddress) { toast.error(t("bridge.errors.notConfigured")); setProcessing(false); return; }

        if (asset === "ETH") {
          setStep(t("bridge.steps.sendingToBridge", { symbol: "ETH" }));
          const weiHex = "0x" + (BigInt(Math.round(amountNum * 1e18))).toString(16);
          const txHash = await evmProvider.request({
            method: "eth_sendTransaction",
            params: [{ from: evmAddress, to: config.custodyAddress, value: weiHex }],
          });
          await new Promise(r => setTimeout(r, 5000));

          setStep(t("bridge.steps.signingClaim"));
          const recipient = rougechainPubkey;
          const claimMsg = `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`;
          const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map(b => b.toString(16).padStart(2, "0")).join("");
          let sig = "";
          try {
            sig = await evmProvider.request({ method: "personal_sign", params: [msgHex, evmAddress] }) as string;
          } catch {
            // Smart contract wallets (Base wallet) may not support personal_sign — backend handles this
          }

          setStep(t("bridge.steps.waitingBase"));
          const claim = await pollBridgeClaim(txHash as string, sig, recipient, "ETH", (a) => setStep(t("bridge.steps.waitingBaseAttempt", { attempt: a })));
          if (claim.success) {
            toast.success(t("bridge.toasts.bridgedEvm", { amount: amountNum, from: "ETH", to: "qETH" }));
            setQethBalance((prev) => prev + humanToQeth(amountNum));
            setEvmEthBalance((prev) => prev - amountNum);
          } else {
            toast.info(t("bridge.toasts.depositSentPending", { token: "qETH", tx: (txHash as string).slice(0, 12), error: claim.error || "" }));
          }
        } else {
          setStep(t("bridge.steps.sendingToBridge", { symbol: "USDC" }));
          const usdcAddr = usdcAddress;
          const usdcAmount = "0x" + (BigInt(Math.round(amountNum * 1e6))).toString(16);
          const transferData = `0xa9059cbb${config.custodyAddress.slice(2).padStart(64, "0")}${BigInt(usdcAmount).toString(16).padStart(64, "0")}`;
          const txHash = await evmProvider.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: usdcAddr, data: transferData }] });
          await new Promise(r => setTimeout(r, 5000));

          setStep(t("bridge.steps.signingClaim"));
          const recipient = rougechainPubkey;
          const claimMsg = `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`;
          const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map(b => b.toString(16).padStart(2, "0")).join("");
          let sig = "";
          try {
            sig = await evmProvider.request({ method: "personal_sign", params: [msgHex, evmAddress] }) as string;
          } catch {
            // Smart contract wallets may not support personal_sign
          }

          setStep(t("bridge.steps.waitingBase"));
          const claim = await pollBridgeClaim(txHash as string, sig, recipient, "USDC", (a) => setStep(t("bridge.steps.waitingBaseAttempt", { attempt: a })));
          if (claim.success) {
            toast.success(t("bridge.toasts.bridgedEvm", { amount: amountNum, from: "USDC", to: "qUSDC" }));
            setQusdcBalance((prev) => prev + Math.round(amountNum * 1e6));
            setEvmUsdcBalance((prev) => prev - amountNum);
          } else {
            toast.info(t("bridge.toasts.depositSentPending", { token: "qUSDC", tx: (txHash as string).slice(0, 12), error: claim.error || "" }));
          }
        }
      }
      setAmount("");
      setTimeout(() => { refreshBalances(); refreshEvmBalances(); }, 3000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.errors.depositFailed"));
    } finally {
      setProcessing(false);
      setStep("");
    }
  };

  // ── Withdraw: RougeChain → Base ───────────────────────────────

  const signBridgeWithdraw = async (
    pubKey: string,
    privKey: string,
    withdrawAmount: number,
    evmAddr: string,
    tokenSymbol: string
  ) => {
    // qBTC withdrawals carry a Bitcoin address in the evmAddress field — it must
    // be signed and stored verbatim, never 0x-prefixed like a real EVM address.
    const isBtc = tokenSymbol === "qBTC";
    if (privKey) {
      return createSignedBridgeWithdraw(pubKey, privKey, withdrawAmount, evmAddr, tokenSymbol, 0.1, !isBtc);
    }
    const payload: TransactionPayload = {
      type: "bridge_withdraw",
      from: pubKey,
      amount: withdrawAmount,
      fee: 0.1,
      tokenSymbol,
      evmAddress: isBtc || evmAddr.startsWith("0x") ? evmAddr : `0x${evmAddr}`,
      timestamp: Date.now(),
      nonce: generateNonce(),
    };
    return signViaExtension(payload, pubKey);
  };

  const handleWithdraw = async () => {
    if (!bridgeSafe) { toast.error(t("bridge.errors.networkNotConfirmed")); return; }
    const wallet = loadUnifiedWallet();
    const hasKey = !!wallet?.signingPrivateKey;
    const hasProvider = !!getRougeChainProvider();
    if (!wallet?.signingPublicKey || (!hasKey && !hasProvider)) { toast.error(t("bridge.errors.connectRougeFirst")); return; }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { toast.error(t("bridge.errors.invalidAmount")); return; }

    // qBTC withdraws to a Bitcoin address (goes in the evmAddress field verbatim).
    if (asset === "BTC") {
      const btcAddr = evmTarget.trim();
      if (btcAddr.length < 14) { toast.error(t("bridge.errors.invalidBtcAddress")); return; }
      const amountUnits = Math.round(amountNum * 1e8); // 1 unit = 1 satoshi
      if (amountUnits <= 0) { toast.error(t("bridge.errors.invalidQbtcAmount")); return; }
      if (amountUnits > qbtcBalance) { toast.error(t("bridge.errors.insufficientBalance", { symbol: "qBTC" })); return; }
      setProcessing(true);
      try {
        setStep(t("bridge.steps.submittingWithdrawal"));
        const signed = await signBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountUnits, btcAddr, "qBTC");
        const result = await bridgeWithdraw({ fromPublicKey: wallet.signingPublicKey, amountUnits, evmAddress: btcAddr, tokenSymbol: "qBTC", signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) {
          toast.success(t("bridge.toasts.withdrawQueuedBtc"));
          setQbtcBalance((prev) => prev - amountUnits);
          setAmount("");
          setTimeout(() => { refreshBalances(); }, 3000);
        } else {
          toast.error(result.error || t("bridge.errors.withdrawFailed"));
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t("bridge.errors.withdrawFailed"));
      } finally {
        setProcessing(false);
        setStep("");
      }
      return;
    }

    const evm = evmTarget.trim();
    if (!evm || (evm.startsWith("0x") ? evm.length !== 42 : evm.length !== 40)) { toast.error(t("bridge.errors.invalidEvmAddress")); return; }
    const evmAddr = evm.startsWith("0x") ? evm : `0x${evm}`;

    setProcessing(true);

    try {
      let success = false;
      if (asset === "XRGE") {
        if (amountNum > xrgeL1Balance) { toast.error(t("bridge.errors.insufficientBalance", { symbol: "XRGE" })); setProcessing(false); return; }
        setStep(t("bridge.steps.submittingWithdrawal"));
        const signed = await signBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountNum, evmAddr, "XRGE");
        const result = await bridgeWithdrawXrge({ fromPublicKey: wallet.signingPublicKey, amount: amountNum, evmAddress: evmAddr, signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) {
          toast.success(t("bridge.toasts.withdrawSubmittedXrge"));
          setXrgeL1Balance((prev) => prev - amountNum);
          success = true;
        } else {
          toast.error(result.error || t("bridge.errors.withdrawFailed"));
        }
      } else {
        const isUsdc = asset === "USDC";
        const amountUnits = isUsdc ? Math.round(amountNum * 1e6) : humanToQeth(amountNum);
        const currentBalance = isUsdc ? qusdcBalance : qethBalance;
        const tokenLabel = isUsdc ? "qUSDC" : "qETH";
        if (amountUnits > currentBalance) { toast.error(t("bridge.errors.insufficientBalance", { symbol: tokenLabel })); setProcessing(false); return; }

        setStep(t("bridge.steps.submittingWithdrawal"));
        const signed = await signBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountUnits, evmAddr, tokenLabel);
        const result = await bridgeWithdraw({ fromPublicKey: wallet.signingPublicKey, amountUnits, evmAddress: evmAddr, tokenSymbol: tokenLabel, signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) {
          toast.success(t("bridge.toasts.withdrawSubmittedEvm", { symbol: asset }));
          if (isUsdc) setQusdcBalance((prev) => prev - amountUnits);
          else setQethBalance((prev) => prev - amountUnits);
          success = true;
        } else {
          toast.error(result.error || t("bridge.errors.withdrawFailed"));
        }
      }
      setAmount("");
      if (success) {
        setTimeout(() => { refreshBalances(); refreshEvmBalances(); }, 3000);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("bridge.errors.withdrawFailed"));
    } finally {
      setProcessing(false);
      setStep("");
    }
  };

  if (configLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <DeloreanLoader text={t("bridge.loader")} />
      </div>
    );
  }

  if (!config?.enabled && !xrgeConfig?.enabled) {
    return (
      <div className="container max-w-lg py-12">
        <Card>
          <CardContent className="p-8 text-center">
            <ArrowRightLeft className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">{t("bridge.notEnabled")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Fail closed: the bridge is enabled but the node didn't report a recognized
  // Base chain, so we can't tell mainnet from testnet. Refuse to render the form
  // rather than default to mainnet and send real XRGE against the wrong config.
  if (!networkKnown) {
    return (
      <div className="container max-w-lg py-12">
        <Card className="border-amber-500/40">
          <CardContent className="p-8 text-center space-y-2">
            <ArrowRightLeft className="w-10 h-10 mx-auto mb-1 text-amber-500" />
            <p className="font-semibold text-foreground">{t("bridge.networkUnknown.title")}</p>
            <p className="text-sm text-muted-foreground">
              <Trans
                i18nKey="bridge.networkUnknown.body"
                components={{ code: <code className="text-xs" /> }}
              />
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Fail closed: the node reports a valid Base chain, but the WRONG one for the
  // RougeChain network the site is on (e.g. testnet L1 reporting Base mainnet +
  // real XRGE). Bridging here would move real funds on a testnet — refuse.
  if (networkMismatch) {
    return (
      <div className="container max-w-lg py-12">
        <Card className="border-red-500/50">
          <CardContent className="p-8 text-center space-y-2">
            <ArrowRightLeft className="w-10 h-10 mx-auto mb-1 text-red-500" />
            <p className="font-semibold text-foreground">{t("bridge.networkMismatch.title")}</p>
            <p className="text-sm text-muted-foreground">
              <Trans
                i18nKey="bridge.networkMismatch.body"
                values={{
                  network: activeNetwork,
                  chainLabel,
                  chainId: detectedChainId,
                  assets: activeNetwork === "testnet" ? t("bridge.networkMismatch.realMainnetAssets") : t("bridge.networkMismatch.testnetAssets"),
                }}
                components={{
                  net: <span className="font-medium capitalize" />,
                  chain: <span className="font-medium" />,
                  code: <code className="text-xs" />,
                }}
              />
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isBtcAsset = asset === "BTC";
  const fromChain = direction === "deposit" ? (isBtcAsset ? "Bitcoin" : chainLabel) : "RougeChain";
  const toChain = direction === "deposit" ? "RougeChain" : (isBtcAsset ? "Bitcoin" : chainLabel);
  const fromToken = direction === "deposit" ? currentAsset.label : currentAsset.l1Label;
  const toToken = direction === "deposit" ? currentAsset.l1Label : currentAsset.label;

  return (
    <div className="container max-w-lg py-8 sm:py-12">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">

        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground">{t("bridge.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("bridge.subtitle")}</p>
        </div>

        <Card className="border-border/50 overflow-hidden">
          <CardContent className="p-0">

            {/* Direction toggle */}
            <div className="grid grid-cols-2 border-b border-border">
              <button
                onClick={() => setDirection("deposit")}
                className={`flex items-center justify-center gap-2 py-3.5 text-sm font-medium transition-colors ${direction === "deposit" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <ArrowDownToLine className="w-4 h-4" />
                {t("bridge.tabs.deposit")}
              </button>
              <button
                onClick={() => setDirection("withdraw")}
                className={`flex items-center justify-center gap-2 py-3.5 text-sm font-medium transition-colors ${direction === "withdraw" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <ArrowUpFromLine className="w-4 h-4" />
                {t("bridge.tabs.withdraw")}
              </button>
            </div>

            <div className="p-5 space-y-5">

              {/* Asset selector — dropdown showing each asset's readable L1 balance */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("bridge.asset")}</Label>
                <Select value={asset} onValueChange={(v) => setAsset(v as BridgeAsset)}>
                  <SelectTrigger className="w-full h-12">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {visibleAssets.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-2">
                          <span className="w-4 text-center">{a.icon}</span>
                          <span className="font-medium">{direction === "deposit" ? a.label : a.l1Label}</span>
                          {(() => {
                            const bal = direction === "deposit" ? assetSourceBalance(a.id) : assetL1Balance(a.id);
                            return bal ? <span className="text-muted-foreground">— {bal}</span> : null;
                          })()}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* ── BTC deposit: send from any wallet (no OP_RETURN) ── */}
              {direction === "deposit" && asset === "BTC" && (
                <div className="space-y-4">
                  {!rougechainPubkey ? (
                    <div className="rounded-xl bg-muted/30 border border-border/50 p-4 text-sm text-muted-foreground text-center">
                      {t("bridge.btc.connectForAddress")}
                    </div>
                  ) : btcDepositReceived !== null ? (
                    <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-4 space-y-2 text-center">
                      <Check className="w-8 h-8 mx-auto text-emerald-500" />
                      <p className="text-sm font-medium text-foreground">
                        {t("bridge.btc.received", { amount: formatTokenAmount(btcDepositReceived, "qBTC") })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("bridge.btc.nowInWallet")}
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-3">
                      <span className="text-sm font-medium text-foreground">{t("bridge.btc.yourDepositAddress")}</span>
                      {btcAddrLoading && <DeloreanLoader text={t("bridge.btc.fetchingAddress")} />}
                      {!btcAddrLoading && btcAddrError && (
                        <div className="space-y-2">
                          <p className="text-xs text-amber-500">{btcAddrError}</p>
                          <Button variant="outline" size="sm" onClick={loadBtcDepositAddress}>
                            {t("bridge.btc.tryAgain")}
                          </Button>
                        </div>
                      )}
                      {!btcAddrLoading && btcDepositAddress && (<>
                        {btcDepositQr && (
                          <div className="flex justify-center">
                            <img src={btcDepositQr} alt={t("bridge.btc.depositQrAlt")} className="w-40 h-40 rounded-lg bg-white p-2" />
                          </div>
                        )}
                        <div className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2">
                          <code className="text-xs font-mono break-all flex-1 text-foreground">{btcDepositAddress}</code>
                          <button
                            type="button"
                            onClick={() => copyText(btcDepositAddress, "deposit", t("bridge.btc.depositAddressLabel"))}
                            className="shrink-0 p-1 rounded hover:bg-muted"
                            title={t("bridge.btc.copyDepositAddress")}
                          >
                            {copied === "deposit" ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("bridge.btc.sendFromAnyWallet")}
                        </p>
                        {config?.btcNetwork === "testnet" && (
                          <p className="text-xs text-amber-500">{t("bridge.btc.testnetOnly")}</p>
                        )}
                      </>)}
                    </div>
                  )}

                  {/* Advanced: legacy OP_RETURN deposit + manual claim by txid */}
                  <Collapsible open={btcAdvancedOpen} onOpenChange={setBtcAdvancedOpen}>
                    <CollapsibleTrigger className="flex items-center justify-between w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
                      <span>{t("bridge.btc.advanced.title")}</span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${btcAdvancedOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-4 pt-3">
                      <p className="text-xs text-muted-foreground">
                        {t("bridge.btc.advanced.intro")}
                      </p>

                      {/* Step 1: send BTC to custody */}
                      <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-semibold">1</span>
                          <span className="text-sm font-medium text-foreground">{t("bridge.btc.advanced.step1")}</span>
                        </div>
                        {btcCustodyQr && (
                          <div className="flex justify-center">
                            <img src={btcCustodyQr} alt={t("bridge.btc.advanced.custodyQrAlt")} className="w-40 h-40 rounded-lg bg-white p-2" />
                          </div>
                        )}
                        <div className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2">
                          <code className="text-xs font-mono break-all flex-1 text-foreground">{config?.btcCustodyAddress ?? "—"}</code>
                          <button
                            type="button"
                            onClick={() => config?.btcCustodyAddress && copyText(config.btcCustodyAddress, "custody", t("bridge.btc.advanced.custodyAddressLabel"))}
                            className="shrink-0 p-1 rounded hover:bg-muted"
                            title={t("bridge.btc.advanced.copyCustodyAddress")}
                          >
                            {copied === "custody" ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                        {config?.btcNetwork === "testnet" && (
                          <p className="text-xs text-amber-500">{t("bridge.btc.testnetOnly")}</p>
                        )}
                      </div>

                      {/* Step 2: OP_RETURN binding */}
                      <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-semibold">2</span>
                          <span className="text-sm font-medium text-foreground">{t("bridge.btc.advanced.step2")}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("bridge.btc.advanced.step2Help")}
                        </p>
                        <div className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2">
                          <code className="text-xs font-mono break-all flex-1 text-foreground">{rougeAddress || t("bridge.btc.advanced.connectWalletPlaceholder")}</code>
                          <button
                            type="button"
                            onClick={() => rougeAddress && copyText(rougeAddress, "recipient", t("bridge.btc.advanced.rougeAddressLabel"))}
                            disabled={!rougeAddress}
                            className="shrink-0 p-1 rounded hover:bg-muted disabled:opacity-40"
                            title={t("bridge.btc.advanced.copyRougeAddress")}
                          >
                            {copied === "recipient" ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("bridge.btc.advanced.opReturnWallets")}
                        </p>
                      </div>

                      {/* Step 3: claim by txid */}
                      <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-semibold">3</span>
                          <span className="text-sm font-medium text-foreground">{t("bridge.btc.advanced.step3")}</span>
                        </div>
                        <Input
                          placeholder={t("bridge.btc.advanced.txidPlaceholder")}
                          value={btcTxid}
                          onChange={(e) => setBtcTxid(e.target.value)}
                          className="font-mono text-xs"
                        />
                        {btcClaimBusy && <DeloreanLoader text={step || t("bridge.steps.waitingBitcoin")} />}
                        <Button
                          onClick={handleBtcClaim}
                          disabled={btcClaimBusy || !btcTxid.trim() || !rougechainPubkey}
                          className="w-full h-12 text-base gap-2"
                        >
                          {btcClaimBusy ? (
                            <><Loader2 className="w-4 h-4 animate-spin" /> {step || t("bridge.claim.claiming")}</>
                          ) : (
                            <><Bitcoin className="w-4 h-4" /> {t("bridge.btc.advanced.claimButton")}</>
                          )}
                        </Button>
                        <p className="text-xs text-muted-foreground text-center">
                          {t("bridge.btc.advanced.claimHelp")}
                        </p>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              )}

              {/* Standard EVM deposit form / all withdrawals (BTC deposit uses the panel above) */}
              {!(direction === "deposit" && asset === "BTC") && (<>

              {/* From */}
              <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <span className="text-xs text-muted-foreground">{t("bridge.form.from", { chain: fromChain })}</span>
                  {direction === "withdraw" && (
                    <span className="text-xs text-muted-foreground">{t("bridge.form.balance", { balance: getL1Balance() })}</span>
                  )}
                  {direction === "deposit" && evmAddress && (
                    <span className="text-xs text-muted-foreground">
                      {t("bridge.form.balance", { balance: asset === "ETH" ? evmEthBalance.toLocaleString(undefined, { maximumFractionDigits: 6 }) + " ETH"
                        : asset === "USDC" ? evmUsdcBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " USDC"
                        : evmXrgeBalance.toLocaleString(undefined, { maximumFractionDigits: 6 }) + " XRGE" })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    placeholder="0.0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="border-0 bg-transparent text-xl font-medium p-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/40"
                  />
                  <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">{fromToken}</span>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center -my-2">
                <div className="w-9 h-9 rounded-full bg-muted border border-border flex items-center justify-center">
                  <ArrowDown className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>

              {/* To */}
              <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("bridge.form.to", { chain: toChain })}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xl font-medium text-foreground/80">
                    {amount && !isNaN(parseFloat(amount)) ? parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: isBtcAsset ? 8 : 6 }) : "0.0"}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">{toToken}</span>
                </div>
              </div>

              {/* Destination address (for withdrawals) */}
              {direction === "withdraw" && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {isBtcAsset ? t("bridge.form.receiveAtBitcoin") : t("bridge.form.receiveAtBase")}
                  </Label>
                  <Input
                    placeholder={isBtcAsset ? (config?.btcNetwork === "testnet" ? t("bridge.form.btcTestnetAddressPlaceholder") : t("bridge.form.btcAddressPlaceholder")) : "0x..."}
                    value={evmTarget}
                    onChange={(e) => setEvmTarget(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
              )}

              {/* DeLorean loader during processing */}
              {processing && (
                <DeloreanLoader text={step || t("bridge.processing")} />
              )}

              {/* Wallet picker — shown when more than one injected wallet is present */}
              {direction === "deposit" && !evmAddress && discovered.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{t("bridge.form.chooseWallet")}</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {discovered.map((d) => {
                      const active = (selectedDetail?.info.rdns ?? "") === d.info.rdns;
                      return (
                        <button
                          key={d.info.rdns}
                          type="button"
                          onClick={() => setSelectedRdns(d.info.rdns)}
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card/40 text-muted-foreground hover:text-foreground"}`}
                        >
                          {d.info.icon ? <img src={d.info.icon} alt="" className="w-5 h-5 rounded" /> : <Wallet className="w-4 h-4" />}
                          <span className="truncate">{d.info.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Connect wallet / Action button */}
              {direction === "deposit" && !evmAddress ? (
                <Button onClick={connectEvm} variant="outline" className="w-full gap-2 h-12 whitespace-nowrap text-sm">
                  <Wallet className="w-4 h-4 shrink-0" />
                  <span className="hidden sm:inline">{t("bridge.form.connectWalletWithChain", { wallet: selectedDetail?.info.name ?? t("bridge.form.baseWallet"), chain: chainLabel })}</span>
                  <span className="sm:hidden">{t("bridge.form.connectWallet", { wallet: selectedDetail?.info.name ?? t("bridge.form.baseWallet") })}</span>
                </Button>
              ) : (
                <Button
                  onClick={direction === "deposit" ? handleDeposit : handleWithdraw}
                  disabled={processing || !amount || parseFloat(amount) <= 0}
                  className="w-full h-12 text-base gap-2"
                >
                  {processing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {step || t("bridge.processing")}
                    </>
                  ) : direction === "deposit" ? (
                    <>
                      <ArrowDownToLine className="w-4 h-4" />
                      {t("bridge.form.bridgeTo", { asset: currentAsset.label, chain: "RougeChain" })}
                    </>
                  ) : (
                    <>
                      <ArrowUpFromLine className="w-4 h-4" />
                      {t("bridge.form.bridgeTo", { asset: currentAsset.l1Label, chain: isBtcAsset ? "Bitcoin" : "Base" })}
                    </>
                  )}
                </Button>
              )}

              {/* Connected wallet info */}
              {evmAddress && direction === "deposit" && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  {evmAddress.slice(0, 6)}...{evmAddress.slice(-4)}
                </div>
              )}

              {/* Info text */}
              <p className="text-xs text-muted-foreground text-center">
                {direction === "deposit"
                  ? asset === "XRGE"
                    ? t("bridge.info.depositXrge")
                    : t("bridge.info.depositEvm", { asset, l1: currentAsset.l1Label })
                  : isBtcAsset
                    ? t("bridge.info.withdrawBtc")
                    : t("bridge.info.withdrawEvm")
                }
              </p>

              </>)}
            </div>
          </CardContent>
        </Card>

        {/* Claim an existing deposit already sent to custody */}
        <Card className="border-border">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ArrowDownToLine className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">{t("bridge.claim.title")}</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("bridge.claim.help")}
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("bridge.claim.txHashLabel")}</Label>
              <Input value={claimTxHash} onChange={(e) => setClaimTxHash(e.target.value)} placeholder="0x…" className="font-mono text-xs" />
            </div>
            <div className="flex items-center gap-2">
              {(["USDC", "ETH"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setClaimToken(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${claimToken === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <Button onClick={handleClaimExisting} disabled={claimBusy || !claimTxHash} className="w-full gap-2">
              {claimBusy ? (<><Loader2 className="w-4 h-4 animate-spin" /> {t("bridge.claim.claiming")}</>) : (<>{t("bridge.claim.button")}</>)}
            </Button>
          </CardContent>
        </Card>

        {/* In-flight withdrawal release status */}
        {rougechainPubkey && (
          <PendingWithdrawalsCard pubkey={rougechainPubkey} btcNetwork={config?.btcNetwork} />
        )}

        {/* Recent Bridge Activity */}
        {rougechainPubkey && (
          <BridgeActivityCard pubkey={rougechainPubkey} />
        )}

      </motion.div>
    </div>
  );
};

// ── Recent Bridge Activity Card ─────────────────────────────────

function BridgeActivityCard({ pubkey }: { pubkey: string }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<BridgeHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const entries = await getBridgeHistory(pubkey);
      if (!cancelled) {
        setHistory(entries);
        setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [pubkey]);

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="py-6 text-center">
          <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border">
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">{t("bridge.activity.title")}</h3>
        </div>
        {history.length === 0 ? (
          <div className="py-8 text-center">
            <ArrowRightLeft className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t("bridge.activity.empty")}</p>
            <p className="text-xs text-muted-foreground/70 mt-1">{t("bridge.activity.emptyHint")}</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {history.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    entry.direction === "deposit" ? "bg-green-500/10" : "bg-amber-500/10"
                  }`}>
                    {entry.direction === "deposit" ? (
                      <ArrowDownToLine className="w-4 h-4 text-green-500" />
                    ) : (
                      <ArrowUpFromLine className="w-4 h-4 text-amber-500" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {entry.direction === "deposit" ? t("bridge.activity.bridgedIn") : t("bridge.activity.bridgedOut")}
                    </p>
                    <p className="text-xs text-muted-foreground">{entry.timeLabel}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-mono font-medium ${
                    entry.direction === "deposit" ? "text-green-500" : "text-amber-500"
                  }`}>
                    {entry.direction === "deposit" ? "+" : "-"}{entry.amount} {entry.symbol}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">{entry.status === "pending" ? t("bridge.activity.statusPending") : entry.status === "completed" ? t("bridge.activity.statusCompleted") : entry.status}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Pending Withdrawal Status Card ──────────────────────────────

function PendingWithdrawalsCard({ pubkey, btcNetwork }: { pubkey: string; btcNetwork?: "mainnet" | "testnet" }) {
  const { t } = useTranslation();
  const [withdrawals, setWithdrawals] = useState<PendingWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await getPendingWithdrawals(pubkey);
      if (!cancelled) {
        setWithdrawals(entries);
        setLoading(false);
      }
    };
    load();
    // Poll while a release is in flight so the UI reflects relayer progress.
    const timer = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pubkey]);

  // Nothing pending and nothing to report — keep the page clean.
  if (!loading && withdrawals.length === 0) return null;

  const statusStyle = (status: PendingWithdrawal["status"]): { label: string; cls: string } => {
    switch (status) {
      case "failed": return { label: t("bridge.pending.status.retrying"), cls: "text-amber-500" };
      case "refunded": return { label: t("bridge.pending.status.refunded"), cls: "text-blue-500" };
      case "fulfilled": return { label: t("bridge.pending.status.released"), cls: "text-green-500" };
      default: return { label: t("bridge.pending.status.pending"), cls: "text-muted-foreground" };
    }
  };

  return (
    <Card className="border-border">
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">{t("bridge.pending.title")}</h3>
        </div>
        {loading ? (
          <div className="py-6 text-center">
            <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {withdrawals.map((w) => {
              const s = statusStyle(w.status);
              // qBTC amounts are satoshis (8-dec) — display in BTC.
              const isBtc = w.tokenSymbol === "qBTC";
              const amountLabel = isBtc ? (w.amount / 1e8).toFixed(8) : String(w.amount);
              return (
                <div key={w.txId} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {amountLabel} {w.tokenSymbol} → {w.evmAddress.slice(0, 8)}…{w.evmAddress.slice(-4)}
                    </p>
                    {w.status === "failed" && (
                      <p className="text-xs text-amber-500/80 truncate">
                        {t("bridge.pending.failedAttempts", { count: w.attempts })}
                        {w.lastError ? ` — ${w.lastError}` : ""}
                      </p>
                    )}
                    {isBtc && w.status === "fulfilled" && w.payoutTxid && (
                      <a
                        href={getMempoolTxUrl(w.payoutTxid, btcNetwork)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        {t("bridge.pending.viewOnMempool")} <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <p className={`text-xs font-medium whitespace-nowrap ${s.cls}`}>{s.label}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default Bridge;
