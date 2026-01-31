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
  getProposerSelectionInfo,
  getFinalityStatus,
  getVoteSummary,
  formatStake,
  STAKE_REQUIREMENTS,
} from "@/lib/pqc-validators";

interface ValidatorDashboardProps {
  walletId?: string;
  signingPublicKey?: string;
  signingPrivateKey?: string;
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
  signingPrivateKey,
  availableBalance = 0,
}: ValidatorDashboardProps) {
  const [validators, setValidators] = useState<Validator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStaking, setShowStaking] = useState(false);
  const [pendingStake, setPendingStake] = useState<{ publicKey: string; amount: number } | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<{
    height: number;
    proposerPubKey: string | null;
    totalStake: number;
    selectionWeight: string;
    entropySource: string;
    entropyHex: string;
  } | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectedProposer, setSelectedProposer] = useState<{
    proposer: Validator;
    entropy: string;
    selectionWeight: string;
  } | null>(null);
  const [selectingProposer, setSelectingProposer] = useState(false);
  const [finalityStatus, setFinalityStatus] = useState<{
    finalizedHeight: number;
    tipHeight: number;
    totalStake: number;
    quorumStake: number;
  } | null>(null);
  const [voteSummary, setVoteSummary] = useState<{
    height: number;
    totalStake: number;
    quorumStake: number;
    prevote: Array<{ blockHash: string; voters: number; stake: number }>;
    precommit: Array<{ blockHash: string; voters: number; stake: number }>;
  } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!pendingStake) return;
    const interval = setInterval(() => {
      loadData();
    }, 5000);
    return () => clearInterval(interval);
  }, [pendingStake]);

  useEffect(() => {
    const loadSelection = async () => {
      setSelectionLoading(true);
      try {
        const info = await getProposerSelectionInfo();
        setSelectionInfo(info);
        const finality = await getFinalityStatus();
        setFinalityStatus(finality);
        const summary = await getVoteSummary(finality.tipHeight);
        setVoteSummary(summary);
      } catch (error) {
        console.error("Failed to load proposer selection info:", error);
      } finally {
        setSelectionLoading(false);
      }
    };

    loadSelection();
    const interval = setInterval(loadSelection, 10000); // 10s
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await getValidators();
      setValidators(data);
      if (pendingStake && data.some((validator) => validator.signingPublicKey === pendingStake.publicKey)) {
        setPendingStake(null);
      }
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
  const averageVoteParticipation = validators.length > 0
    ? validators.reduce((sum, v) => sum + (v.voteParticipation ?? 0), 0) / validators.length
    : 0;

  // Check if current wallet is a validator
  const myValidator = signingPublicKey
    ? validators.find((validator) => validator.signingPublicKey === signingPublicKey)
    : null;

  const handleStakeSuccess = (amount: number) => {
    if (signingPublicKey) {
      setPendingStake({ publicKey: signingPublicKey, amount });
    }
    loadData();
  };

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
              <span className="text-xs">Validator Votes</span>
            </div>
            <div className="text-2xl font-bold">
              {averageVoteParticipation.toFixed(1)}%
            </div>
            <Progress 
              value={averageVoteParticipation} 
              className="h-1 mt-2" 
            />
            <div className="text-xs text-muted-foreground mt-2">
              Precommit participation (last {voteSummary?.height ?? "—"} height)
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pending Stake */}
      {pendingStake && (
        <Card className="bg-amber-500/5 border-amber-500/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-amber-400">Stake submitted</div>
                <div className="text-xs text-muted-foreground">
                  Waiting for a block to include your stake transaction.
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div className="font-mono">{pendingStake.publicKey.slice(0, 16)}...</div>
                <div>{formatStake(pendingStake.amount)} XRGE</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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

      {/* Current Proposer */}
      <Card className="bg-card/50 backdrop-blur border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Current Proposer
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Height</div>
              <div className="text-lg font-semibold">
                {selectionLoading ? "..." : selectionInfo?.height ?? "—"}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-muted-foreground">Proposer</div>
              <div className="font-mono text-sm truncate">
                {selectionLoading
                  ? "..."
                  : selectionInfo?.proposerPubKey
                  ? `${selectionInfo.proposerPubKey.slice(0, 16)}...`
                  : "—"}
              </div>
            </div>
            <div className="text-right">
              {selectionInfo?.proposerPubKey && signingPublicKey && selectionInfo.proposerPubKey === signingPublicKey ? (
                <Badge className="bg-green-500/20 text-green-500 border-green-500/30">You are selected</Badge>
              ) : (
                <Badge variant="outline" className="text-xs">Waiting</Badge>
              )}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div>
              <div>Selection Weight</div>
              <div className="text-foreground font-semibold">
                {selectionLoading ? "..." : selectionInfo?.selectionWeight ?? "—"}
              </div>
            </div>
            <div>
              <div>Total Stake</div>
              <div className="text-foreground font-semibold">
                {selectionLoading ? "..." : formatStake(selectionInfo?.totalStake ?? 0)} XRGE
              </div>
            </div>
          </div>
          {selectionInfo?.entropyHex && (
            <div className="mt-3 text-[10px] text-muted-foreground font-mono break-all">
              {selectionInfo.entropySource} · {selectionInfo.entropyHex.slice(0, 32)}...
            </div>
          )}
        </CardContent>
      </Card>

      {/* Finality Status */}
      <Card className="bg-card/50 backdrop-blur border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-success" />
            Finality Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
            <div>
              <div>Finalized</div>
              <div className="text-foreground font-semibold">
                {selectionLoading ? "..." : finalityStatus?.finalizedHeight ?? "—"}
              </div>
            </div>
            <div>
              <div>Tip</div>
              <div className="text-foreground font-semibold">
                {selectionLoading ? "..." : finalityStatus?.tipHeight ?? "—"}
              </div>
            </div>
            <div>
              <div>Quorum</div>
              <div className="text-foreground font-semibold">
                {selectionLoading ? "..." : formatStake(finalityStatus?.quorumStake ?? 0)} XRGE
              </div>
            </div>
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
                  {(myValidator.slashCount ?? 0) > 0 && (
                    <div className="text-xs text-red-400">
                      Slashed {myValidator.slashCount}x{myValidator.jailedUntil ? ` · Jail until #${myValidator.jailedUntil}` : ""}
                    </div>
                  )}
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

      {/* Validator Onboarding */}
      <Card className="bg-muted/30 border-border">
        <CardContent className="p-4 text-sm text-muted-foreground space-y-2">
          <div className="font-semibold text-foreground">New validator checklist</div>
          <div>1) Stake XRGE from your wallet to register.</div>
          <div>2) Run a node using your validator keys (`--validatorPubKey`, `--validatorPrivKey`).</div>
          <div>3) Keep the node online with peers to participate in votes.</div>
        </CardContent>
      </Card>

      {/* Validator List */}
      <ValidatorList />

      {/* Staking Dialog */}
      <AnimatePresence>
        {showStaking && (
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
              className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto p-6"
            >
              <StakingDialog
                walletId={walletId}
                signingPublicKey={signingPublicKey}
                signingPrivateKey={signingPrivateKey}
                availableBalance={availableBalance}
                onClose={() => setShowStaking(false)}
                onSuccess={handleStakeSuccess}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
