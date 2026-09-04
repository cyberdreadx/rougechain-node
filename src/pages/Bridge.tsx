import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Wallet, ArrowRightLeft, Coins, ArrowDown } from "lucide-react";
import { DeloreanLoader } from "@/components/ui/delorean-loader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { getBaseChainConfig, getUsdcAddress, isKnownBaseChain, expectedBaseChainId, BASE_MAINNET_CHAIN_ID } from "@/lib/bridge";
import { getActiveNetwork } from "@/lib/network";
import {
  getBridgeConfig,
  claimBridgeDeposit,
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
import { qethToHuman, humanToQeth, formatQethForDisplay } from "@/hooks/use-eth-price";

type BridgeDirection = "deposit" | "withdraw";
type BridgeAsset = "ETH" | "USDC" | "XRGE";

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
];

const Bridge = () => {
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

  const [qethBalance, setQethBalance] = useState(0);
  const [qusdcBalance, setQusdcBalance] = useState(0);
  const [xrgeL1Balance, setXrgeL1Balance] = useState(0);

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
    });
  };

  useEffect(refreshBalances, [config]);

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
      toast.error("Install a Base-compatible wallet (MetaMask, Coinbase Wallet, etc.)");
      return;
    }
    if (!isKnownBaseChain(detectedChainId) || networkMismatch) {
      toast.error("Network not confirmed — bridge disabled to protect your funds");
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
      toast.success(`Connected to ${chainLabel}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    }
  };

  const getL1Balance = () => {
    if (asset === "ETH") return formatQethForDisplay(qethBalance) + " qETH";
    if (asset === "USDC") return (qusdcBalance / 1e6).toFixed(2) + " qUSDC";
    return xrgeL1Balance.toLocaleString() + " XRGE";
  };

  const currentAsset = ASSETS.find(a => a.id === asset)!;

  // ── Deposit: Base → RougeChain ────────────────────────────────

  const handleDeposit = async () => {
    if (!bridgeSafe) { toast.error("Network not confirmed — bridge disabled to protect your funds"); return; }
    if (!evmAddress) { toast.error("Connect your Base wallet first"); return; }
    if (!evmProvider) { toast.error("No Base wallet available"); return; }
    if (!rougechainPubkey) { toast.error("RougeChain wallet not connected"); return; }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { toast.error("Enter a valid amount"); return; }

    if (asset === "ETH" && amountNum > evmEthBalance) { toast.error("Insufficient ETH balance on Base"); return; }
    if (asset === "USDC" && amountNum > evmUsdcBalance) { toast.error("Insufficient USDC balance on Base"); return; }
    if (asset === "XRGE" && amountNum > evmXrgeBalance) { toast.error("Insufficient XRGE balance on Base"); return; }

    setProcessing(true);

    try {
      if (asset === "XRGE") {
        if (!xrgeConfig?.vaultAddress || !xrgeConfig?.tokenAddress) { toast.error("XRGE bridge not fully configured"); setProcessing(false); return; }
        const tokenAddr = xrgeConfig.tokenAddress;
        const vaultAddr = xrgeConfig.vaultAddress;
        const amountWei = "0x" + (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(16);

        setStep("Approving XRGE...");
        const approveData = `0x095ea7b3${vaultAddr.slice(2).padStart(64, "0")}${BigInt(amountWei).toString(16).padStart(64, "0")}`;
        const approveTxHash = await evmProvider.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: tokenAddr, data: approveData }] }) as string;

        setStep("Waiting for approval confirmation...");
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await evmProvider.request({ method: "eth_getTransactionReceipt", params: [approveTxHash] });
          if (receipt) break;
        }

        setStep("Depositing to vault...");
        const pubkeyHex = Array.from(new TextEncoder().encode(rougechainPubkey)).map(b => b.toString(16).padStart(2, "0")).join("");
        const paddedPubkey = pubkeyHex.padEnd(Math.ceil(pubkeyHex.length / 64) * 64, "0");
        const depositData = "0xf1215d25" + BigInt(amountWei).toString(16).padStart(64, "0") + (64).toString(16).padStart(64, "0") + rougechainPubkey.length.toString(16).padStart(64, "0") + paddedPubkey;
        const depositTx = await evmProvider.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: vaultAddr, data: depositData, gas: "0x7A120" }] }) as string;

        setStep("Waiting for deposit confirmation...");
        let depositConfirmed = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await evmProvider.request({ method: "eth_getTransactionReceipt", params: [depositTx] }) as { status?: string } | null;
          if (receipt) {
            depositConfirmed = receipt.status === "0x1";
            break;
          }
        }
        if (!depositConfirmed) { toast.error("Deposit transaction failed or timed out on Base"); setProcessing(false); return; }

        setStep("Claiming on RougeChain...");
        const claim = await claimXrgeBridgeDeposit({ evmTxHash: depositTx, evmAddress, amount: (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(), recipientRougechainPubkey: rougechainPubkey });
        if (claim.success) {
          toast.success(`Bridged ${amountNum} XRGE to RougeChain!`);
          setXrgeL1Balance((prev) => prev + amountNum);
          setEvmXrgeBalance((prev) => prev - amountNum);
        } else {
          toast.warning(`Deposit sent but L1 claim pending. ${claim.error || ""}`);
        }
      } else {
        if (!config?.custodyAddress) { toast.error("Bridge not configured"); setProcessing(false); return; }

        if (asset === "ETH") {
          setStep("Sending ETH to bridge...");
          const weiHex = "0x" + (BigInt(Math.round(amountNum * 1e18))).toString(16);
          const txHash = await evmProvider.request({
            method: "eth_sendTransaction",
            params: [{ from: evmAddress, to: config.custodyAddress, value: weiHex }],
          });
          await new Promise(r => setTimeout(r, 5000));

          setStep("Signing claim...");
          const recipient = rougechainPubkey;
          const claimMsg = `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`;
          const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map(b => b.toString(16).padStart(2, "0")).join("");
          let sig = "";
          try {
            sig = await evmProvider.request({ method: "personal_sign", params: [msgHex, evmAddress] }) as string;
          } catch {
            // Smart contract wallets (Base wallet) may not support personal_sign — backend handles this
          }

          setStep("Claiming qETH...");
          const claim = await claimBridgeDeposit({ evmTxHash: txHash as string, evmAddress, evmSignature: sig, recipientRougechainPubkey: recipient, token: "ETH" });
          if (claim.success) {
            toast.success(`Claimed ${amountNum} ETH as qETH!`);
            setQethBalance((prev) => prev + humanToQeth(amountNum));
            setEvmEthBalance((prev) => prev - amountNum);
          } else {
            toast.error(claim.error || "Claim failed");
          }
        } else {
          setStep("Sending USDC to bridge...");
          const usdcAddr = usdcAddress;
          const usdcAmount = "0x" + (BigInt(Math.round(amountNum * 1e6))).toString(16);
          const transferData = `0xa9059cbb${config.custodyAddress.slice(2).padStart(64, "0")}${BigInt(usdcAmount).toString(16).padStart(64, "0")}`;
          const txHash = await evmProvider.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: usdcAddr, data: transferData }] });
          await new Promise(r => setTimeout(r, 5000));

          setStep("Signing claim...");
          const recipient = rougechainPubkey;
          const claimMsg = `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`;
          const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map(b => b.toString(16).padStart(2, "0")).join("");
          let sig = "";
          try {
            sig = await evmProvider.request({ method: "personal_sign", params: [msgHex, evmAddress] }) as string;
          } catch {
            // Smart contract wallets may not support personal_sign
          }

          setStep("Claiming qUSDC...");
          const claim = await claimBridgeDeposit({ evmTxHash: txHash as string, evmAddress, evmSignature: sig, recipientRougechainPubkey: recipient, token: "USDC" });
          if (claim.success) {
            toast.success(`Claimed ${amountNum} USDC as qUSDC!`);
            setQusdcBalance((prev) => prev + Math.round(amountNum * 1e6));
            setEvmUsdcBalance((prev) => prev - amountNum);
          } else {
            toast.error(claim.error || "Claim failed");
          }
        }
      }
      setAmount("");
      setTimeout(() => { refreshBalances(); refreshEvmBalances(); }, 3000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bridge deposit failed");
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
    if (privKey) {
      return createSignedBridgeWithdraw(pubKey, privKey, withdrawAmount, evmAddr, tokenSymbol);
    }
    const payload: TransactionPayload = {
      type: "bridge_withdraw",
      from: pubKey,
      amount: withdrawAmount,
      fee: 0.1,
      tokenSymbol,
      evmAddress: evmAddr.startsWith("0x") ? evmAddr : `0x${evmAddr}`,
      timestamp: Date.now(),
      nonce: generateNonce(),
    };
    return signViaExtension(payload, pubKey);
  };

  const handleWithdraw = async () => {
    if (!bridgeSafe) { toast.error("Network not confirmed — bridge disabled to protect your funds"); return; }
    const wallet = loadUnifiedWallet();
    const hasKey = !!wallet?.signingPrivateKey;
    const hasProvider = !!getRougeChainProvider();
    if (!wallet?.signingPublicKey || (!hasKey && !hasProvider)) { toast.error("Connect your RougeChain wallet first"); return; }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { toast.error("Enter a valid amount"); return; }
    const evm = evmTarget.trim();
    if (!evm || (evm.startsWith("0x") ? evm.length !== 42 : evm.length !== 40)) { toast.error("Enter a valid EVM address"); return; }
    const evmAddr = evm.startsWith("0x") ? evm : `0x${evm}`;

    setProcessing(true);

    try {
      let success = false;
      if (asset === "XRGE") {
        if (amountNum > xrgeL1Balance) { toast.error("Insufficient XRGE balance"); setProcessing(false); return; }
        setStep("Submitting withdrawal...");
        const signed = await signBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountNum, evmAddr, "XRGE");
        const result = await bridgeWithdrawXrge({ fromPublicKey: wallet.signingPublicKey, amount: amountNum, evmAddress: evmAddr, signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) {
          toast.success(`Withdrawal submitted! The relayer will release XRGE on Base.`);
          setXrgeL1Balance((prev) => prev - amountNum);
          success = true;
        } else {
          toast.error(result.error || "Withdrawal failed");
        }
      } else {
        const isUsdc = asset === "USDC";
        const amountUnits = isUsdc ? Math.round(amountNum * 1e6) : humanToQeth(amountNum);
        const currentBalance = isUsdc ? qusdcBalance : qethBalance;
        const tokenLabel = isUsdc ? "qUSDC" : "qETH";
        if (amountUnits > currentBalance) { toast.error(`Insufficient ${tokenLabel} balance`); setProcessing(false); return; }

        setStep("Submitting withdrawal...");
        const signed = await signBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountUnits, evmAddr, tokenLabel);
        const result = await bridgeWithdraw({ fromPublicKey: wallet.signingPublicKey, amountUnits, evmAddress: evmAddr, tokenSymbol: tokenLabel, signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) {
          toast.success(`Withdrawal submitted! The relayer will send ${asset} to your Base address.`);
          if (isUsdc) setQusdcBalance((prev) => prev - amountUnits);
          else setQethBalance((prev) => prev - amountUnits);
          success = true;
        } else {
          toast.error(result.error || "Withdrawal failed");
        }
      }
      setAmount("");
      if (success) {
        setTimeout(() => { refreshBalances(); refreshEvmBalances(); }, 3000);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Withdrawal failed");
    } finally {
      setProcessing(false);
      setStep("");
    }
  };

  if (configLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <DeloreanLoader text="Warming up the flux capacitor..." />
      </div>
    );
  }

  if (!config?.enabled && !xrgeConfig?.enabled) {
    return (
      <div className="container max-w-lg py-12">
        <Card>
          <CardContent className="p-8 text-center">
            <ArrowRightLeft className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">Bridge is not enabled on this node.</p>
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
            <p className="font-semibold text-foreground">Network not confirmed</p>
            <p className="text-sm text-muted-foreground">
              This node didn't report a recognized Base chain, so the bridge can't
              tell whether you're on Base mainnet or a testnet. Bridging is disabled
              here to protect your funds. Check the node's bridge config
              (<code className="text-xs">chainId</code> in <code className="text-xs">/bridge/config</code>)
              and reload.
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
            <p className="font-semibold text-foreground">Network mismatch — bridge disabled</p>
            <p className="text-sm text-muted-foreground">
              You're on the RougeChain <span className="font-medium capitalize">{activeNetwork}</span> network,
              but this node's bridge reports <span className="font-medium">{chainLabel}</span> (chain {detectedChainId}).
              A {activeNetwork} network must not bridge {activeNetwork === "testnet" ? "real mainnet assets" : "testnet assets"},
              so bridging is disabled to protect your funds. This is a node misconfiguration —
              its bridge <code className="text-xs">chainId</code>/token must match the {activeNetwork} Base chain.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const fromChain = direction === "deposit" ? chainLabel : "RougeChain";
  const toChain = direction === "deposit" ? "RougeChain" : chainLabel;
  const fromToken = direction === "deposit" ? currentAsset.label : currentAsset.l1Label;
  const toToken = direction === "deposit" ? currentAsset.l1Label : currentAsset.label;

  return (
    <div className="container max-w-lg py-8 sm:py-12">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">

        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground">Bridge</h1>
          <p className="text-sm text-muted-foreground mt-1">Move assets between Base and RougeChain</p>
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
                Deposit
              </button>
              <button
                onClick={() => setDirection("withdraw")}
                className={`flex items-center justify-center gap-2 py-3.5 text-sm font-medium transition-colors ${direction === "withdraw" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <ArrowUpFromLine className="w-4 h-4" />
                Withdraw
              </button>
            </div>

            <div className="p-5 space-y-5">

              {/* Asset selector */}
              <div className="flex gap-2">
                {ASSETS.map(a => {
                  let balLabel: string;
                  if (direction === "deposit") {
                    const evmBal = a.id === "ETH" ? evmEthBalance
                      : a.id === "USDC" ? evmUsdcBalance
                      : evmXrgeBalance;
                    balLabel = evmAddress
                      ? evmBal.toLocaleString(undefined, { maximumFractionDigits: a.id === "USDC" ? 2 : 6 }) + " " + a.label
                      : "—";
                  } else {
                    const l1Bal = a.id === "ETH" ? qethBalance
                      : a.id === "USDC" ? qusdcBalance
                      : xrgeL1Balance;
                    balLabel = a.id === "ETH" ? formatQethForDisplay(l1Bal) + " qETH"
                      : a.id === "USDC" ? (l1Bal / 1e6).toFixed(2) + " qUSDC"
                      : l1Bal.toLocaleString() + " XRGE";
                  }
                  return (
                    <button
                      key={a.id}
                      onClick={() => setAsset(a.id)}
                      className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 rounded-lg text-sm font-medium transition-all ${asset === a.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span>{a.icon}</span>
                        {a.label}
                      </div>
                      <span className={`text-xs font-normal truncate max-w-full px-1 ${asset === a.id ? "text-primary-foreground/70" : "text-muted-foreground/60"}`}>
                        {balLabel}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* From */}
              <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <span className="text-xs text-muted-foreground">From · {fromChain}</span>
                  {direction === "withdraw" && (
                    <span className="text-xs text-muted-foreground">Balance: {getL1Balance()}</span>
                  )}
                  {direction === "deposit" && evmAddress && (
                    <span className="text-xs text-muted-foreground">
                      Balance: {asset === "ETH" ? evmEthBalance.toLocaleString(undefined, { maximumFractionDigits: 6 }) + " ETH"
                        : asset === "USDC" ? evmUsdcBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " USDC"
                        : evmXrgeBalance.toLocaleString(undefined, { maximumFractionDigits: 6 }) + " XRGE"}
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
                  <span className="text-xs text-muted-foreground">To · {toChain}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xl font-medium text-foreground/80">
                    {amount && !isNaN(parseFloat(amount)) ? parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "0.0"}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">{toToken}</span>
                </div>
              </div>

              {/* EVM address (for withdrawals) */}
              {direction === "withdraw" && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Receive at (Base address)</Label>
                  <Input
                    placeholder="0x..."
                    value={evmTarget}
                    onChange={(e) => setEvmTarget(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
              )}

              {/* DeLorean loader during processing */}
              {processing && (
                <DeloreanLoader text={step || "Processing..."} />
              )}

              {/* Wallet picker — shown when more than one injected wallet is present */}
              {direction === "deposit" && !evmAddress && discovered.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Choose a wallet</Label>
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
                  <span className="hidden sm:inline">Connect {selectedDetail?.info.name ?? "Base Wallet"} ({chainLabel})</span>
                  <span className="sm:hidden">Connect {selectedDetail?.info.name ?? "Base Wallet"}</span>
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
                      {step || "Processing..."}
                    </>
                  ) : direction === "deposit" ? (
                    <>
                      <ArrowDownToLine className="w-4 h-4" />
                      Bridge {currentAsset.label} to RougeChain
                    </>
                  ) : (
                    <>
                      <ArrowUpFromLine className="w-4 h-4" />
                      Bridge {currentAsset.l1Label} to Base
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
                    ? "Approve + deposit in two Base wallet transactions. 1:1 conversion."
                    : `Send ${asset} via your Base wallet → auto-claim ${currentAsset.l1Label} on RougeChain. 1:1 conversion.`
                  : "Submit withdrawal → relayer processes on Base (typically < 2 min)."
                }
              </p>
            </div>
          </CardContent>
        </Card>

        {/* In-flight withdrawal release status */}
        {rougechainPubkey && (
          <PendingWithdrawalsCard pubkey={rougechainPubkey} />
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
          <h3 className="text-sm font-semibold text-foreground">Recent Bridge Activity</h3>
        </div>
        {history.length === 0 ? (
          <div className="py-8 text-center">
            <ArrowRightLeft className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No bridge activity yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Bridge deposits and withdrawals will appear here</p>
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
                      {entry.direction === "deposit" ? "Bridged In" : "Bridged Out"}
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
                  <p className="text-xs text-muted-foreground capitalize">{entry.status}</p>
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

function PendingWithdrawalsCard({ pubkey }: { pubkey: string }) {
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
      case "failed": return { label: "Retrying", cls: "text-amber-500" };
      case "refunded": return { label: "Refunded", cls: "text-blue-500" };
      case "fulfilled": return { label: "Released", cls: "text-green-500" };
      default: return { label: "Pending", cls: "text-muted-foreground" };
    }
  };

  return (
    <Card className="border-border">
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Withdrawal Release Status</h3>
        </div>
        {loading ? (
          <div className="py-6 text-center">
            <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {withdrawals.map((w) => {
              const s = statusStyle(w.status);
              return (
                <div key={w.txId} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {w.amount} {w.tokenSymbol} → {w.evmAddress.slice(0, 8)}…{w.evmAddress.slice(-4)}
                    </p>
                    {w.status === "failed" && (
                      <p className="text-xs text-amber-500/80 truncate">
                        {w.attempts} failed attempt{w.attempts === 1 ? "" : "s"}
                        {w.lastError ? ` — ${w.lastError}` : ""}
                      </p>
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
