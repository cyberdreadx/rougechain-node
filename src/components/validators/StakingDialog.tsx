import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Shield, ShieldCheck, Crown, AlertCircle, Check, Coins, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ValidatorTier,
  STAKE_REQUIREMENTS,
  TIER_BENEFITS,
  registerValidator,
  getTierFromStake,
  formatStake,
} from "@/lib/pqc-validators";

interface StakingDialogProps {
  walletId?: string;
  signingPublicKey?: string;
  signingPrivateKey?: string;
  availableBalance: number;
  onClose: () => void;
  onSuccess: (amount: number) => void;
}

const tierConfig: Record<ValidatorTier, { icon: typeof Shield; color: string; gradient: string }> = {
  standard: {
    icon: Shield,
    color: "text-blue-400",
    gradient: "from-blue-500/20 to-blue-600/10",
  },
  operator: {
    icon: ShieldCheck,
    color: "text-purple-400",
    gradient: "from-purple-500/20 to-purple-600/10",
  },
  genesis: {
    icon: Crown,
    color: "text-amber-400",
    gradient: "from-amber-500/20 to-amber-600/10",
  },
};

export function StakingDialog({
  walletId: providedWalletId,
  signingPublicKey: providedSigningKey,
  signingPrivateKey: providedSigningPrivateKey,
  availableBalance,
  onClose,
  onSuccess,
}: StakingDialogProps) {
  const [stakeAmount, setStakeAmount] = useState("");
  const [selectedTier, setSelectedTier] = useState<ValidatorTier>("standard");
  const [isStaking, setIsStaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const walletId = providedWalletId;
  const signingPublicKey = providedSigningKey;
  const signingPrivateKey = providedSigningPrivateKey;

  const amount = parseInt(stakeAmount) || 0;
  const achievableTier = getTierFromStake(amount);
  const minRequired = STAKE_REQUIREMENTS[selectedTier];
  const hasEnoughBalance = amount <= availableBalance;
  const meetsMinimum = amount >= minRequired;
  const hasKeys = !!walletId && !!signingPublicKey && !!signingPrivateKey;
  const canStake = hasEnoughBalance && meetsMinimum && amount > 0 && hasKeys;

  useEffect(() => {
    if (amount >= STAKE_REQUIREMENTS[selectedTier]) return;
    // Auto-select tier based on amount
    setSelectedTier(achievableTier);
  }, [amount, achievableTier, selectedTier]);

  const handleStake = async () => {
    if (!canStake) return;

    setIsStaking(true);
    setError(null);

    try {
      if (!walletId || !signingPublicKey || !signingPrivateKey) {
        throw new Error("Wallet keys are missing. Please connect your wallet.");
      }
      await registerValidator(walletId, signingPublicKey, signingPrivateKey, amount, selectedTier);
      setSuccess(true);
      setTimeout(() => {
        onSuccess(amount);
        onClose();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stake");
    } finally {
      setIsStaking(false);
    }
  };

  const setMaxAmount = () => {
    setStakeAmount(availableBalance.toString());
  };

  const setTierAmount = (tier: ValidatorTier) => {
    const required = STAKE_REQUIREMENTS[tier];
    if (required <= availableBalance) {
      setStakeAmount(required.toString());
      setSelectedTier(tier);
    }
  };

  if (success) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="text-center py-8"
      >
        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="w-8 h-8 text-green-500" />
        </div>
        <h3 className="text-xl font-semibold mb-2">Stake Submitted</h3>
        <p className="text-muted-foreground">
          Your stake is pending confirmation on-chain.
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          Amount: {formatStake(amount)} XRGE · Tier:{" "}
          <span className={`font-semibold capitalize ${tierConfig[selectedTier].color}`}>{selectedTier}</span>
        </p>
      </motion.div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-1">Become a Validator</h2>
        <p className="text-sm text-muted-foreground">
          Stake XRGE to secure the network and earn rewards
        </p>
      </div>

      {/* Wallet Required */}
      {!hasKeys && (
        <Card className="bg-destructive/5 border-destructive/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Wallet required</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Create or import a wallet on the Wallet page to stake XRGE.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Tier Selection */}
      <div className="grid grid-cols-3 gap-3">
        {(Object.keys(STAKE_REQUIREMENTS) as ValidatorTier[]).map((tier) => {
          const TierIcon = tierConfig[tier].icon;
          const required = STAKE_REQUIREMENTS[tier];
          const canAfford = availableBalance >= required;
          const isSelected = selectedTier === tier;
          const isAchievable = amount >= required;

          return (
            <Card
              key={tier}
              onClick={() => canAfford && setTierAmount(tier)}
              className={`cursor-pointer transition-all border-2 ${
                isSelected
                  ? `border-current ${tierConfig[tier].color} bg-gradient-to-b ${tierConfig[tier].gradient}`
                  : canAfford
                  ? "border-border hover:border-muted-foreground"
                  : "border-border opacity-50 cursor-not-allowed"
              }`}
            >
              <CardContent className="p-3 text-center">
                <TierIcon className={`w-6 h-6 mx-auto mb-1 ${isSelected || isAchievable ? tierConfig[tier].color : "text-muted-foreground"}`} />
                <div className="font-semibold capitalize text-sm">{tier}</div>
                <div className="text-xs text-muted-foreground">
                  {formatStake(required)} XRGE
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Stake Amount Input */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="stake">Stake Amount</Label>
          <button
            onClick={setMaxAmount}
            className="text-xs text-primary hover:underline"
          >
            Max: {formatStake(availableBalance)} XRGE
          </button>
        </div>
        <div className="relative">
          <Input
            id="stake"
            type="number"
            value={stakeAmount}
            onChange={(e) => setStakeAmount(e.target.value)}
            placeholder="Enter amount to stake"
            className="pr-16"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            XRGE
          </span>
        </div>
        {amount > 0 && !meetsMinimum && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Minimum stake for {selectedTier} tier is {formatStake(minRequired)} XRGE
          </p>
        )}
        {amount > 0 && !hasEnoughBalance && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Insufficient balance
          </p>
        )}
      </div>

      {/* Tier Benefits */}
      <Card className="bg-muted/30 border-border">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Info className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium capitalize">{selectedTier} Tier Benefits</span>
          </div>
          <ul className="space-y-2">
            {TIER_BENEFITS[selectedTier].map((benefit, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                {benefit}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Summary */}
      {amount > 0 && canStake && (
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">You will stake</span>
              <span className="font-semibold">{formatStake(amount)} XRGE</span>
            </div>
            <div className="flex items-center justify-between text-sm mt-1">
              <span className="text-muted-foreground">Validator tier</span>
              <Badge variant="outline" className={`capitalize ${tierConfig[achievableTier].color} border-current`}>
                {achievableTier}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button
          onClick={handleStake}
          disabled={!canStake || isStaking}
          className="flex-1 gap-2"
        >
          {isStaking ? (
            <>
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Staking...
            </>
          ) : (
            <>
              <Coins className="w-4 h-4" />
              Stake XRGE
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
