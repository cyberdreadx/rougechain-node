import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Shield, ShieldCheck, Crown, Zap, TrendingUp, Clock, 
  Activity, Atom, ChevronDown, Plus, RefreshCw 
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ValidatorList } from "./ValidatorList";
import { StakingDialog } from "./StakingDialog";
import { 
  Validator, 
  ValidatorTier, 
  getValidators, 
  selectProposer, 
  formatStake,
  STAKE_REQUIREMENTS,
} from "@/lib/pqc-validators";

interface ValidatorDashboardProps {
  walletId?: string;
  signingPublicKey?: string;
  availableBalance?: number;
}

const tierConfig: Record<ValidatorTier, { icon: typeof Shield; color: string }> = {
  standard: { icon: Shield, color: "text-blue-400" },
  operator: { icon: ShieldCheck, color: "text-purple-400" },
  genesis: { icon: Crown, color: "text-amber-400" },
};

export function ValidatorDashboard({ 
  walletId, 
  signingPublicKey,
  availableBalance = 0,
}: ValidatorDashboardProps) {
  const [validators, setValidators] = useState<Validator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStaking, setShowStaking] = useState(false);
  const [selectedProposer, setSelectedProposer] = useState<{
    proposer: Validator;
    entropy: string;
    selectionWeight: string;
  } | null>(null);
  const [selectingProposer, setSelectingProposer] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await getValidators();
      setValidators(data);
    } catch (error) {
      console.error("Failed to load validators:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectProposer = async () => {
    setSelectingProposer(true);
    try {
      const result = await selectProposer();
      setSelectedProposer({
        proposer: result.proposer as Validator,
        entropy: result.entropy,
        selectionWeight: result.selectionWeight,
      });
    } catch (error) {
      console.error("Failed to select proposer:", error);
    } finally {
      setSelectingProposer(false);
    }
  };

  // Calculate stats
  const totalStake = validators.reduce((sum, v) => sum + v.stakedAmount, 0);
  const activeValidators = validators.filter(v => v.status === "active").length;
  const tierCounts = validators.reduce((acc, v) => {
    acc[v.tier] = (acc[v.tier] || 0) + 1;
    return acc;
  }, {} as Record<ValidatorTier, number>);

  // Check if current wallet is a validator
  const myValidator = walletId 
    ? validators.find(v => v.walletId === walletId) 
    : null;

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Shield className="w-4 h-4" />
              <span className="text-xs">Total Validators</span>
            </div>
            <div className="text-2xl font-bold">{validators.length}</div>
            <div className="text-xs text-green-500">{activeValidators} active</div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="w-4 h-4" />
              <span className="text-xs">Total Staked</span>
            </div>
            <div className="text-2xl font-bold">{formatStake(totalStake)}</div>
            <div className="text-xs text-muted-foreground">XRGE</div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Atom className="w-4 h-4" />
              <span className="text-xs">Quantum Entropy</span>
            </div>
            <div className="text-2xl font-bold">
              {validators.reduce((sum, v) => sum + v.quantumEntropyContributions, 0)}
            </div>
            <div className="text-xs text-muted-foreground">contributions</div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Activity className="w-4 h-4" />
              <span className="text-xs">Network Uptime</span>
            </div>
            <div className="text-2xl font-bold">
              {validators.length > 0 
                ? (validators.reduce((sum, v) => sum + v.uptimePercentage, 0) / validators.length).toFixed(1)
                : "100"
              }%
            </div>
            <Progress 
              value={validators.length > 0 
                ? validators.reduce((sum, v) => sum + v.uptimePercentage, 0) / validators.length
                : 100
              } 
              className="h-1 mt-2" 
            />
          </CardContent>
        </Card>
      </div>

      {/* Tier Distribution */}
      <Card className="bg-card/50 backdrop-blur border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Crown className="w-4 h-4 text-amber-400" />
            Validator Tier Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            {(Object.keys(STAKE_REQUIREMENTS) as ValidatorTier[]).map((tier) => {
              const TierIcon = tierConfig[tier].icon;
              const count = tierCounts[tier] || 0;
              const percentage = validators.length > 0 ? (count / validators.length) * 100 : 0;

              return (
                <div key={tier} className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <TierIcon className={`w-4 h-4 ${tierConfig[tier].color}`} />
                      <span className="text-sm capitalize">{tier}</span>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {count}
                    </Badge>
                  </div>
                  <Progress value={percentage} className="h-2" />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Proposer Selection Demo */}
      <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Quantum-Weighted Proposer Selection
            </CardTitle>
            <Button 
              size="sm" 
              variant="outline"
              onClick={handleSelectProposer}
              disabled={selectingProposer || validators.length === 0}
            >
              {selectingProposer ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-1" />
                  Select Proposer
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <AnimatePresence mode="wait">
            {selectedProposer ? (
              <motion.div
                key="proposer"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="p-4 bg-background/50 rounded-lg border border-border"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const TierIcon = tierConfig[selectedProposer.proposer.tier].icon;
                      return <TierIcon className={`w-5 h-5 ${tierConfig[selectedProposer.proposer.tier].color}`} />;
                    })()}
                    <span className="font-mono text-sm">
                      {selectedProposer.proposer.signingPublicKey.slice(0, 16)}...
                    </span>
                    <Badge variant="outline" className="capitalize text-xs">
                      {selectedProposer.proposer.tier}
                    </Badge>
                  </div>
                  <Badge className="bg-green-500/20 text-green-500 border-green-500/30">
                    Selected Proposer
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Selection Weight</span>
                    <div className="font-semibold">{selectedProposer.selectionWeight}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Stake</span>
                    <div className="font-semibold">{formatStake(selectedProposer.proposer.stakedAmount)} XRGE</div>
                  </div>
                </div>
                <div className="mt-3 p-2 bg-muted/30 rounded text-xs font-mono break-all">
                  <span className="text-muted-foreground">Quantum Entropy: </span>
                  {selectedProposer.entropy.slice(0, 32)}...
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center py-6 text-muted-foreground"
              >
                <Atom className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Click "Select Proposer" to use quantum entropy for random selection</p>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>

      {/* My Validator Status / Become Validator */}
      {walletId && (
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="p-4">
            {myValidator ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {(() => {
                    const TierIcon = tierConfig[myValidator.tier].icon;
                    return (
                      <div className={`p-2 rounded-lg bg-background ${tierConfig[myValidator.tier].color}`}>
                        <TierIcon className="w-5 h-5" />
                      </div>
                    );
                  })()}
                  <div>
                    <div className="font-semibold">You're a {myValidator.tier} Validator</div>
                    <div className="text-sm text-muted-foreground">
                      Staked: {formatStake(myValidator.stakedAmount)} XRGE • {myValidator.blocksValidated} validations
                    </div>
                  </div>
                </div>
                <Badge className={`capitalize ${
                  myValidator.status === "active" ? "bg-green-500/20 text-green-500" :
                  myValidator.status === "jailed" ? "bg-red-500/20 text-red-500" :
                  "bg-yellow-500/20 text-yellow-500"
                }`}>
                  {myValidator.status}
                </Badge>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">Become a Validator</div>
                  <div className="text-sm text-muted-foreground">
                    Stake XRGE to help secure the network and earn rewards
                  </div>
                </div>
                <Button onClick={() => setShowStaking(true)} className="gap-2">
                  <Plus className="w-4 h-4" />
                  Stake XRGE
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Validator List */}
      <ValidatorList />

      {/* Staking Dialog */}
      <AnimatePresence>
        {showStaking && walletId && signingPublicKey && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setShowStaking(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full p-6"
            >
              <StakingDialog
                walletId={walletId}
                signingPublicKey={signingPublicKey}
                availableBalance={availableBalance}
                onClose={() => setShowStaking(false)}
                onSuccess={loadData}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
