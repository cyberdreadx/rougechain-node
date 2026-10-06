/**
 * Bridge write flows, framework-free. Each mirrors apps/web's Bridge page step for step and goes
 * through @rougechain/core for every node call and every RougeChain signature:
 *
 *   ETH  deposit   bridge.depositETH(pubkey) with the amount as value — credited by the relayer, no claim
 *   USDC deposit   approve(bridge) → bridge.depositERC20(usdc, amount, pubkey) — credited by the relayer, no claim
 *   XRGE deposit   approve(vault) → vault.deposit(amount, pubkey) → POST /bridge/xrge/claim (poll)
 *   claim existing personal_sign → POST /bridge/claim (poll)
 *   BTC claim      POST /bridge/btc/claim (poll)
 *   withdraw       createSignedBridgeWithdraw / signViaExtension → POST /bridge/withdraw | /bridge/xrge/withdraw
 *
 * ETH / USDC deposits differ from apps/web (a plain transfer + signed claim): they call the bridge
 * contract, whose deposit event names the RougeChain recipient, so the relayer credits it for any
 * kind of Base wallet (a smart-contract wallet's plain transfer could never be claimed).
 *
 * The other addition: before every Base transaction the wallet's chain id is checked against the
 * bridge's Base chain, and the flow refuses on a mismatch (apps/web only asks the wallet to switch
 * when connecting).
 */
import {
  bridgeWithdraw,
  bridgeWithdrawXrge,
  claimBridgeDeposit,
  claimBtcBridgeDeposit,
  claimXrgeBridgeDeposit,
  type BridgeWithdrawResult,
} from "@rougechain/core/bridge";
import { createSignedBridgeWithdraw, generateNonce, type SignedTransaction, type TransactionPayload } from "@rougechain/core/pqc-signer";
import { signViaExtension } from "@rougechain/core/extension-bridge";
import {
  approveCalldata,
  assertChain,
  BRIDGE_DEPOSIT_GAS,
  bridgeDepositErc20Calldata,
  bridgeDepositEthCalldata,
  claimMessageHex,
  toHex,
  vaultDepositCalldata,
  VAULT_DEPOSIT_GAS,
  type Eip1193Provider,
} from "./evm";
import type { InflightDeposit } from "./inflight";
import { BRIDGE_FEE_XRGE, type BridgeAsset, type DepositAmount } from "./validate";
import i18n from "../i18n";

export interface FlowCtx {
  /** Injected in tests so polling runs instantly. */
  sleep?: (ms: number) => Promise<void>;
  onStep?: (text: string) => void;
  /** Called as soon as the wallet returns the deposit transaction hash, so the deposit stays tracked if the user leaves. */
  onSent?: (record: InflightDeposit) => void;
  /** The deposit transaction reverted on Base — nothing will be credited for it. */
  onReverted?: (baseTxHash: string) => void;
}

export type FlowOutcome =
  | { kind: "success"; message: string; txHash?: string; txId?: string }
  /** The deposit went through but isn't credited yet (info, not an error). */
  | { kind: "pending"; message: string; txHash?: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Attempts × interval used by apps/web for claim polling (30 × 6 s ≈ 3 min). */
export const CLAIM_ATTEMPTS = 30;
export const CLAIM_INTERVAL_MS = 6000;

export const L1_SYMBOL: Record<BridgeAsset, string> = { ETH: "qETH", USDC: "qUSDC", XRGE: "XRGE", BTC: "qBTC" };

/** User-facing message for a wallet / network error (EIP-1193 4001 = user rejected). */
export function errorMessage(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 4001) return i18n.t("bridge:errors.rejected");
  return e instanceof Error && e.message ? e.message : fallback;
}

async function pollEvmClaim(
  args: { txHash: string; evmAddress: string; evmSignature: string; recipient: string; token: "ETH" | "USDC" },
  ctx: FlowCtx,
  progress: boolean,
): Promise<{ success: boolean; error?: string }> {
  const sleep = ctx.sleep ?? realSleep;
  let last = "";
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const claim = await claimBridgeDeposit({
      evmTxHash: args.txHash,
      evmAddress: args.evmAddress,
      evmSignature: args.evmSignature,
      recipientRougechainPubkey: args.recipient,
      token: args.token,
    });
    if (claim.success) return { success: true };
    last = claim.error || "";
    if (progress) ctx.onStep?.(i18n.t("bridge:steps.waitingBaseAttempt", { attempt: attempt + 1 }));
    await sleep(CLAIM_INTERVAL_MS);
  }
  return { success: false, error: last || i18n.t("bridge:errors.baseTimeout") };
}

