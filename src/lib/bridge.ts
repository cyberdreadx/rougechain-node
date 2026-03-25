/**
 * Bridge: Base (Mainnet or Sepolia) ↔ RougeChain
 *
 * Supports:
 *   - ETH bridge (Base ETH → qETH)
 *   - USDC bridge (Base USDC → qUSDC)
 *   - XRGE bridge (Base XRGE ↔ L1 XRGE via BridgeVault)
 *
 * Network auto-detection: reads chainId from daemon /bridge/config
 * and selects the correct addresses and explorer URLs.
 */

import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";

// ── Chain configs ───────────────────────────────────────────────

export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Base Mainnet chain config for wallet connection */
export const baseMainnet = {
  chainId: BASE_MAINNET_CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.base.org"] },
  },
  blockExplorers: {
    default: { name: "Basescan", url: "https://basescan.org" },
  },
};

/** Base Sepolia chain config for wallet connection */
export const baseSepolia = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
  },
  blockExplorers: {
    default: { name: "Basescan", url: "https://sepolia.basescan.org" },
  },
};

/** Get the correct chain config for a given chainId */
export function getBaseChainConfig(chainId: number) {
  return chainId === BASE_MAINNET_CHAIN_ID ? baseMainnet : baseSepolia;
}

/** Get the block explorer URL for a given chainId */
export function getExplorerUrl(chainId: number): string {
  return chainId === BASE_MAINNET_CHAIN_ID
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";
}

/** Get a tx explorer link */
export function getExplorerTxUrl(chainId: number, txHash: string): string {
  return `${getExplorerUrl(chainId)}/tx/${txHash}`;
}

// ── Token addresses by network ──────────────────────────────────

const TOKEN_ADDRESSES: Record<number, { usdc: string; xrge: string }> = {
  [BASE_MAINNET_CHAIN_ID]: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    xrge: "0x147120faEC9277ec02d957584CFCD92B56A24317",
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    xrge: "0xF9e744a43608AB7D64a106df84e52915e8Efa27E",
  },
};

export function getUsdcAddress(chainId: number): string {
  return TOKEN_ADDRESSES[chainId]?.usdc || TOKEN_ADDRESSES[BASE_SEPOLIA_CHAIN_ID].usdc;
}

export function getXrgeAddress(chainId: number): string {
  return TOKEN_ADDRESSES[chainId]?.xrge || TOKEN_ADDRESSES[BASE_SEPOLIA_CHAIN_ID].xrge;
}

// ── Convenience exports (backward compat) ───────────────────────

export const USDC_BASE_SEPOLIA = TOKEN_ADDRESSES[BASE_SEPOLIA_CHAIN_ID].usdc;
export const XRGE_TOKEN_ADDRESS = TOKEN_ADDRESSES[BASE_MAINNET_CHAIN_ID].xrge;
export const XRGE_TOKEN_ADDRESS_TESTNET = TOKEN_ADDRESSES[BASE_SEPOLIA_CHAIN_ID].xrge;

// ── ABIs ────────────────────────────────────────────────────────

/** Minimal ERC-20 ABI for approve + balanceOf */
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
] as const;

/** BridgeVault ABI */
export const BRIDGE_VAULT_ABI = [
  "function deposit(uint256 amount, string rougechainPubkey) external",
  "function release(address to, uint256 amount, string l1TxId) external",
  "function totalLocked() external view returns (uint256)",
  "function vaultBalance() external view returns (uint256)",
  "function xrgeToken() external view returns (address)",
  "event BridgeDeposit(address indexed sender, uint256 amount, string rougechainPubkey, uint256 nonce)",
  "event BridgeRelease(address indexed recipient, uint256 amount, string l1TxId)",
] as const;

// ── Bridge config ───────────────────────────────────────────────

export interface BridgeConfig {
  enabled: boolean;
  custodyAddress?: string;
  chainId: number;
  supportedTokens?: string[];
}

/**
 * Fetch bridge configuration from daemon.
 * Auto-detects mainnet vs testnet from the returned chainId.
 */
