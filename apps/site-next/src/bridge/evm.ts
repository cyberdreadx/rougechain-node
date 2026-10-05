/**
 * Base-side helpers for the bridge: EIP-1193 types, EIP-6963 wallet discovery, the chain-id
 * guard, and the exact calldata / claim-message encodings apps/web's Bridge page sends
 * (byte-for-byte; bridge.test.ts pins them).
 */
import { useEffect, useState } from "react";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}
export interface Eip6963Info {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface Eip6963Detail {
  info: Eip6963Info;
  provider: Eip1193Provider;
}

export const ROUGECHAIN_RDNS = "io.rougechain.wallet";
export const QWALLA_RDNS = "app.qwalla.wallet";

/** Injected wallets announced via EIP-6963 (e.g. the RougeChain extension next to MetaMask). */
export function useEip6963Wallets(): Eip6963Detail[] {
  const [found, setFound] = useState<Eip6963Detail[]>([]);
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.info?.rdns) return;
      setFound((prev) => (prev.some((p) => p.info.rdns === detail.info.rdns) ? prev : [...prev, detail]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  }, []);
  return found;
}

type LegacyEthereum = Eip1193Provider & { isQwalla?: boolean; isRougeChain?: boolean; isCoinbaseWallet?: boolean; isMetaMask?: boolean };

export function legacyEthereum(): LegacyEthereum | undefined {
  return typeof window !== "undefined" ? (window as unknown as { ethereum?: LegacyEthereum }).ethereum : undefined;
}

/** Same naming as apps/web for a window.ethereum that doesn't announce itself. */
export function legacyWalletName(eth: LegacyEthereum | undefined): string | null {
  if (!eth) return null;
  return eth.isQwalla ? "Qwalla Wallet" : eth.isRougeChain ? "RougeChain Wallet" : eth.isCoinbaseWallet ? "Coinbase Wallet" : eth.isMetaMask ? "MetaMask" : null;
}

/** apps/web's preference: the RougeChain wallet, then Qwalla, else the user's choice / first announced. */
export function pickWallet(discovered: Eip6963Detail[], selectedRdns: string | null): Eip6963Detail | undefined {
  const preferred = discovered.find((d) => d.info.rdns === ROUGECHAIN_RDNS) ?? discovered.find((d) => d.info.rdns === QWALLA_RDNS);
  return discovered.find((d) => d.info.rdns === selectedRdns) ?? preferred ?? discovered[0];
}

/**
 * The injected EVM wallet to use when nothing was picked by hand: the RougeChain extension or
 * Qwalla (announced via EIP-6963 — pickWallet's preference — or a window.ethereum that says it is
 * one, e.g. Qwalla's in-app browser), else the first announced wallet, else window.ethereum.
 */
export function pickInjected(discovered: Eip6963Detail[]): { provider: Eip1193Provider; name: string | null; rdns: string | null } | undefined {
  const legacy = legacyEthereum();
  const announced = pickWallet(discovered, null);
  const announcedPreferred = announced && (announced.info.rdns === ROUGECHAIN_RDNS || announced.info.rdns === QWALLA_RDNS);
  if (announced && (announcedPreferred || !(legacy?.isQwalla || legacy?.isRougeChain))) {
    return { provider: announced.provider, name: announced.info.name, rdns: announced.info.rdns };
  }
  return legacy ? { provider: legacy, name: legacyWalletName(legacy), rdns: null } : undefined;
}

export class WrongChainError extends Error {
  constructor(
    readonly actual: number | null,
    readonly expected: number,
  ) {
    super(`Wrong chain: ${actual ?? "unknown"} (expected ${expected})`);
  }
}

