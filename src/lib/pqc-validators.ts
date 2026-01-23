import { getNodeApiBaseUrl } from "@/lib/network";

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
  slashCount?: number;
  jailedUntil?: number;
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

export interface ProposerSelectionInfo {
  height: number;
  proposerPubKey: string | null;
  totalStake: number;
  selectionWeight: string;
  entropySource: string;
  entropyHex: string;
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

const COMMISSION_BY_TIER: Record<ValidatorTier, number> = {
  standard: 0.05,
  operator: 0.1,
  genesis: 0.15,
};

// Register as a validator
export async function registerValidator(
  walletId: string,
  signingPublicKey: string,
  signingPrivateKey: string,
  stakeAmount: number,
  tier: ValidatorTier = "standard"
): Promise<Validator> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/stake/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromPrivateKey: signingPrivateKey,
      fromPublicKey: signingPublicKey,
      amount: stakeAmount,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || "Failed to submit stake transaction");
  }

  const resolvedTier = getTierFromStake(stakeAmount) || tier;
  return {
    id: `validator-${signingPublicKey.slice(0, 12)}`,
    walletId,
    tier: resolvedTier,
    status: "active",
    stakedAmount: stakeAmount,
    signingPublicKey,
    commissionRate: COMMISSION_BY_TIER[resolvedTier],
    blocksProposed: 0,
    blocksValidated: 0,
    uptimePercentage: 100,
    lastSeenAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    quantumEntropyContributions: 0,
  };
}

// Get all validators
export async function getValidators(): Promise<Validator[]> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    return [];
  }
  const response = await fetch(`${apiBase}/validators`);
  if (!response.ok) {
    return [];
  }

  const data = await response.json().catch(() => null);
  const validators = Array.isArray(data?.validators) ? data.validators : [];

  return validators.map((validator: { publicKey: string; stake: string; status?: string; slashCount?: number; jailedUntil?: number }) => {
    const stakeAmount = Number(validator.stake || 0);
    const tier = getTierFromStake(stakeAmount);
    return {
      id: `validator-${validator.publicKey.slice(0, 12)}`,
      walletId: `xrge:${validator.publicKey.slice(0, 32)}`,
      tier,
      status: (validator.status as ValidatorStatus) || "active",
      stakedAmount: stakeAmount,
      signingPublicKey: validator.publicKey,
      commissionRate: COMMISSION_BY_TIER[tier],
      blocksProposed: 0,
      blocksValidated: 0,
      uptimePercentage: 100,
      lastSeenAt: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      quantumEntropyContributions: 0,
      slashCount: validator.slashCount ?? 0,
      jailedUntil: validator.jailedUntil ?? 0,
    };
  });
}

// Select next block proposer (quantum-weighted random)
export async function selectProposer(): Promise<ProposerSelection> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/selection`);
  if (!response.ok) {
    throw new Error("Failed to fetch proposer selection");
  }
  const data = await response.json().catch(() => null);
  if (!data?.success) {
    throw new Error(data?.error || "Proposer selection unavailable");
  }

  const validators = await getValidators();
  const matched = validators.find((validator) => validator.signingPublicKey === data.proposer);
  const fallback: Validator = matched ?? {
    id: `validator-${String(data.proposer).slice(0, 12)}`,
    walletId: `xrge:${String(data.proposer).slice(0, 32)}`,
    tier: "standard",
    status: "active",
    stakedAmount: 0,
    signingPublicKey: data.proposer ?? "",
    commissionRate: COMMISSION_BY_TIER.standard,
    blocksProposed: 0,
    blocksValidated: 0,
    uptimePercentage: 0,
    lastSeenAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    quantumEntropyContributions: 0,
  };

  return {
    proposer: fallback,
    entropy: data.entropyHex ?? "",
    totalStake: Number(data.totalStake || 0),
    selectionWeight: data.selectionWeight ?? "0",
  };
}

export async function getProposerSelectionInfo(): Promise<ProposerSelectionInfo> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/selection`);
  if (!response.ok) {
    throw new Error("Failed to fetch proposer selection");
  }
  const data = await response.json().catch(() => null);
  if (!data?.success) {
    throw new Error(data?.error || "Proposer selection unavailable");
  }
  return {
    height: Number(data.height || 0),
    proposerPubKey: data.proposer ?? null,
    totalStake: Number(data.totalStake || 0),
    selectionWeight: data.selectionWeight ?? "0",
    entropySource: data.entropySource ?? "unknown",
    entropyHex: data.entropyHex ?? "",
  };
}

// Validate a block
export async function validateBlock(
  validatorId: string,
  blockHash: string,
  blockIndex: number,
  signature: string,
  isProposer: boolean = false
): Promise<boolean> {
  console.warn("validateBlock is not implemented in node daemon", {
    validatorId,
    blockHash,
    blockIndex,
    signature,
    isProposer,
  });
  return false;
}

// Get validator statistics
export async function getValidatorStats(validatorId: string): Promise<ValidatorStats | null> {
  console.warn("getValidatorStats is not implemented in node daemon", { validatorId });
  return null;
}

// Unstake tokens
export async function unstake(
  validatorId: string,
  signingPublicKey: string,
  signingPrivateKey: string,
  amount: number
): Promise<{
  newStakedAmount: number;
  newStatus: ValidatorStatus;
  newTier: ValidatorTier;
}> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/unstake/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromPrivateKey: signingPrivateKey,
      fromPublicKey: signingPublicKey,
      amount,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || "Failed to submit unstake transaction");
  }

  const validators = await getValidators();
  const updated = validators.find((validator) => validator.signingPublicKey === signingPublicKey);
  const nextStake = updated?.stakedAmount ?? 0;
  const nextTier = getTierFromStake(nextStake);
  return {
    newStakedAmount: nextStake,
    newStatus: nextStake > 0 ? "active" : "inactive",
    newTier: nextTier,
  };
}

// Contribute quantum entropy
export async function contributeEntropy(
  validatorId: string,
  blockIndex: number
): Promise<string> {
  console.warn("contributeEntropy is not implemented in node daemon", {
    validatorId,
    blockIndex,
  });
  return "";
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
