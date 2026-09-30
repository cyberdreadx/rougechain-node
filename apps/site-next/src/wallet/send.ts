/**
 * RougeChain send flow: validation (pure) + resolve + submit. Submission uses core's
 * secureTransfer (signed locally or via the extension; POST /v2/transfer on the ACTIVE network),
 * exactly the call apps/web's SendTokensDialog makes.
 */
import { isRougeAddress } from "@rougechain/core/address";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@rougechain/core/network";
import { WALLET_TRANSFER_FEE, type WalletBalance } from "@rougechain/core/pqc-wallet";
import { secureTransfer } from "@rougechain/core/secure-api";
import { formatTokenAmount, humanToRaw, l1TokenDecimals, rawToHuman } from "@rougechain/core/token-decimals";
import i18n from "../i18n";

// ML-DSA-65 public key = 1952 bytes = 3904 hex chars (small tolerance, as apps/web).
const ML_DSA65_PUBKEY_HEX_LEN = 3904;
const MIN_ADDRESS_LEN = ML_DSA65_PUBKEY_HEX_LEN - 100;
/** The node stores a wallet transfer amount as a whole number (v2_binding: `amount as u64`), so XRGE
 *  transfers are whole XRGE: a fraction would silently be dropped on-chain. */
const XRGE_MAX_FRACTION_DIGITS = 0;

export type RecipientCheck = { valid: true; address: string; isRouge: boolean } | { valid: false; error: string };

/** Accepts a rouge1… address or a hex ML-DSA-65 public key (optionally `xrge:`-prefixed). */
export function parseRecipient(input: string): RecipientCheck {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, error: i18n.t("wallet:send.errors.recipientRequired") };
  if (isRougeAddress(trimmed)) return { valid: true, address: trimmed, isRouge: true };
  const raw = /^xrge:/i.test(trimmed) ? trimmed.slice(5) : trimmed;
  if (!/^[A-Fa-f0-9]+$/.test(raw)) return { valid: false, error: i18n.t("wallet:send.errors.invalidAddress") };
  if (raw.length < MIN_ADDRESS_LEN)
    return { valid: false, error: i18n.t("wallet:send.errors.addressTooShort", { length: raw.length }) };
  return { valid: true, address: raw, isRouge: false };
}

/** Max decimal places a user may type for `symbol` (daemon decimals; XRGE fractional; others whole). */
export function maxFractionDigits(symbol: string): number {
  const d = l1TokenDecimals(symbol);
  if (d > 0) return d;
  return symbol === "XRGE" ? XRGE_MAX_FRACTION_DIGITS : 0;
}

export type AmountCheck = { valid: true; human: number; raw: number } | { valid: false; error: string };

/** Human amount string → raw on-chain units, with decimals / balance / fee checks. */
export function parseAmount(input: string, symbol: string, balances: WalletBalance[]): AmountCheck {
  const s = input.trim();
  if (!s) return { valid: false, error: i18n.t("wallet:send.errors.enterAmount") };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { valid: false, error: i18n.t("wallet:send.errors.invalidAmount") };
  const frac = s.includes(".") ? s.split(".")[1].length : 0;
  const maxFrac = maxFractionDigits(symbol);
  if (frac > maxFrac)
    return { valid: false, error: maxFrac === 0 ? i18n.t("wallet:send.errors.wholeNumbers", { symbol }) : i18n.t("wallet:send.errors.maxDecimals", { symbol, count: maxFrac }) };
  const human = Number(s);
  if (!Number.isFinite(human) || human <= 0) return { valid: false, error: i18n.t("wallet:send.errors.amountPositive") };
  const raw = l1TokenDecimals(symbol) > 0 ? humanToRaw(human, symbol) : human;
  if (!Number.isSafeInteger(Math.ceil(raw))) return { valid: false, error: i18n.t("wallet:send.errors.amountTooLarge") };

  const balanceRaw = balances.find((b) => b.symbol === symbol)?.balance ?? 0;
  if (raw > balanceRaw)
    return { valid: false, error: i18n.t("wallet:send.errors.insufficientBalance", { symbol, balance: formatTokenAmount(balanceRaw, symbol) }) };
  const xrge = balances.find((b) => b.symbol === "XRGE")?.balance ?? 0;
  const xrgeNeeded = symbol === "XRGE" ? raw + WALLET_TRANSFER_FEE : WALLET_TRANSFER_FEE;
  if (xrgeNeeded > xrge) return { valid: false, error: i18n.t("wallet:send.errors.insufficientFee", { fee: WALLET_TRANSFER_FEE }) };
  return { valid: true, human, raw };
}

/** rouge1… → recipient public key via the node (GET /resolve/:addr on the active network). */
export async function resolveRecipient(address: string): Promise<string> {
  let data: { success?: boolean; publicKey?: string };
  try {
    const res = await fetch(`${getCoreApiBaseUrl()}/resolve/${encodeURIComponent(address)}`, { headers: getCoreApiHeaders() });
    data = await res.json();
  } catch {
    throw new Error(i18n.t("wallet:send.errors.resolveFailed"));
  }
  if (!data?.success || !data.publicKey) throw new Error(i18n.t("wallet:send.errors.recipientNotFound"));
  return data.publicKey;
}

export interface SendRequest {
  wallet: { signingPublicKey: string; signingPrivateKey: string };
  recipientPublicKey: string;
  raw: number;
  symbol: string;
}

/** Sign (core) + submit. Throws with the node's message on failure. */
export async function submitTransfer(req: SendRequest): Promise<void> {
  if (req.recipientPublicKey === req.wallet.signingPublicKey) throw new Error(i18n.t("wallet:send.errors.ownAddress"));
  const result = await secureTransfer(
    req.wallet.signingPublicKey,
    req.wallet.signingPrivateKey,
    req.recipientPublicKey,
    req.raw,
    WALLET_TRANSFER_FEE,
    req.symbol,
  );
  if (!result.success) throw new Error(result.error || i18n.t("wallet:send.errors.transferFailed"));
}

export function displayAmount(raw: number, symbol: string): string {
  return l1TokenDecimals(symbol) > 0 ? formatTokenAmount(raw, symbol) : raw.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export { rawToHuman, WALLET_TRANSFER_FEE };

/**
 * Testnet faucets — the same unsigned endpoints apps/web's Wallet page calls
 * (POST /faucet, POST /faucet/bridge) on the active network's API base.
 */
export async function claimFaucet(publicKey: string, token?: "qUSDC" | "qETH"): Promise<void> {
  const url = `${getCoreApiBaseUrl()}${token ? "/faucet/bridge" : "/faucet"}`;
  const body = token ? { recipientPublicKey: publicKey, token } : { recipientPublicKey: publicKey, amount: 10000 };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: { success?: boolean; error?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(res.ok ? i18n.t("wallet:faucet.invalidResponse") : i18n.t("wallet:faucet.requestFailed", { status: res.status }));
  }
  if (!res.ok || !data?.success) throw new Error(data?.error || i18n.t("wallet:faucet.requestFailed", { status: res.status }));
}