/** Read the wallet's chain id (eth_chainId). null when it can't be read. */
export async function readChainId(provider: Eip1193Provider): Promise<number | null> {
  try {
    const raw = await provider.request({ method: "eth_chainId" });
    const n = typeof raw === "string" ? parseInt(raw, raw.startsWith("0x") ? 16 : 10) : typeof raw === "number" ? raw : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Refuse to continue unless the wallet is on `expected` (fails closed when unreadable). */
export async function assertChain(provider: Eip1193Provider, expected: number): Promise<void> {
  const actual = await readChainId(provider);
  if (actual !== expected) throw new WrongChainError(actual, expected);
}

/**
 * Make sure the wallet is on `expected`: ask it to switch (wallet_switchEthereumChain) when it
 * isn't, then re-read. Throws WrongChainError if it stays elsewhere (declined / unsupported).
 */
export async function ensureChain(provider: Eip1193Provider, expected: number): Promise<void> {
  if ((await readChainId(provider)) === expected) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${expected.toString(16)}` }] });
  } catch {
    // Declined or unsupported: the re-read below reports the chain it stayed on.
  }
  await assertChain(provider, expected);
}

// ── Exact encodings used by apps/web ─────────────────────────────────────────

/** 0x-hex of a bigint, as apps/web builds `value` / amounts. */
export const toHex = (n: bigint): string => `0x${n.toString(16)}`;

/** ERC-20 approve(spender, amount) — apps/web: `0x095ea7b3${vault.slice(2).padStart(64,"0")}${amount}`. */
export function approveCalldata(spender: string, amount: bigint): string {
  return `0x095ea7b3${spender.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

/** ERC-20 transfer(to, amount) — apps/web's USDC deposit to the custody address. */
export function transferCalldata(to: string, amount: bigint): string {
  return `0xa9059cbb${to.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

/** BridgeVault.deposit(uint256 amount, string rougechainPubkey) — apps/web's hand ABI encoding. */
export function vaultDepositCalldata(amountWei: bigint, rougechainPubkey: string): string {
  const pubkeyHex = Array.from(new TextEncoder().encode(rougechainPubkey))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const padded = pubkeyHex.padEnd(Math.ceil(pubkeyHex.length / 64) * 64, "0");
  return (
    "0xf1215d25" +
    amountWei.toString(16).padStart(64, "0") +
    (64).toString(16).padStart(64, "0") +
    rougechainPubkey.length.toString(16).padStart(64, "0") +
    padded
  );
}

/** Fixed gas limit apps/web sets on the vault deposit (500k). */
export const VAULT_DEPOSIT_GAS = "0x7A120";

const word = (n: bigint | number): string => n.toString(16).padStart(64, "0");

/** ABI tail of a dynamic `string`: byte length, then the UTF-8 bytes right-padded to a 32-byte boundary. */
function abiStringTail(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return word(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}

/** RougeBridge.depositETH(string rougechainPubkey) — sent with the ETH amount as `value`. */
export function bridgeDepositEthCalldata(rougechainPubkey: string): string {
  return "0x9b1c48e6" + word(32) + abiStringTail(rougechainPubkey);
}

/** RougeBridge.depositERC20(address token, uint256 amount, string rougechainPubkey) — needs a prior approve(bridge, amount). */
export function bridgeDepositErc20Calldata(token: string, amount: bigint, rougechainPubkey: string): string {
  return "0x5a67cb87" + token.slice(2).toLowerCase().padStart(64, "0") + word(amount) + word(96) + abiStringTail(rougechainPubkey);
}

/**
 * Gas limit for a RougeBridge deposit: the same fixed 500k as the vault deposit. The recipient key
 * is a 3,904-character string, so calldata (~180k at the EIP-7623 floor price) and the event that
 * repeats it dominate; wallets tend to under-estimate that, and unused gas is refunded.
 */
export const BRIDGE_DEPOSIT_GAS = VAULT_DEPOSIT_GAS;

/** The message the Base wallet personal_signs to claim an ETH/USDC deposit. */
export function claimMessage(txHash: string, recipientPubkey: string): string {
  return `RougeChain bridge claim\nTx: ${txHash}\nRecipient: ${recipientPubkey}`;
}

/** personal_sign parameter: the UTF-8 message as 0x-hex (apps/web). */
export function claimMessageHex(txHash: string, recipientPubkey: string): string {
  return (
    "0x" +
    Array.from(new TextEncoder().encode(claimMessage(txHash, recipientPubkey)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** eth_call data for ERC-20 balanceOf(owner). */
export function balanceOfCalldata(owner: string): string {
  return "0x70a08231" + owner.slice(2).padStart(64, "0");
}
