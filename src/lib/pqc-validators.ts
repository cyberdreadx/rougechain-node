import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { secureStake, secureUnstake } from "@/lib/secure-api";

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
  voteParticipation?: number;
  lastSeenHeight?: number | null;
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

export interface FinalityStatus {
  finalizedHeight: number;
  tipHeight: number;
  totalStake: number;
  quorumStake: number;
}

export interface VoteSummaryEntry {
  blockHash: string;
  voters: number;
  stake: number;
}

export interface VoteSummary {
  height: number;
  totalStake: number;
  quorumStake: number;
  prevote: VoteSummaryEntry[];
  precommit: VoteSummaryEntry[];
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

// Register as a validator (v2 client-side signing)
export async function registerValidator(
  walletId: string,
  signingPublicKey: string,
  signingPrivateKey: string,
  stakeAmount: number,
  tier: ValidatorTier = "standard"
): Promise<Validator> {
  const result = await secureStake(signingPublicKey, signingPrivateKey, stakeAmount);
  if (!result.success) {
    throw new Error(result.error || "Failed to submit stake transaction");
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    return [];
  }
  const response = await fetch(`${apiBase}/validators`, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) {
    return [];
  }

  const data = await response.json().catch(() => null);
  const validators = Array.isArray(data?.validators) ? data.validators : [];
  const stats = await getValidatorVoteStats();
  const statsByKey = new Map(stats.validators.map((entry) => [entry.publicKey, entry]));

  return validators.map((validator: { publicKey: string; stake: string; status?: string; slashCount?: number; jailedUntil?: number; entropyContributions?: number }) => {
    const stakeAmount = Number(validator.stake || 0);
    const tier = getTierFromStake(stakeAmount);
    const voteStats = statsByKey.get(validator.publicKey);
    const voteParticipation = voteStats?.precommitParticipation ?? 0;
    return {
      id: `validator-${validator.publicKey.slice(0, 12)}`,
      walletId: `xrge:${validator.publicKey.slice(0, 32)}`,
      tier,
      status: (validator.status as ValidatorStatus) || "active",
      stakedAmount: stakeAmount,
      signingPublicKey: validator.publicKey,
      commissionRate: COMMISSION_BY_TIER[tier],
      blocksProposed: 0,
      blocksValidated: Math.round(voteParticipation),
      uptimePercentage: voteParticipation || 0,
      lastSeenAt: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      quantumEntropyContributions: validator.entropyContributions ?? 0,
      slashCount: validator.slashCount ?? 0,
      jailedUntil: validator.jailedUntil ?? 0,
      voteParticipation,
      lastSeenHeight: voteStats?.lastSeenHeight ?? null,
    };
  });
}

// Select next block proposer (quantum-weighted random)
export async function selectProposer(): Promise<ProposerSelection> {
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/selection`, {
    headers: getCoreApiHeaders(),
  });
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/selection`, {
    headers: getCoreApiHeaders(),
  });
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

export async function getFinalityStatus(): Promise<FinalityStatus> {
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/finality`, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) {
    throw new Error("Failed to fetch finality status");
  }
  const data = await response.json().catch(() => null);
  if (!data?.success) {
    throw new Error(data?.error || "Finality status unavailable");
  }
  return {
    finalizedHeight: Number(data.finalizedHeight || 0),
    tipHeight: Number(data.tipHeight || 0),
    totalStake: Number(data.totalStake || 0),
    quorumStake: Number(data.quorumStake || 0),
  };
}

export async function getVoteSummary(height?: number): Promise<VoteSummary> {
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const url = height ? `${apiBase}/votes?height=${encodeURIComponent(height)}` : `${apiBase}/votes`;
  const response = await fetch(url, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) {
    throw new Error("Failed to fetch vote summary");
  }
  const data = await response.json().catch(() => null);
  if (!data?.success) {
    throw new Error(data?.error || "Vote summary unavailable");
  }
  return {
    height: Number(data.height || 0),
    totalStake: Number(data.totalStake || 0),
    quorumStake: Number(data.quorumStake || 0),
    prevote: Array.isArray(data.prevote)
      ? data.prevote.map((entry: { blockHash: string; voters: number; stake: string }) => ({
          blockHash: entry.blockHash,
          voters: Number(entry.voters || 0),
          stake: Number(entry.stake || 0),
        }))
      : [],
    precommit: Array.isArray(data.precommit)
      ? data.precommit.map((entry: { blockHash: string; voters: number; stake: string }) => ({
          blockHash: entry.blockHash,
          voters: Number(entry.voters || 0),
          stake: Number(entry.stake || 0),
        }))
      : [],
  };
}

export async function getValidatorVoteStats(): Promise<{
  totalHeights: number;
  validators: Array<{
    publicKey: string;
    prevoteParticipation: number;
    precommitParticipation: number;
    lastSeenHeight: number | null;
  }>;
}> {
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    return { totalHeights: 0, validators: [] };
  }
  const response = await fetch(`${apiBase}/validators/stats`, {
    headers: getCoreApiHeaders(),
  });
  if (!response.ok) {
    return { totalHeights: 0, validators: [] };
  }
  const data = await response.json().catch(() => null);
  if (!data?.success) {
    return { totalHeights: 0, validators: [] };
  }
  return {
    totalHeights: Number(data.totalHeights || 0),
    validators: Array.isArray(data.validators) ? data.validators : [],
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/votes/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      type: isProposer ? "precommit" : "prevote",
      height: blockIndex,
      round: 0,
      blockHash,
      voterPubKey: validatorId,
      signature,
    }),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || "Failed to submit vote");
  }
  return true;
}

// Get validator statistics
export async function getValidatorStats(validatorId: string): Promise<ValidatorStats | null> {
  const stats = await getValidatorVoteStats();
  const entry = stats.validators.find((validator) => validator.publicKey === validatorId);
  if (!entry) return null;
  const validationsCount = Math.round((entry.precommitParticipation / 100) * stats.totalHeights);
  return {
    totalRewards: 0,
    totalFeeShare: 0,
    validationsCount,
    proposedBlocks: 0,
    stakingHistory: [],
  };
}

// Unstake tokens
// Unstake tokens (v2 client-side signing)
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
  const result = await secureUnstake(signingPublicKey, signingPrivateKey, amount);
  if (!result.success) {
    throw new Error(result.error || "Failed to submit unstake transaction");
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const response = await fetch(`${apiBase}/entropy/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      publicKey: validatorId,
      height: blockIndex,
    }),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || "Failed to submit entropy contribution");
  }
  return "submitted";
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
