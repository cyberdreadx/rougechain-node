import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { 
  Shield, ArrowLeft, Info, Zap, TrendingUp, Lock
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ValidatorDashboard } from "@/components/validators/ValidatorDashboard";
import { STAKE_REQUIREMENTS, TIER_BENEFITS, formatStake, ValidatorTier } from "@/lib/pqc-validators";
import xrgeLogo from "@/assets/xrge-logo.webp";

export default function Validators() {
  // In a real app, these would come from wallet context
  const [walletId] = useState<string | undefined>(undefined);
  const [signingPublicKey] = useState<string | undefined>(undefined);
  const [availableBalance] = useState(50000); // Demo balance

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      {/* Background Effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="w-5 h-5" />
                </Button>
              </Link>
              <div className="flex items-center gap-3">
                <img src={xrgeLogo} alt="XRGE" className="w-10 h-10" />
                <div>
                  <h1 className="text-xl font-bold">RougeChain Validators</h1>
                  <p className="text-xs text-muted-foreground">Proof of Stake • Quantum-Secured</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/wallet">
                <Button variant="outline" size="sm">
                  Open Wallet
                </Button>
              </Link>
              <Link to="/blockchain">
                <Button variant="outline" size="sm">
                  View Blockchain
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8 relative z-10">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main Dashboard */}
          <div className="lg:col-span-2">
            <ValidatorDashboard
              walletId={walletId}
              signingPublicKey={signingPublicKey}
              availableBalance={availableBalance}
            />
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
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
          </div>
        </div>
      </main>
    </div>
  );
}