export async function getBridgeConfig(): Promise<BridgeConfig> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
  try {
    const res = await fetch(`${baseUrl}/bridge/config`, {
      headers: getCoreApiHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
    const data = await res.json().catch(() => ({}));
    return {
      enabled: data.enabled === true,
      custodyAddress: data.custodyAddress,
      chainId: data.chainId ?? BASE_SEPOLIA_CHAIN_ID,
      supportedTokens: data.supportedTokens,
    };
  } catch {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
}

// ── ETH/USDC Bridge (claim + withdraw) ──────────────────────────

export interface BridgeClaimParams {
  evmTxHash: string;
  evmAddress: string;
  evmSignature: string;
  recipientRougechainPubkey: string;
  token?: "ETH" | "USDC";
}

export interface BridgeClaimResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface BridgeWithdrawParams {
  fromPublicKey: string;
  amountUnits: number;
  evmAddress: string;
  fee?: number;
  tokenSymbol?: string;
  signature?: string;
  payload?: Record<string, unknown>;
  /** @deprecated Use signature+payload instead */
  fromPrivateKey?: string;
}

export interface BridgeWithdrawResult {
  success: boolean;
  txId?: string;
  error?: string;
}

/**
 * Bridge out: burn qETH on RougeChain and request ETH release to Base.
 */
export async function bridgeWithdraw(params: BridgeWithdrawParams): Promise<BridgeWithdrawResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const evmAddr = params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`;

  const body: Record<string, unknown> = {
    fromPublicKey: params.fromPublicKey,
    amountUnits: params.amountUnits,
    evmAddress: evmAddr,
    fee: params.fee,
  };

  if (params.signature && params.payload) {
    body.signature = params.signature;
    body.payload = params.payload;
  } else if (params.fromPrivateKey) {
    body.fromPrivateKey = params.fromPrivateKey;
  }

  if (params.tokenSymbol) {
    body.payload = { ...(body.payload as Record<string, unknown> || {}), tokenSymbol: params.tokenSymbol };
  }

  const res = await fetch(`${baseUrl}/bridge/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

/**
 * Claim qETH on RougeChain after depositing ETH on Base.
 * The daemon verifies the EVM tx receipt on-chain before minting.
 */
export async function claimBridgeDeposit(params: BridgeClaimParams): Promise<BridgeClaimResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const res = await fetch(`${baseUrl}/bridge/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      evmTxHash: params.evmTxHash.startsWith("0x") ? params.evmTxHash : `0x${params.evmTxHash}`,
      evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
      evmSignature: params.evmSignature,
      recipientRougechainPubkey: params.recipientRougechainPubkey,
      token: params.token || "ETH",
    }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

// ── XRGE Bridge (Base ↔ RougeChain via BridgeVault) ─────────────

export interface XrgeBridgeConfig {
  enabled: boolean;
  vaultAddress?: string;
  tokenAddress?: string;
  chainId: number;
}

/**
 * Fetch XRGE bridge configuration from daemon.
 * Auto-selects correct token address based on chainId.
 */
export async function getXrgeBridgeConfig(): Promise<XrgeBridgeConfig> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
  try {
    const res = await fetch(`${baseUrl}/bridge/xrge/config`, {
      headers: getCoreApiHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
    const data = await res.json().catch(() => ({}));
    const chainId = data.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    return {
      enabled: data.enabled === true,
      vaultAddress: data.vaultAddress,
      tokenAddress: data.tokenAddress || getXrgeAddress(chainId),
      chainId,
    };
  } catch {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
}

export interface XrgeBridgeDepositParams {
  evmTxHash: string;
  evmAddress: string;
  amount: string;
  recipientRougechainPubkey: string;
}

/**
 * After depositing XRGE into the vault on Base, notify the L1 node
 * to credit XRGE to the recipient's L1 wallet.
 */
export async function claimXrgeBridgeDeposit(
  params: XrgeBridgeDepositParams
): Promise<BridgeClaimResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const res = await fetch(`${baseUrl}/bridge/xrge/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      evmTxHash: params.evmTxHash.startsWith("0x") ? params.evmTxHash : `0x${params.evmTxHash}`,
      evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
      amount: params.amount,
      recipientRougechainPubkey: params.recipientRougechainPubkey,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

export interface XrgeBridgeWithdrawParams {
  fromPublicKey: string;
  amount: number;
  evmAddress: string;
  signature?: string;
  payload?: Record<string, unknown>;
  /** @deprecated Use signature+payload instead */
  fromPrivateKey?: string;
}

/**
 * Burn XRGE on L1 and request the relayer to release from the vault on Base.
 */
export async function bridgeWithdrawXrge(
  params: XrgeBridgeWithdrawParams
): Promise<BridgeWithdrawResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const body: Record<string, unknown> = {
    fromPublicKey: params.fromPublicKey,
    amount: params.amount,
    evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
  };
  if (params.signature && params.payload) {
    body.signature = params.signature;
    body.payload = params.payload;
  } else if (params.fromPrivateKey) {
    body.fromPrivateKey = params.fromPrivateKey;
  }
  const res = await fetch(`${baseUrl}/bridge/xrge/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

// ── Bridge History ──────────────────────────────────────────────

export interface BridgeHistoryEntry {
  id: string;
  type: string;
  direction: "deposit" | "withdraw";
  amount: string;
  symbol: string;
  timestamp: number;
  timeLabel: string;
  status: "completed" | "pending";
  txHash?: string;
  evmTxHash?: string;
}

/**
 * Fetch recent bridge transactions for a given public key.
 * Pulls from the address transaction endpoint and filters to bridge-related types.
 */
export async function getBridgeHistory(pubkey: string): Promise<BridgeHistoryEntry[]> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl || !pubkey) return [];
  try {
    const res = await fetch(`${baseUrl}/address/${pubkey}/transactions`, {
      headers: getCoreApiHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({ transactions: [] }));
    const txs: any[] = data.transactions || [];
    
    const bridgeSymbols = ["qETH", "qUSDC", "XRGE"];
    
    return txs
      .filter((tx: any) => {
        const t = tx.type || "";
        const sym = tx.symbol || "";
        return (
          t.includes("bridge") ||
          t === "bridge_mint" ||
          (t === "receive" && bridgeSymbols.includes(sym) && (tx.from === "bridge" || tx.from === "faucet_bridge")) ||
          (t === "send" && sym === "XRGE" && tx.memo?.includes("bridge"))
        );
      })
      .slice(0, 10)
      .map((tx: any) => ({
        id: tx.id || tx.txHash || Math.random().toString(36),
        type: tx.type,
        direction: (tx.type === "send" || tx.type?.includes("withdraw")) ? "withdraw" as const : "deposit" as const,
        amount: tx.amount || "0",
        symbol: tx.symbol || "qETH",
        timestamp: tx.timestamp || 0,
        timeLabel: tx.timeLabel || "",
        status: (tx.status || "completed") as "completed" | "pending",
        txHash: tx.txHash,
      }));
  } catch {
    return [];
  }
}