async function waitReceipt(provider: Eip1193Provider, hash: string, sleep: (ms: number) => Promise<void>): Promise<{ status?: string } | null> {
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
    if (receipt) return receipt;
  }
  return null;
}

function sentRecord(p: EvmDepositParams, baseTxHash: string): InflightDeposit {
  return {
    baseTxHash,
    asset: p.asset,
    l1Symbol: L1_SYMBOL[p.asset],
    amountLabel: p.asset === "XRGE" ? p.amount.l1Units.toString() : formatSix(p.amount.l1Units),
    expectedL1Units: p.amount.l1Units.toString(),
    recipientPubkey: p.recipientPubkey,
    startedAt: Date.now(),
    state: "sent",
  };
}

export interface EvmDepositParams {
  asset: "ETH" | "USDC" | "XRGE";
  provider: Eip1193Provider;
  evmAddress: string;
  /** The bridge's Base chain id (from /bridge/config), which the wallet must be on. */
  chainId: number;
  recipientPubkey: string;
  amount: DepositAmount;
  custodyAddress?: string;
  usdcAddress: string;
  xrge?: { vaultAddress?: string; tokenAddress?: string };
}

/**
 * ETH / USDC deposits (and the manual claim of one) are paused unless the build sets
 * VITE_EVM_DEPOSIT_ENABLED=true. The guard runs before any wallet request, so a paused build can
 * never start a deposit transaction. XRGE deposits are not affected.
 */
export function evmDepositsEnabled(): boolean {
  return import.meta.env.VITE_EVM_DEPOSIT_ENABLED === "true";
}

