import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Shield, Info, Zap, TrendingUp, Lock, Wallet, RefreshCw, Server, Copy, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ValidatorDashboard } from "@/components/validators/ValidatorDashboard";
import { STAKE_REQUIREMENTS, TIER_BENEFITS, formatStake, ValidatorTier } from "@/lib/pqc-validators";
import { loadUnifiedWallet, UnifiedWallet } from "@/lib/unified-wallet";
import { getWalletBalance } from "@/lib/pqc-wallet";
import { Link } from "react-router-dom";

function RunNodeCta() {
  const [copied, setCopied] = useState(false);
  const dockerCmd = "git clone https://github.com/cyberdreadx/rougechain-node && cd rougechain-node && docker compose up -d";

  const copyCommand = () => {
    navigator.clipboard.writeText(dockerCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="bg-gradient-to-br from-primary/10 to-cyan-500/5 border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          Run a Node
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Strengthen the network by running your own node. Stake XRGE to earn block
          rewards and transaction fees.
        </p>
        <div className="relative">
          <pre className="bg-background/80 border border-border rounded-lg p-3 pr-10 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
            {dockerCmd}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-1.5 right-1.5 h-7 w-7 p-0"
            onClick={copyCommand}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline" className="flex-1 text-xs">
            <a href="https://docs.rougechain.io/running-a-node/installation.html" target="_blank" rel="noopener noreferrer">
              Full Guide
            </a>
          </Button>
          <Button asChild size="sm" className="flex-1 text-xs">
            <a href="https://github.com/cyberdreadx/rougechain-node" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Validators() {
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [availableBalance, setAvailableBalance] = useState(0);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);

  // Load wallet and balance
  useEffect(() => {
    const loadWalletData = async () => {
      setIsLoadingBalance(true);
      const unifiedWallet = loadUnifiedWallet();
      setWallet(unifiedWallet);

      if (unifiedWallet) {
        try {
          const balances = await getWalletBalance(unifiedWallet.signingPublicKey);
          const xrgeBalance = balances.find(b => b.symbol === "XRGE");
          setAvailableBalance(xrgeBalance?.balance || 0);
        } catch (error) {
          console.error("Failed to load balance:", error);
          setAvailableBalance(0);
        }
      }
      setIsLoadingBalance(false);
    };

    loadWalletData();
  }, []);

  const refreshBalance = async () => {
    if (!wallet) return;
    setIsLoadingBalance(true);
    try {
      const balances = await getWalletBalance(wallet.signingPublicKey);
      const xrgeBalance = balances.find(b => b.symbol === "XRGE");
      setAvailableBalance(xrgeBalance?.balance || 0);
    } catch (error) {
      console.error("Failed to refresh balance:", error);
    }
    setIsLoadingBalance(false);
  };

  const walletId = wallet?.id;
  const signingPublicKey = wallet?.signingPublicKey;
  const signingPrivateKey = wallet?.signingPrivateKey;

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background text-foreground relative overflow-x-hidden">
      
      {/* Background Effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
      </div>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 md:py-8 relative z-10">
        {/* Mobile: Wallet balance first */}
        <div className="lg:hidden mb-6">
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/30">
            <CardContent className="p-4">
              {wallet ? (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Available to Stake</div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold">
                        {isLoadingBalance ? "..." : formatStake(availableBalance)}
                      </span>
                      <span className="text-muted-foreground text-sm">XRGE</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={refreshBalance}
                    disabled={isLoadingBalance}
                  >
                    <RefreshCw className={`w-4 h-4 ${isLoadingBalance ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">No wallet connected</span>
                  <Button asChild size="sm">
                    <Link to="/wallet">Open Wallet</Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid lg:grid-cols-3 gap-6 md:gap-8">
          {/* Main Dashboard */}
          <div className="lg:col-span-2 order-2 lg:order-1 min-w-0 overflow-hidden space-y-6">
            <ValidatorDashboard
              walletId={walletId}
              signingPublicKey={signingPublicKey}
              signingPrivateKey={signingPrivateKey}
              availableBalance={availableBalance}
            />
            <div className="lg:hidden">
              <RunNodeCta />
            </div>
          </div>

          {/* Sidebar - hidden on mobile, cards shown inline above */}
          <div className="space-y-6 order-1 lg:order-2 hidden lg:block">
            {/* Simple Explanation */}
            <Card className="bg-card/50 backdrop-blur border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="w-4 h-4 text-primary" />
                  What Is a Validator?
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-2">
                <p>
                  Validators are the people running the network. They help confirm transactions and
                  create new blocks.
                </p>
                <p>
                  To become one, you lock up (stake) XRGE. In return, you earn rewards. If you misbehave,
                  you can lose some of your stake.
                </p>
              </CardContent>
            </Card>

            {/* Wallet Balance Card */}
            <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-primary" />
                    Your Balance
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={refreshBalance}
                    disabled={isLoadingBalance || !wallet}
                    className="h-6 w-6 p-0"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingBalance ? "animate-spin" : ""}`} />
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {wallet ? (
                  <div className="space-y-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold">
                        {isLoadingBalance ? "..." : formatStake(availableBalance)}
                      </span>
                      <span className="text-muted-foreground">XRGE</span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {wallet.displayName}
                    </div>
                    {availableBalance < STAKE_REQUIREMENTS.standard && (
                      <div className="p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
                        Need {formatStake(STAKE_REQUIREMENTS.standard - availableBalance)} more XRGE to stake
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Connect your wallet to view balance and stake
                    </p>
                    <Button asChild size="sm" className="w-full">
                      <Link to="/wallet">Open Wallet</Link>
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* How It Works */}
            <Card className="bg-card/50 backdrop-blur border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="w-4 h-4 text-primary" />
                  How Validation Works
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-primary">1</span>
                  </div>
                  <div>
                    <div className="font-medium">Stake XRGE</div>
                    <p className="text-muted-foreground text-xs">
                      Lock your tokens to become a validator and secure the network.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-primary">2</span>
                  </div>
                  <div>
                    <div className="font-medium">Quantum Selection</div>
                    <p className="text-muted-foreground text-xs">
                      Proposers are chosen using quantum entropy weighted by stake.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-primary">3</span>
                  </div>
                  <div>
                    <div className="font-medium">PQC Signatures</div>
                    <p className="text-muted-foreground text-xs">
                      All blocks are signed with ML-DSA-65 quantum-resistant signatures.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-primary">4</span>
                  </div>
                  <div>
                    <div className="font-medium">Earn Rewards</div>
                    <p className="text-muted-foreground text-xs">
                      Validators earn block rewards and a share of transaction fees.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Staking Tiers */}
            <Card className="bg-card/50 backdrop-blur border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield className="w-4 h-4 text-blue-400" />
                  Staking Tiers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {(Object.keys(STAKE_REQUIREMENTS) as ValidatorTier[]).map((tier) => (
                  <div key={tier} className="p-3 rounded-lg bg-muted/30 border border-border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold capitalize">{tier}</span>
                      <span className="text-sm text-muted-foreground">
                        {formatStake(STAKE_REQUIREMENTS[tier])} XRGE
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {TIER_BENEFITS[tier].slice(0, 2).map((benefit, i) => (
                        <li key={i} className="text-xs text-muted-foreground flex items-center gap-1">
                          <Zap className="w-3 h-3 text-primary" />
                          {benefit}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Security Info */}
            <Card className="bg-gradient-to-br from-green-500/10 to-emerald-500/5 border-green-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Lock className="w-4 h-4 text-green-500" />
                  Quantum-Secure PoS
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-2">
                <p>
                  RougeChain uses <strong className="text-foreground">ML-DSA-65</strong> (CRYSTALS-Dilithium) 
                  for all validator signatures, providing NIST Level 3 security against quantum attacks.
                </p>
                <p>
                  Proposer selection uses <strong className="text-foreground">quantum entropy</strong> combined 
                  with stake-weighted probability for unpredictable, fair block production.
                </p>
              </CardContent>
            </Card>

            {/* Quick Stats */}
            <Card className="bg-card/50 backdrop-blur border-border">
              <CardContent className="p-4 grid grid-cols-2 gap-4">
                <div className="text-center">
                  <TrendingUp className="w-5 h-5 mx-auto mb-1 text-primary" />
                  <div className="text-lg font-bold">~12%</div>
                  <div className="text-xs text-muted-foreground">Est. APY</div>
                </div>
                <div className="text-center">
                  <Zap className="w-5 h-5 mx-auto mb-1 text-amber-400" />
                  <div className="text-lg font-bold">10 XRGE</div>
                  <div className="text-xs text-muted-foreground">Block Reward</div>
                </div>
              </CardContent>
            </Card>

            {/* Run a Node CTA */}
            <RunNodeCta />
          </div>
        </div>
      </main>
    </div>
  );
}
