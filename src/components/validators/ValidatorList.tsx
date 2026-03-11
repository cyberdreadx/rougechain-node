import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, ShieldCheck, Crown, Zap, Clock, Activity, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Validator, ValidatorTier, getValidators, formatStake } from "@/lib/pqc-validators";

interface ValidatorListProps {
  onSelectValidator?: (validator: Validator) => void;
}

const tierConfig: Record<ValidatorTier, { icon: typeof Shield; color: string; bgClass: string }> = {
  standard: {
    icon: Shield,
    color: "text-blue-400",
    bgClass: "bg-blue-500/10 border-blue-500/30",
  },
  operator: {
    icon: ShieldCheck,
    color: "text-purple-400",
    bgClass: "bg-purple-500/10 border-purple-500/30",
  },
  genesis: {
    icon: Crown,
    color: "text-amber-400",
    bgClass: "bg-amber-500/10 border-amber-500/30",
  },
};

const statusConfig: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "bg-green-500" },
  pending: { label: "Pending", color: "bg-yellow-500" },
  jailed: { label: "Jailed", color: "bg-red-500" },
  unbonding: { label: "Unbonding", color: "bg-orange-500" },
  inactive: { label: "Inactive", color: "bg-gray-500" },
};

export function ValidatorList({ onSelectValidator }: ValidatorListProps) {
  const [validators, setValidators] = useState<Validator[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalStake, setTotalStake] = useState(0);

  useEffect(() => {
    loadValidators();
  }, []);

  const loadValidators = async () => {
    try {
      const data = await getValidators();
      const sorted = [...data].sort((a, b) => b.stakedAmount - a.stakedAmount);
      setValidators(sorted);
      setTotalStake(sorted.reduce((sum, v) => sum + v.stakedAmount, 0));
    } catch (error) {
      console.error("Failed to load validators:", error);
    } finally {
      setLoading(false);
    }
  };

  const getVotingPower = (stake: number) => {
    if (totalStake === 0) return 0;
    return (stake / totalStake) * 100;
  };

  if (loading) {
    return (
      <Card className="bg-card/50 backdrop-blur border-border">
        <CardContent className="py-12 text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading validators...</p>
        </CardContent>
      </Card>
    );
  }

  if (validators.length === 0) {
    return (
      <Card className="bg-card/50 backdrop-blur border-border">
        <CardContent className="py-12 text-center">
          <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Validators Yet</h3>
          <p className="text-muted-foreground text-sm">
            Be the first to stake XRGE and become a validator!
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50 backdrop-blur border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Validator Leaderboard
          </CardTitle>
          <Badge variant="outline" className="font-mono">
            {validators.length} total
          </Badge>
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
          <span>Total Staked: <span className="text-foreground font-semibold">{formatStake(totalStake)} XRGE</span></span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <AnimatePresence>
          {validators.map((validator, index) => {
            const TierIcon = tierConfig[validator.tier].icon;
            const status = statusConfig[validator.status];
            const votingPower = getVotingPower(validator.stakedAmount);

            return (
              <motion.div
                key={validator.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => onSelectValidator?.(validator)}
                className={`p-4 rounded-lg border cursor-pointer transition-all hover:scale-[1.01] ${tierConfig[validator.tier].bgClass}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      <span className={`text-xs font-bold ${index < 3 ? "text-primary" : "text-muted-foreground"}`}>
                        {index + 1}
                      </span>
                    </div>
                    <div className={`p-2 rounded-lg bg-background/50 ${tierConfig[validator.tier].color}`}>
                      <TierIcon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm truncate">
                          {validator.signingPublicKey.slice(0, 12)}...{validator.signingPublicKey.slice(-8)}
                        </span>
                        <Badge 
                          variant="outline" 
                          className={`text-xs capitalize ${tierConfig[validator.tier].color} border-current`}
                        >
                          {validator.tier}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <div className={`w-2 h-2 rounded-full ${status.color}`} />
                          {status.label}
                        </span>
                        <span className="flex items-center gap-1">
                          <Zap className="w-3 h-3" />
                          {validator.blocksProposed} proposed
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {validator.voteParticipation?.toFixed(1) ?? "0.0"}% votes
                        </span>
                        {validator.lastSeenHeight ? (
                          <span className="flex items-center gap-1">
                            Seen #{validator.lastSeenHeight}
                          </span>
                        ) : null}
                        {validator.slashCount && validator.slashCount > 0 && (
                          <span className="flex items-center gap-1 text-red-400">
                            Slashed {validator.slashCount}x
                          </span>
                        )}
                        {validator.status === "jailed" && validator.jailedUntil ? (
                          <span className="flex items-center gap-1 text-red-400">
                            Jailed until #{validator.jailedUntil}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-semibold text-sm">
                      {formatStake(validator.stakedAmount)} XRGE
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {votingPower.toFixed(2)}% voting power
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                </div>
                <div className="mt-3">
                  <Progress value={votingPower} className="h-1" />
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