/** Base → RougeChain deposit for ETH / USDC / XRGE (apps/web handleDeposit). */
export async function depositFromBase(p: EvmDepositParams, ctx: FlowCtx = {}): Promise<FlowOutcome> {
  const sleep = ctx.sleep ?? realSleep;
  if (p.asset !== "XRGE" && !evmDepositsEnabled()) throw new Error(i18n.t("bridge:errors.evmDepositsPaused"));
  const { provider, evmAddress } = p;
  ctx.onStep?.(i18n.t("bridge:steps.checkingChain"));
  await assertChain(provider, p.chainId);

  if (p.asset === "XRGE") {
    const vaultAddr = p.xrge?.vaultAddress;
    const tokenAddr = p.xrge?.tokenAddress;
    if (!vaultAddr || !tokenAddr) throw new Error(i18n.t("bridge:errors.xrgeNotConfigured"));
    const amountWei = p.amount.baseUnits;

    ctx.onStep?.(i18n.t("bridge:steps.approvingXrge"));
    const approveTxHash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: evmAddress, to: tokenAddr, data: approveCalldata(vaultAddr, amountWei) }],
    })) as string;

    ctx.onStep?.(i18n.t("bridge:steps.waitingApproval"));
    const approveReceipt = await waitReceipt(provider, approveTxHash, sleep);
    if (!approveReceipt || approveReceipt.status !== "0x1") throw new Error(i18n.t("bridge:errors.approvalFailed"));

    await assertChain(provider, p.chainId);
    ctx.onStep?.(i18n.t("bridge:steps.depositingVault"));
    const depositTx = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: evmAddress, to: vaultAddr, data: vaultDepositCalldata(amountWei, p.recipientPubkey), gas: VAULT_DEPOSIT_GAS }],
    })) as string;
    ctx.onSent?.(sentRecord(p, depositTx));

    ctx.onStep?.(i18n.t("bridge:steps.waitingDeposit"));
    const receipt = await waitReceipt(provider, depositTx, sleep);
    if (receipt && receipt.status !== "0x1") ctx.onReverted?.(depositTx);
    if (!receipt || receipt.status !== "0x1") throw new Error(i18n.t("bridge:errors.depositTxFailed"));

    // The claim is honored only after Base confirmations; it's idempotent, so poll.
    ctx.onStep?.(i18n.t("bridge:steps.waitingBase"));
    const claimParams = { evmTxHash: depositTx, evmAddress, amount: amountWei.toString(), recipientRougechainPubkey: p.recipientPubkey };
    let lastError = "";
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const claim = await claimXrgeBridgeDeposit(claimParams);
      if (claim.success) {
        return { kind: "success", message: i18n.t("bridge:toasts.bridgedXrge", { amount: p.amount.l1Units.toString() }), txHash: depositTx, txId: claim.txId };
      }
      lastError = claim.error || "";
      ctx.onStep?.(i18n.t("bridge:steps.waitingBaseAttempt", { attempt: attempt + 1 }));
      await sleep(CLAIM_INTERVAL_MS);
    }
    // Still unconfirmed after ~3 min: the deposit is valid and the node's auto-claim finishes it.
    return { kind: "pending", message: `${i18n.t("bridge:toasts.xrgeArrivesAutomatically")}${lastError ? ` (${lastError})` : ""}`, txHash: depositTx };
  }

  const custody = p.custodyAddress;
  if (!custody) throw new Error(i18n.t("bridge:errors.notConfigured"));
  const token = p.asset;
  const amount = p.amount.baseUnits;

  if (token === "USDC") {
    ctx.onStep?.(i18n.t("bridge:steps.approvingToken", { symbol: token }));
    const approveTxHash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: evmAddress, to: p.usdcAddress, data: approveCalldata(custody, amount) }],
    })) as string;

    ctx.onStep?.(i18n.t("bridge:steps.waitingApproval"));
    const approveReceipt = await waitReceipt(provider, approveTxHash, sleep);
    if (!approveReceipt || approveReceipt.status !== "0x1") throw new Error(i18n.t("bridge:errors.approvalFailedToken", { symbol: token }));

    await assertChain(provider, p.chainId);
  }

  ctx.onStep?.(i18n.t("bridge:steps.sendingToBridge", { symbol: token }));
  const txHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      token === "ETH"
        ? { from: evmAddress, to: custody, value: toHex(amount), data: bridgeDepositEthCalldata(p.recipientPubkey), gas: BRIDGE_DEPOSIT_GAS }
        : { from: evmAddress, to: custody, data: bridgeDepositErc20Calldata(p.usdcAddress, amount, p.recipientPubkey), gas: BRIDGE_DEPOSIT_GAS },
    ],
  })) as string;
  ctx.onSent?.(sentRecord(p, txHash));

  ctx.onStep?.(i18n.t("bridge:steps.waitingDeposit"));
  const receipt = await waitReceipt(provider, txHash, sleep);
  if (receipt && receipt.status !== "0x1") {
    ctx.onReverted?.(txHash);
    throw new Error(i18n.t("bridge:errors.depositReverted"));
  }
  // No claim from the browser: the relayer credits the recipient named in the deposit event after
  // Base confirmations. A receipt not seen yet is not a failure — the deposit stays tracked.
  return { kind: "pending", message: i18n.t("bridge:toasts.depositSentAuto", { token: L1_SYMBOL[token] }), txHash };
}

function formatSix(units: bigint): string {
  const w = units / 1_000_000n;
  const f = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
}

/** Claim an ETH/USDC deposit already sent to custody (apps/web handleClaimExisting). */
export async function claimExistingDeposit(
  p: { provider: Eip1193Provider; evmAddress: string; txHash: string; recipientPubkey: string; token: "ETH" | "USDC"; chainId: number },
  ctx: FlowCtx = {},
): Promise<FlowOutcome> {
  if (!evmDepositsEnabled()) throw new Error(i18n.t("bridge:errors.evmDepositsPaused"));
  await assertChain(p.provider, p.chainId);
  let sig: string;
  try {
    sig = (await p.provider.request({ method: "personal_sign", params: [claimMessageHex(p.txHash, p.recipientPubkey), p.evmAddress] })) as string;
  } catch {
    throw new Error(i18n.t("bridge:errors.signatureRejected"));
  }
  const claim = await pollEvmClaim({ txHash: p.txHash, evmAddress: p.evmAddress, evmSignature: sig, recipient: p.recipientPubkey, token: p.token }, ctx, false);
  if (claim.success) return { kind: "success", message: i18n.t("bridge:toasts.claimed", { token: L1_SYMBOL[p.token] }), txHash: p.txHash };
  throw new Error(claim.error || i18n.t("bridge:errors.claimFailed"));
}

