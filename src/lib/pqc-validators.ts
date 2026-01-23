import { supabase } from "@/integrations/supabase/client";

export type ValidatorTier = "standard" | "operator" | "genesis";
export type ValidatorStatus = "pending" | "active" | "jailed" | "unbonding" | "inactive";

export interface Validator {
  id: string;
  walletId: string;
  tier: ValidatorTier;
  status: ValidatorStatus;
  stakedAmount: number;
  signingPublicKey: string;
  commissionRate: number;
  blocksProposed: number;
  blocksValidated: number;
  uptimePercentage: number;
  lastSeenAt: string;
  registeredAt: string;
  quantumEntropyContributions: number;
}

export interface ValidatorStats {
  totalRewards: number;
  totalFeeShare: number;
  validationsCount: number;
  proposedBlocks: number;
  stakingHistory: StakingEvent[];
}

export interface StakingEvent {
  id: string;
  action: "stake" | "unstake" | "slash" | "reward";
  amount: number;
  blockIndex?: number;
  txHash?: string;
  createdAt: string;
}

export interface ProposerSelection {
  proposer: Validator;
  entropy: string;
  totalStake: number;
  selectionWeight: string;
}

// Staking requirements by tier
export const STAKE_REQUIREMENTS: Record<ValidatorTier, number> = {
  standard: 10000,    // 10,000 XRGE
  operator: 100000,   // 100,000 XRGE
  genesis: 1000000,   // 1,000,000 XRGE
};

// Tier benefits
export const TIER_BENEFITS: Record<ValidatorTier, string[]> = {
  standard: [
    "Participate in block validation",
    "Earn validation rewards",
    "5% commission on delegations",
  ],
  operator: [
    "All Standard benefits",
    "Priority in proposer selection",
    "Access to operator-only governance",
    "Contribute to quantum entropy pool",
    "10% commission on delegations",
  ],
  genesis: [
    "All Operator benefits",
    "Highest proposer priority",
    "Emergency governance powers",
    "Protocol upgrade voting rights",
    "15% commission on delegations",
  ],
};

// Register as a validator
export async function registerValidator(
  walletId: string,
  signingPublicKey: string,
  stakeAmount: number,
  tier: ValidatorTier = "standard"
): Promise<Validator> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "register-validator",
      payload: { walletId, signingPublicKey, stakeAmount, tier },
    },
  });

  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.error);
  return data.validator;
}

// Get all validators
export async function getValidators(): Promise<Validator[]> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "get-validators" },
  });

  if (error) throw new Error(error.message);
  return data.validators || [];
}

// Select next block proposer (quantum-weighted random)
export async function selectProposer(): Promise<ProposerSelection> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "select-proposer" },
  });

  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.error);
  return data;
}

// Validate a block
export async function validateBlock(
  validatorId: string,
  blockHash: string,
  blockIndex: number,
  signature: string,
  isProposer: boolean = false
): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "validate-block",
      payload: { validatorId, blockHash, blockIndex, signature, isProposer },
    },
  });

  if (error) return false;
  return data.success;
}

// Get validator statistics
export async function getValidatorStats(validatorId: string): Promise<ValidatorStats | null> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "get-validator-stats",
      payload: { validatorId },
    },
  });

  if (error) return null;
  return data.stats;
}

// Unstake tokens
export async function unstake(validatorId: string, amount: number): Promise<{
  newStakedAmount: number;
  newStatus: ValidatorStatus;
  newTier: ValidatorTier;
}> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "unstake",
      payload: { validatorId, amount },
    },
  });

  if (error) throw new Error(error.message);
  if (!data.success) throw new Error(data.error);
  return data.unstaked;
}

// Contribute quantum entropy
export async function contributeEntropy(
  validatorId: string,
  blockIndex: number
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "contribute-entropy",
      payload: { validatorId, blockIndex },
    },
  });

  if (error) throw new Error(error.message);
  return data.entropy;
}

// Calculate tier from stake amount
export function getTierFromStake(amount: number): ValidatorTier {
  if (amount >= STAKE_REQUIREMENTS.genesis) return "genesis";
  if (amount >= STAKE_REQUIREMENTS.operator) return "operator";
  return "standard";
}

// Format stake amount
export function formatStake(amount: number): string {
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `${(amount / 1_000).toFixed(1)}K`;
  }
  return amount.toString();
}
