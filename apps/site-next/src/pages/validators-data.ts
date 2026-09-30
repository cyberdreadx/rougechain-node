/**
 * Validators data + staking rules. Every read and write goes through @rougechain/core's
 * pqc-validators (the same functions / endpoints apps/web uses):
 *   reads  GET /validators, /validators/stats, /selection, /finality, /votes, /balance/:pk
 *   writes POST /v2/stake, /v2/unstake (signed locally with ML-DSA-65, or by the extension)
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  getFinalityStatus,
  getProposerSelectionInfo,
  getTierFromStake,
  getValidators,
  getVoteSummary,
  registerValidator,
  STAKE_REQUIREMENTS,
  unstake,
  type Validator,
  type ValidatorTier,
} from "@rougechain/core/pqc-validators";
import { getWalletBalance } from "@rougechain/core/pqc-wallet";
import { useChain } from "../explorer/chain";
import { useNewBlocks } from "../wallet/hooks";
import i18n from "../i18n";

/** Fee core's secureStake / secureUnstake put in the signed payload (their default). */
export const STAKE_FEE = 1;
export const MIN_STAKE = STAKE_REQUIREMENTS.standard;
export const TIERS = Object.keys(STAKE_REQUIREMENTS) as ValidatorTier[];

export function useValidatorsData(publicKey: string | null) {
  const { network } = useChain();
  const qc = useQueryClient();
  const validators = useQuery({
    queryKey: ["pages", "validators", network],
    queryFn: getValidators,
    refetchInterval: 30_000,
    retry: 1,
  });
  const selection = useQuery({
    queryKey: ["pages", "selection", network],
    queryFn: getProposerSelectionInfo,
    refetchInterval: 30_000,
    retry: 1,
  });
  const finality = useQuery({
    queryKey: ["pages", "finality", network],
    queryFn: async () => {
      const f = await getFinalityStatus();
      const votes = await getVoteSummary(f.tipHeight).catch(() => null);
      return { ...f, votes };
    },
    refetchInterval: 30_000,
    retry: 1,
  });
  const balance = useQuery({
    queryKey: ["pages", "xrge-balance", network, publicKey],
    queryFn: async () => {
      const list = await getWalletBalance(publicKey!);
      return list.find((b) => b.symbol === "XRGE")?.balance ?? 0;
    },
    enabled: !!publicKey,
    retry: 1,
  });
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["pages"] });
  }, [qc]);
  // Same live-update source as the wallet (node WebSocket, polling fallback).
  useNewBlocks(network, refresh);
  return { network, validators, selection, finality, balance, refresh };
}

export type AmountCheck = { ok: true; amount: number } | { ok: false; error: string };

/** Messages are translated at call time (validation runs during render). */
const msg = (key: string, opts?: Record<string, unknown>) => i18n.t(`pages:staking.${key}`, opts ?? {});

function parseWhole(input: string): AmountCheck {
  const s = input.trim();
  if (!s) return { ok: false, error: msg("enterAmount") };
  if (!/^\d+$/.test(s)) return { ok: false, error: msg("wholeNumber") };
  const amount = Number(s);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: msg("enterAmount") };
  return { ok: true, amount };
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Stake validation. A first stake must reach the standard minimum (apps/web's rule); an existing
 * validator may add any amount. The fee must remain in the balance.
 */
export function checkStake(input: string, available: number, currentStake: number): AmountCheck {
  const p = parseWhole(input);
  if (!p.ok) return p;
  if (currentStake + p.amount < MIN_STAKE)
    return { ok: false, error: msg("minimum", { tier: i18n.t("pages:validators.tiers.standard").toLowerCase(), amount: fmt(MIN_STAKE) }) };
  if (p.amount > available) return { ok: false, error: msg("insufficient") };
  if (p.amount + STAKE_FEE > available) return { ok: false, error: msg("insufficientFee", { fee: STAKE_FEE }) };
  return p;
}

export function checkUnstake(input: string, staked: number, available: number): AmountCheck {
  const p = parseWhole(input);
  if (!p.ok) return p;
  if (p.amount > staked) return { ok: false, error: msg("overStaked", { amount: fmt(staked) }) };
  if (STAKE_FEE > available) return { ok: false, error: msg("insufficientFee", { fee: STAKE_FEE }) };
  return p;
}

/** Largest stakeable whole amount (balance minus the fee). */
export function maxStake(available: number): number {
  return Math.max(0, Math.floor(available - STAKE_FEE));
}

export interface StakeWallet {
  id: string;
  signingPublicKey: string;
  signingPrivateKey?: string | null;
}

/** POST /v2/stake via core registerValidator (same call as apps/web's StakingDialog). */
export async function submitStake(wallet: StakeWallet, amount: number): Promise<void> {
  await registerValidator(
    wallet.id,
    wallet.signingPublicKey,
    wallet.signingPrivateKey || "",
    amount,
    getTierFromStake(amount),
  );
}

/** POST /v2/unstake via core unstake. */
export async function submitUnstake(wallet: StakeWallet, amount: number): Promise<void> {
  await unstake(wallet.id, wallet.signingPublicKey, wallet.signingPrivateKey || "", amount);
}

export function findMine(list: Validator[] | undefined, publicKey: string | null): Validator | null {
  if (!list || !publicKey) return null;
  return list.find((v) => v.signingPublicKey === publicKey) ?? null;
}