/**
 * Claim a BTC deposit by txid (OP_RETURN flow). Idempotent on the node (dedupe btc:{txid}).
 * apps/web sends the rouge1… address as `recipientRougechainPubkey` (omitted when unknown).
 */
export async function claimBtcDeposit(p: { txid: string; rougeAddress: string }, ctx: FlowCtx = {}): Promise<FlowOutcome> {
  const sleep = ctx.sleep ?? realSleep;
  ctx.onStep?.(i18n.t("bridge:steps.waitingBitcoin"));
  let last = "";
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const claim = await claimBtcBridgeDeposit({ btcTxid: p.txid, recipientRougechainPubkey: p.rougeAddress || undefined });
    if (claim.success) return { kind: "success", message: i18n.t("bridge:toasts.claimedQbtc") };
    last = claim.error || "";
    ctx.onStep?.(i18n.t("bridge:steps.waitingBitcoinAttempt", { attempt: attempt + 1 }));
    await sleep(CLAIM_INTERVAL_MS);
  }
  return { kind: "pending", message: `${i18n.t("bridge:toasts.btcNotConfirmedYet")}${last ? ` (${last})` : ` (${i18n.t("bridge:errors.bitcoinTimeout")})`}` };
}

export interface WithdrawWallet {
  publicKey: string;
  /** Empty / absent for an extension wallet (signs through window.rougechain). */
  privateKey?: string;
}

/**
 * Sign a bridge_withdraw intent exactly as apps/web: core's createSignedBridgeWithdraw with the
 * local key, else the same payload through the extension. qBTC carries a Bitcoin address in
 * `evmAddress`, signed verbatim (never 0x-prefixed).
 */
export async function signBridgeWithdraw(wallet: WithdrawWallet, amountUnits: number, destination: string, tokenSymbol: string): Promise<SignedTransaction> {
  const isBtc = tokenSymbol === "qBTC";
  if (wallet.privateKey) {
    return createSignedBridgeWithdraw(wallet.publicKey, wallet.privateKey, amountUnits, destination, tokenSymbol, BRIDGE_FEE_XRGE, !isBtc);
  }
  const payload: TransactionPayload = {
    type: "bridge_withdraw",
    from: wallet.publicKey,
    amount: amountUnits,
    fee: BRIDGE_FEE_XRGE,
    tokenSymbol,
    evmAddress: isBtc || destination.startsWith("0x") ? destination : `0x${destination}`,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signViaExtension(payload, wallet.publicKey);
}

/** RougeChain → Base (XRGE / qETH / qUSDC) or → Bitcoin (qBTC) withdrawal (apps/web handleWithdraw). */
export async function withdrawFromRougeChain(
  p: { asset: BridgeAsset; amountUnits: number; destination: string; wallet: WithdrawWallet },
  ctx: FlowCtx = {},
): Promise<FlowOutcome & { txId?: string }> {
  const token = L1_SYMBOL[p.asset];
  ctx.onStep?.(i18n.t("bridge:steps.signingWithdrawal"));
  const signed = await signBridgeWithdraw(p.wallet, p.amountUnits, p.destination, token);
  ctx.onStep?.(i18n.t("bridge:steps.submittingWithdrawal"));
  const payload = signed.payload as unknown as Record<string, unknown>;
  let result: BridgeWithdrawResult;
  if (p.asset === "XRGE") {
    result = await bridgeWithdrawXrge({ fromPublicKey: p.wallet.publicKey, amount: p.amountUnits, evmAddress: p.destination, signature: signed.signature, payload });
  } else {
    result = await bridgeWithdraw({ fromPublicKey: p.wallet.publicKey, amountUnits: p.amountUnits, evmAddress: p.destination, tokenSymbol: token, signature: signed.signature, payload });
  }
  if (!result.success) throw new Error(result.error || i18n.t("bridge:errors.withdrawFailed"));
  const message =
    p.asset === "BTC" ? i18n.t("bridge:toasts.withdrawQueuedBtc") : p.asset === "XRGE" ? i18n.t("bridge:toasts.withdrawSubmittedXrge") : i18n.t("bridge:toasts.withdrawSubmittedEvm", { symbol: p.asset });
  return { kind: "success", message, txId: result.txId };
}
