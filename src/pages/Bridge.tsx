import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Wallet, ArrowRightLeft, Coins, ArrowDown } from "lucide-react";
import { DeloreanLoader } from "@/components/ui/delorean-loader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { baseSepolia } from "viem/chains";
import {
  getBridgeConfig,
  claimBridgeDeposit,
  bridgeWithdraw,
  type BridgeConfig,
  getXrgeBridgeConfig,
  claimXrgeBridgeDeposit,
  bridgeWithdrawXrge,
  type XrgeBridgeConfig,
  USDC_BASE_SEPOLIA,
} from "@/lib/bridge";
import { createSignedBridgeWithdraw } from "@/lib/pqc-signer";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import { getWalletBalance } from "@/lib/pqc-wallet";
import { qethToHuman, humanToQeth, formatQethForDisplay } from "@/hooks/use-eth-price";

type BridgeDirection = "deposit" | "withdraw";
type BridgeAsset = "ETH" | "USDC" | "XRGE";

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
    const wallet = loadUnifiedWallet();
    if (wallet?.signingPublicKey) setRougechainPubkey(wallet.signingPublicKey);
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
    if (!evmAddress || typeof window.ethereum === "undefined") return;
    try {
      const ethHex = await window.ethereum.request({ method: "eth_getBalance", params: [evmAddress, "latest"] }) as string;
      setEvmEthBalance(Number(BigInt(ethHex)) / 1e18);

      const balanceOfSig = "0x70a08231" + evmAddress.slice(2).padStart(64, "0");

      const usdcHex = await window.ethereum.request({ method: "eth_call", params: [{ to: USDC_BASE_SEPOLIA, data: balanceOfSig }, "latest"] }) as string;
      setEvmUsdcBalance(Number(BigInt(usdcHex)) / 1e6);

      const xrgeAddr = xrgeConfig?.tokenAddress;
      if (xrgeAddr) {
        const xrgeHex = await window.ethereum.request({ method: "eth_call", params: [{ to: xrgeAddr, data: balanceOfSig }, "latest"] }) as string;
        setEvmXrgeBalance(Number(BigInt(xrgeHex)) / 1e18);
      }
    } catch (e) {
      console.log("Failed to fetch EVM balances", e);
    }
  };

  useEffect(() => { refreshEvmBalances(); }, [evmAddress, xrgeConfig]);

  const connectEvm = async () => {
    if (typeof window.ethereum === "undefined") {
      toast.error("Install MetaMask or another Web3 wallet");
      return;
    }
    try {
      const chainIdHex = `0x${baseSepolia.id.toString(16)}`;
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }).catch(async () => {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: chainIdHex, chainName: baseSepolia.name, nativeCurrency: baseSepolia.nativeCurrency, rpcUrls: [baseSepolia.rpcUrls.default.http[0]], blockExplorerUrls: [baseSepolia.blockExplorers.default.url] }],
        });
      });
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      setEvmAddress(accounts[0]);
      setEvmTarget(accounts[0]);
      toast.success("Connected to Base Sepolia");
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
    if (!evmAddress) { toast.error("Connect your Base wallet first"); return; }
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
        const approveTxHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: tokenAddr, data: approveData }] }) as string;

        setStep("Waiting for approval confirmation...");
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [approveTxHash] });
          if (receipt) break;
        }

        setStep("Depositing to vault...");
        const pubkeyHex = Array.from(new TextEncoder().encode(rougechainPubkey)).map(b => b.toString(16).padStart(2, "0")).join("");
        const paddedPubkey = pubkeyHex.padEnd(Math.ceil(pubkeyHex.length / 64) * 64, "0");
        const depositData = "0xf1215d25" + BigInt(amountWei).toString(16).padStart(64, "0") + (64).toString(16).padStart(64, "0") + rougechainPubkey.length.toString(16).padStart(64, "0") + paddedPubkey;
        const depositTx = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: vaultAddr, data: depositData, gas: "0x7A120" }] }) as string;

        setStep("Waiting for deposit confirmation...");
        let depositConfirmed = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [depositTx] }) as { status?: string } | null;
          if (receipt) {
            depositConfirmed = receipt.status === "0x1";
            break;
          }
        }
        if (!depositConfirmed) { toast.error("Deposit transaction failed or timed out on Base"); setProcessing(false); return; }

        setStep("Claiming on RougeChain...");
        const claim = await claimXrgeBridgeDeposit({ evmTxHash: depositTx, evmAddress, amount: (BigInt(Math.floor(amountNum)) * 10n ** 18n).toString(), recipientRougechainPubkey: rougechainPubkey });
        if (claim.success) toast.success(`Bridged ${amountNum} XRGE to RougeChain!`);
        else toast.warning(`Deposit sent but L1 claim pending. ${claim.error || ""}`);
      } else {
        if (!config?.custodyAddress) { toast.error("Bridge not configured"); setProcessing(false); return; }

        if (asset === "ETH") {
          setStep("Sending ETH to bridge...");
          const weiHex = "0x" + (BigInt(Math.round(amountNum * 1e18))).toString(16);
          const txHash = await window.ethereum.request({
            method: "eth_sendTransaction",
            params: [{ from: evmAddress, to: config.custodyAddress, value: weiHex }],
          });
          await new Promise(r => setTimeout(r, 5000));

          setStep("Signing claim...");
          const recipient = rougechainPubkey;
          const claimMsg = `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`;
          const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map(b => b.toString(16).padStart(2, "0")).join("");
          const sig = await window.ethereum.request({ method: "personal_sign", params: [msgHex, evmAddress] });

          setStep("Claiming qETH...");
          const claim = await claimBridgeDeposit({ evmTxHash: txHash as string, evmAddress, evmSignature: sig as string, recipientRougechainPubkey: recipient, token: "ETH" });
          if (claim.success) toast.success(`Claimed ${amountNum} ETH as qETH!`);
          else toast.error(claim.error || "Claim failed");
        } else {
          setStep("Sending USDC to bridge...");
          const usdcAddr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
          const usdcAmount = "0x" + (BigInt(Math.round(amountNum * 1e6))).toString(16);
          const transferData = `0xa9059cbb${config.custodyAddress.slice(2).padStart(64, "0")}${BigInt(usdcAmount).toString(16).padStart(64, "0")}`;
          const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: evmAddress, to: usdcAddr, data: transferData }] });
          await new Promise(r => setTimeout(r, 5000));

          setStep("Signing claim...");
          const recipient = rougechainPubkey;
          const claimMsg = `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipient}`;
          const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMsg)).map(b => b.toString(16).padStart(2, "0")).join("");
          const sig = await window.ethereum.request({ method: "personal_sign", params: [msgHex, evmAddress] });

          setStep("Claiming qUSDC...");
          const claim = await claimBridgeDeposit({ evmTxHash: txHash as string, evmAddress, evmSignature: sig as string, recipientRougechainPubkey: recipient, token: "USDC" });
          if (claim.success) toast.success(`Claimed ${amountNum} USDC as qUSDC!`);
          else toast.error(claim.error || "Claim failed");
        }
      }
      setAmount("");
      refreshBalances();
      refreshEvmBalances();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bridge deposit failed");
    } finally {
      setProcessing(false);
      setStep("");
    }
  };

  // ── Withdraw: RougeChain → Base ───────────────────────────────

  const handleWithdraw = async () => {
    const wallet = loadUnifiedWallet();
    if (!wallet?.signingPrivateKey || !wallet?.signingPublicKey) { toast.error("Connect your RougeChain wallet first"); return; }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) { toast.error("Enter a valid amount"); return; }
    const evm = evmTarget.trim();
    if (!evm || (evm.startsWith("0x") ? evm.length !== 42 : evm.length !== 40)) { toast.error("Enter a valid EVM address"); return; }
    const evmAddr = evm.startsWith("0x") ? evm : `0x${evm}`;

    setProcessing(true);

    try {
      if (asset === "XRGE") {
        if (amountNum > xrgeL1Balance) { toast.error("Insufficient XRGE balance"); setProcessing(false); return; }
        setStep("Submitting withdrawal...");
        const signed = createSignedBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountNum, evmAddr, "XRGE");
        const result = await bridgeWithdrawXrge({ fromPublicKey: wallet.signingPublicKey, amount: amountNum, evmAddress: evmAddr, signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) toast.success(`Withdrawal submitted! The relayer will release XRGE on Base.`);
        else toast.error(result.error || "Withdrawal failed");
      } else {
        const isUsdc = asset === "USDC";
        const amountUnits = isUsdc ? Math.round(amountNum * 1e6) : humanToQeth(amountNum);
        const currentBalance = isUsdc ? qusdcBalance : qethBalance;
        const tokenLabel = isUsdc ? "qUSDC" : "qETH";
        if (amountUnits > currentBalance) { toast.error(`Insufficient ${tokenLabel} balance`); setProcessing(false); return; }

        setStep("Submitting withdrawal...");
        const signed = createSignedBridgeWithdraw(wallet.signingPublicKey, wallet.signingPrivateKey, amountUnits, evmAddr, tokenLabel);
        const result = await bridgeWithdraw({ fromPublicKey: wallet.signingPublicKey, amountUnits, evmAddress: evmAddr, tokenSymbol: tokenLabel, signature: signed.signature, payload: signed.payload as unknown as Record<string, unknown> });
        if (result.success) toast.success(`Withdrawal submitted! The relayer will send ${asset} to your Base address.`);
        else toast.error(result.error || "Withdrawal failed");
      }
      setAmount("");
      refreshBalances();
      refreshEvmBalances();
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

  const fromChain = direction === "deposit" ? "Base Sepolia" : "RougeChain";
  const toChain = direction === "deposit" ? "RougeChain" : "Base Sepolia";
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
                      <span className={`text-[10px] font-normal ${asset === a.id ? "text-primary-foreground/70" : "text-muted-foreground/60"}`}>
                        {balLabel}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* From */}
              <div className="rounded-xl bg-muted/30 border border-border/50 p-4 space-y-2">
                <div className="flex items-center justify-between">
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

              {/* Connect wallet / Action button */}
              {direction === "deposit" && !evmAddress ? (
                <Button onClick={connectEvm} variant="outline" className="w-full gap-2 h-12">
                  <Wallet className="w-4 h-4" />
                  Connect MetaMask (Base Sepolia)
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
                    ? "Approve + deposit in two MetaMask transactions. 1:1 conversion."
                    : `Send ${asset} via MetaMask → auto-claim ${currentAsset.l1Label} on RougeChain. 1:1 conversion.`
                  : "Submit withdrawal → relayer processes on Base (typically < 2 min)."
                }
              </p>
            </div>
          </CardContent>
        </Card>

      </motion.div>
    </div>
  );
};

export default Bridge;
