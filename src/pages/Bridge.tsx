import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowRightLeft, ExternalLink, Loader2, Wallet, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { baseSepolia } from "viem/chains";
import {
  getBridgeConfig,
  claimBridgeDeposit,
  bridgeWithdraw,
  type BridgeConfig,
} from "@/lib/bridge";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import { getWalletBalance } from "@/lib/pqc-wallet";
import { qethToHuman, humanToQeth, formatQethForDisplay } from "@/hooks/use-eth-price";

const Bridge = () => {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [evmAddress, setEvmAddress] = useState("");
  const [evmTxHash, setEvmTxHash] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rougechainPubkey, setRougechainPubkey] = useState("");
  // Bridge out state
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawEvmAddress, setWithdrawEvmAddress] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [qethBalance, setQethBalance] = useState(0);

  useEffect(() => {
    getBridgeConfig()
      .then(setConfig)
      .catch(() => setConfig({ enabled: false, chainId: 84532 }))
      .finally(() => setConfigLoading(false));
  }, []);

  useEffect(() => {
    const wallet = loadUnifiedWallet();
    if (wallet?.signingPublicKey) {
      setRougechainPubkey(wallet.signingPublicKey);
    }
  }, []);

  useEffect(() => {
    const wallet = loadUnifiedWallet();
    if (!wallet?.signingPublicKey) return;
    getWalletBalance(wallet.signingPublicKey).then((balances) => {
      const qeth = balances.find((b) => b.symbol === "qETH")?.balance ?? 0;
      setQethBalance(qeth);
    });
  }, [config, claiming, withdrawing]);

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
          params: [{
            chainId: chainIdHex,
            chainName: baseSepolia.name,
            nativeCurrency: baseSepolia.nativeCurrency,
            rpcUrls: [baseSepolia.rpcUrls.default.http[0]],
            blockExplorerUrls: [baseSepolia.blockExplorers.default.url],
          }],
        });
      });
      const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setEvmAddress(addr);
      toast.success("Connected to Base Sepolia");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    }
  };

  const copyCustody = () => {
    if (!config?.custodyAddress) return;
    navigator.clipboard.writeText(config.custodyAddress);
    setCopied(true);
    toast.success("Copied custody address");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleWithdraw = async () => {
    const wallet = loadUnifiedWallet();
    if (!wallet?.signingPrivateKey || !wallet?.signingPublicKey) {
      toast.error("Connect your RougeChain wallet first");
      return;
    }
    const amountNum = parseFloat(withdrawAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const amountUnits = humanToQeth(amountNum);
    if (amountUnits > qethBalance) {
      toast.error("Insufficient qETH balance");
      return;
    }
    const evm = withdrawEvmAddress.trim();
    if (!evm || (evm.startsWith("0x") ? evm.length !== 42 : evm.length !== 40)) {
      toast.error("Enter a valid EVM address (0x + 40 hex chars)");
      return;
    }
    setWithdrawing(true);
    try {
      const result = await bridgeWithdraw({
        fromPrivateKey: wallet.signingPrivateKey,
        fromPublicKey: wallet.signingPublicKey,
        amountUnits,
        evmAddress: evm.startsWith("0x") ? evm : `0x${evm}`,
      });
      if (result.success) {
        toast.success(`Bridge out submitted! Tx: ${result.txId}`);
        setWithdrawAmount("");
      } else {
        toast.error(result.error || "Bridge out failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bridge out failed");
    } finally {
      setWithdrawing(false);
    }
  };

  const handleClaim = async () => {
    if (!evmTxHash.trim() || !evmAddress.trim() || !rougechainPubkey.trim()) {
      toast.error("Fill in all fields");
      return;
    }
    if (typeof window.ethereum === "undefined") {
      toast.error("Connect MetaMask to sign the claim");
      return;
    }
    setClaiming(true);
    try {
      const txHashHex = evmTxHash.trim().startsWith("0x") ? evmTxHash.trim() : `0x${evmTxHash.trim()}`;
      const recipient = rougechainPubkey.trim().toLowerCase().replace(/^xrge:/, "");
      const claimMessage = `RougeChain bridge claim\nTx: ${txHashHex}\nRecipient: ${recipient}`;
      const msgHex = "0x" + Array.from(new TextEncoder().encode(claimMessage))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [msgHex, evmAddress.trim()],
      });
      const result = await claimBridgeDeposit({
        evmTxHash: txHashHex,
        evmAddress: evmAddress.trim(),
        evmSignature: signature as string,
        recipientRougechainPubkey: recipient,
      });
      if (result.success) {
        toast.success(`Claim submitted! Tx: ${result.txId}`);
        setEvmTxHash("");
      } else {
        toast.error(result.error || "Claim failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setClaiming(false);
    }
  };

  if (configLoading || !config) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!config.enabled) {
    return (
      <div className="container max-w-2xl py-12">
        <Card className="border-red-500/30 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5" />
              Bridge (Base Sepolia → RougeChain)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Bridge is not enabled. The node operator must set <code className="rounded bg-muted px-1">QV_BRIDGE_CUSTODY_ADDRESS</code> to enable deposits from Base Sepolia testnet ETH.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Contact your node operator or run your own node with the bridge configured.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-8"
      >
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <ArrowRightLeft className="w-8 h-8" />
            Bridge
          </h1>
          <p className="text-muted-foreground mt-1">
            Bridge Base Sepolia ETH ↔ RougeChain qETH
          </p>
        </div>

        <Card className="border-primary/20">
          <CardHeader>
            <CardTitle className="text-lg">Step 1: Send ETH</CardTitle>
            <p className="text-sm text-muted-foreground">
              Send testnet ETH from your wallet to the bridge custody address on Base Sepolia.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={config.custodyAddress || ""}
                className="font-mono text-sm"
              />
              <Button size="icon" variant="outline" onClick={copyCustody}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <a
              href={`https://sepolia.basescan.org/address/${config.custodyAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              View on Basescan <ExternalLink className="w-3 h-3" />
            </a>
          </CardContent>
        </Card>

        <Card className="border-primary/20">
          <CardHeader>
            <CardTitle className="text-lg">Step 2: Claim qETH</CardTitle>
            <p className="text-sm text-muted-foreground">
              After your transaction is confirmed, enter the details below to claim qETH on RougeChain.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {!evmAddress ? (
              <Button onClick={connectEvm} className="gap-2">
                <Wallet className="w-4 h-4" />
                Connect Base Sepolia Wallet
              </Button>
            ) : (
              <div className="text-sm">
                <span className="text-muted-foreground">Connected: </span>
                <span className="font-mono">{evmAddress.slice(0, 6)}...{evmAddress.slice(-4)}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label>Transaction Hash</Label>
              <Input
                placeholder="0x..."
                value={evmTxHash}
                onChange={(e) => setEvmTxHash(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>Your EVM Address (sender)</Label>
              <Input
                placeholder="0x... or connect wallet above"
                value={evmAddress}
                onChange={(e) => setEvmAddress(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>RougeChain Recipient (public key)</Label>
              <Input
                placeholder="Your RougeChain public key"
                value={rougechainPubkey}
                onChange={(e) => setRougechainPubkey(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Auto-filled from your wallet if connected.</p>
            </div>
            <Button
              onClick={handleClaim}
              disabled={claiming || !evmTxHash || !rougechainPubkey}
              className="w-full gap-2"
            >
              {claiming ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Claiming...
                </>
              ) : (
                <>
                  Claim qETH
                  <ArrowRightLeft className="w-4 h-4" />
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-primary/20">
          <CardHeader>
            <CardTitle className="text-lg">Bridge Out: qETH → ETH</CardTitle>
            <p className="text-sm text-muted-foreground">
              Burn qETH on RougeChain and receive ETH on Base Sepolia. The operator fulfills withdrawals.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Balance: {formatQethForDisplay(qethBalance)} qETH
            </div>
            <div className="space-y-2">
              <Label>Amount (qETH)</Label>
              <Input
                type="number"
                step="0.000001"
                min="0.000001"
                placeholder="0.0005"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Receive ETH at (Base Sepolia address)</Label>
              <Input
                placeholder="0x..."
                value={withdrawEvmAddress}
                onChange={(e) => setWithdrawEvmAddress(e.target.value)}
                className="font-mono"
              />
            </div>
            <Button
              onClick={handleWithdraw}
              disabled={withdrawing || !withdrawAmount || !withdrawEvmAddress || !loadUnifiedWallet()?.signingPrivateKey || qethBalance < humanToQeth(parseFloat(withdrawAmount) || 0)}
              className="w-full gap-2"
            >
              {withdrawing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  Bridge Out qETH
                  <ArrowRightLeft className="w-4 h-4" />
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              Requires RougeChain wallet. 0.1 XRGE fee. Operator processes withdrawals (may take time on testnet).
            </p>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Min 0.000001 ETH. 1 ETH (18 decimals) ≈ 1,000,000 qETH units (6 decimals) on RougeChain. Get Base Sepolia ETH from{" "}
          <a href="https://www.coinbase.com/faucets/base-ethereum-goerli-faucet" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            faucets
          </a>.
        </p>
      </motion.div>
    </div>
  );
};

export default Bridge;
