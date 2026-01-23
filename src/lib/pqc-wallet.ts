import { Block, loadChain, mineBlock } from "./pqc-blockchain";

// RougeChain constants
export const TOTAL_SUPPLY = 36_000_000_000; // 36 Billion XRGE
export const TOKEN_SYMBOL = "XRGE";
export const TOKEN_NAME = "RougeCoin";
export const CHAIN_NAME = "RougeChain";
export const TOKEN_DECIMALS = 18;
export const CHAIN_ID = "rougechain-1";
export const EXPLORER_URL = "https://rougeelabs.com";

// Fee constants
export const BASE_TRANSFER_FEE = 0.1; // 0.1 XRGE per transfer
export const TOKEN_CREATION_FEE = 100; // 100 XRGE to create a token
export const MINT_FEE = 1; // 1 XRGE per mint operation

// Transaction types
export type TransactionType = "transfer" | "mint" | "genesis" | "create_token" | "fee";

// Transaction structure embedded in block data
export interface Transaction {
  type: TransactionType;
  from: string;
  to: string;
  amount: number;
  symbol: string;
  timestamp: number;
  memo?: string;
  fee?: number;
  feeRecipient?: string;
  // Token creation fields
  tokenData?: {
    name: string;
    symbol: string;
    totalSupply: number;
    decimals: number;
    creatorAddress: string;
    tokenAddress: string; // Derived from quantum signature
  };
}

// Token info
export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  totalSupply: number;
  decimals: number;
  creator: string;
  createdAt: number;
  blockIndex: number;
}

export interface WalletBalance {
  symbol: string;
  balance: number;
  name: string;
  icon: string;
  tokenAddress?: string;
}

export interface WalletTransaction {
  id: string;
  type: "send" | "receive" | "swap" | "create_token" | "fee";
  amount: string;
  symbol: string;
  address: string;
  time: string;
  status: "completed" | "pending";
  blockIndex: number;
  txHash: string;
  fee?: number;
}

// Generate a token address from block hash (quantum-derived)
export function deriveTokenAddress(blockHash: string, creatorKey: string): string {
  // Combine block hash with creator's public key for uniqueness
  const combined = blockHash.slice(0, 32) + creatorKey.slice(0, 16);
  // Create a readable address format
  const addressPart = combined.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  return `xrge:${addressPart}`;
}

// Parse transaction data from a block
export function parseBlockTransaction(block: Block): Transaction | null {
  try {
    const data = JSON.parse(block.data);
    if (data.type) {
      return data as Transaction;
    }
    return null;
  } catch {
    return null;
  }
}

// Get all transactions from the chain
export async function getAllTransactions(): Promise<{ tx: Transaction; block: Block }[]> {
  const chain = await loadChain();
  const transactions: { tx: Transaction; block: Block }[] = [];

  for (const block of chain) {
    const tx = parseBlockTransaction(block);
    if (tx) {
      transactions.push({ tx, block });
    }
  }

  return transactions;
}

// Get all created tokens
export async function getAllTokens(): Promise<TokenInfo[]> {
  const transactions = await getAllTransactions();
  const tokens: TokenInfo[] = [];

  // XRGE is the native token
  tokens.push({
    address: "native",
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    totalSupply: TOTAL_SUPPLY,
    decimals: TOKEN_DECIMALS,
    creator: "GENESIS",
    createdAt: 0,
    blockIndex: 0,
  });

  for (const { tx, block } of transactions) {
    if (tx.type === "create_token" && tx.tokenData) {
      tokens.push({
        address: tx.tokenData.tokenAddress,
        name: tx.tokenData.name,
        symbol: tx.tokenData.symbol,
        totalSupply: tx.tokenData.totalSupply,
        decimals: tx.tokenData.decimals,
        creator: tx.tokenData.creatorAddress,
        createdAt: tx.timestamp,
        blockIndex: block.index,
      });
    }
  }

  return tokens;
}

// Get token by symbol
export async function getTokenBySymbol(symbol: string): Promise<TokenInfo | null> {
  const tokens = await getAllTokens();
  return tokens.find(t => t.symbol === symbol) || null;
}

// Calculate balance for a specific wallet (by public key)
// Now supports both node API (for public deployment) and local Supabase (for dev)
export async function getWalletBalance(publicKey: string): Promise<WalletBalance[]> {
  // Try node API first (for public deployment)
  const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || "http://localhost:5100/api";
  
  try {
    const res = await fetch(`${NODE_API_URL}/balance/${publicKey}`);
    if (res.ok) {
      const data = await res.json() as { success: boolean; balance: number };
      if (data.success) {
        // Return in WalletBalance format
        return [{
          symbol: "XRGE",
          balance: data.balance,
          name: "RougeCoin",
          icon: "🔴",
          tokenAddress: "",
        }];
      }
    }
  } catch (nodeError) {
    console.log("Node API unavailable, falling back to local...", nodeError);
  }

  // Fallback to local Supabase method (for dev)
  const transactions = await getAllTransactions();
  const tokens = await getAllTokens();
  const balances: Record<string, number> = {};

  for (const { tx } of transactions) {
    const symbol = tx.symbol || "XRGE";
    
    if (!balances[symbol]) {
      balances[symbol] = 0;
    }

    // For token creation, creator receives the full supply (don't double-count)
    if (tx.type === "create_token" && tx.from === publicKey) {
      balances[symbol] += tx.amount;
      // Deduct the creation fee
      if (tx.fee && tx.fee > 0) {
        if (!balances["XRGE"]) balances["XRGE"] = 0;
        balances["XRGE"] -= tx.fee;
      }
      continue;
    }

    // Received tokens
    if (tx.to === publicKey && tx.type !== "fee") {
      balances[symbol] += tx.amount;
    }

    // Sent tokens (including fees)
    if (tx.from === publicKey) {
      balances[symbol] -= tx.amount;
      // Deduct fee if present
      if (tx.fee && tx.fee > 0) {
        if (!balances["XRGE"]) balances["XRGE"] = 0;
        balances["XRGE"] -= tx.fee;
      }
    }

    // Fee recipient receives the fee
    if (tx.feeRecipient === publicKey && tx.fee) {
      if (!balances["XRGE"]) balances["XRGE"] = 0;
      balances["XRGE"] += tx.fee;
    }
  }

  // Convert to array format with token info
  return Object.entries(balances)
    .filter(([_, balance]) => balance !== 0)
    .map(([symbol, balance]) => {
      const token = tokens.find(t => t.symbol === symbol);
      return {
        symbol,
        balance,
        name: token?.name || symbol,
        icon: symbol === "XRGE" ? "🔴" : "🪙",
        tokenAddress: token?.address,
      };
    });
}

// Get transaction history for a wallet
export async function getWalletTransactions(publicKey: string): Promise<WalletTransaction[]> {
  const transactions = await getAllTransactions();
  const walletTxs: WalletTransaction[] = [];

  for (const { tx, block } of transactions) {
    const isSender = tx.from === publicKey;
    const isReceiver = tx.to === publicKey;
    const isFeeRecipient = tx.feeRecipient === publicKey;

    if (!isSender && !isReceiver && !isFeeRecipient) continue;

    let type: WalletTransaction["type"] = isSender ? "send" : "receive";
    if (tx.type === "create_token") type = "create_token";
    
    const counterparty = isSender ? tx.to : tx.from;

    walletTxs.push({
      id: block.hash.slice(0, 16),
      type,
      amount: tx.amount.toString(),
      symbol: tx.symbol || "XRGE",
      address: truncateAddress(counterparty),
      time: formatTimestamp(tx.timestamp),
      status: "completed",
      blockIndex: block.index,
      txHash: block.hash,
      fee: tx.fee,
    });
  }

  return walletTxs.sort((a, b) => b.blockIndex - a.blockIndex);
}

// Calculate required fee for a transaction
export function calculateFee(type: TransactionType): number {
  switch (type) {
    case "transfer":
      return BASE_TRANSFER_FEE;
    case "create_token":
      return TOKEN_CREATION_FEE;
    case "mint":
      return MINT_FEE;
    default:
      return 0;
  }
}

// Create and mine a transfer transaction with fee
// Now supports both node API (for public deployment) and local Supabase (for dev)
export async function sendTransaction(
  fromPrivateKey: string,
  fromPublicKey: string,
  toPublicKey: string,
  amount: number,
  symbol: string = "XRGE",
  memo?: string
): Promise<Block> {
  // Try node API first (for public deployment)
  const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || "http://localhost:5100/api";
  
  try {
    const res = await fetch(`${NODE_API_URL}/tx/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromPrivateKey,
        fromPublicKey,
        toPublicKey,
        amount,
        fee: BASE_TRANSFER_FEE,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        // Return a mock Block object for compatibility
        return {
          index: 0, // Will be updated when block is mined
          timestamp: Date.now(),
          data: JSON.stringify({ type: "transfer", from: fromPublicKey, to: toPublicKey, amount }),
          previousHash: "",
          hash: data.txId || "",
          nonce: 0,
          signature: "",
          signerPublicKey: fromPublicKey,
        };
      }
    }
  } catch (nodeError) {
    console.log("Node API unavailable, falling back to local...", nodeError);
  }

  // Fallback to local Supabase method (for dev)
  const chain = await loadChain();
  const lastBlock = chain[chain.length - 1];
  
  if (!lastBlock) {
    throw new Error("Blockchain not initialized");
  }

  const fee = calculateFee("transfer");
  
  // Check balance (need amount + fee if sending XRGE, or amount + separate XRGE for fee)
  const balances = await getWalletBalance(fromPublicKey);
  const tokenBalance = balances.find(b => b.symbol === symbol)?.balance || 0;
  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;

  if (symbol === "XRGE") {
    if (tokenBalance < amount + fee) {
      throw new Error(`Insufficient XRGE. Need ${amount + fee} XRGE (${amount} + ${fee} fee)`);
    }
  } else {
    if (tokenBalance < amount) {
      throw new Error(`Insufficient ${symbol} balance`);
    }
    if (xrgeBalance < fee) {
      throw new Error(`Insufficient XRGE for fee. Need ${fee} XRGE`);
    }
  }

  const transaction: Transaction = {
    type: "transfer",
    from: fromPublicKey,
    to: toPublicKey,
    amount,
    symbol,
    timestamp: Date.now(),
    memo,
    fee,
    feeRecipient: lastBlock.signerPublicKey, // Fee goes to last block miner
  };

  const newBlock = await mineBlock(
    lastBlock.index + 1,
    JSON.stringify(transaction),
    lastBlock.hash,
    fromPrivateKey,
    fromPublicKey,
    2
  );

  return newBlock;
}

// Create a new token
export async function createToken(
  creatorPrivateKey: string,
  creatorPublicKey: string,
  tokenName: string,
  tokenSymbol: string,
  totalSupply: number,
  decimals: number = 18
): Promise<{ block: Block; tokenAddress: string }> {
  const chain = await loadChain();
  const lastBlock = chain[chain.length - 1];
  
  if (!lastBlock) {
    throw new Error("Blockchain not initialized. Create genesis block first.");
  }

  // Check if symbol already exists
  const existingToken = await getTokenBySymbol(tokenSymbol);
  if (existingToken) {
    throw new Error(`Token symbol ${tokenSymbol} already exists`);
  }

  // Check XRGE balance for fee
  const fee = calculateFee("create_token");
  const balances = await getWalletBalance(creatorPublicKey);
  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;
  
  if (xrgeBalance < fee) {
    throw new Error(`Insufficient XRGE for token creation. Need ${fee} XRGE`);
  }

  // Generate a preliminary token address (will be finalized with block hash)
  const tempAddress = `xrge:${Date.now().toString(36)}${creatorPublicKey.slice(0, 20)}`;

  const transaction: Transaction = {
    type: "create_token",
    from: creatorPublicKey,
    to: creatorPublicKey, // Creator receives the initial supply
    amount: totalSupply,
    symbol: tokenSymbol,
    timestamp: Date.now(),
    fee,
    feeRecipient: lastBlock.signerPublicKey,
    tokenData: {
      name: tokenName,
      symbol: tokenSymbol,
      totalSupply,
      decimals,
      creatorAddress: creatorPublicKey,
      tokenAddress: tempAddress, // Will be updated
    },
  };

  const newBlock = await mineBlock(
    lastBlock.index + 1,
    JSON.stringify(transaction),
    lastBlock.hash,
    creatorPrivateKey,
    creatorPublicKey,
    2
  );

  // Derive final token address from block hash
  const finalTokenAddress = deriveTokenAddress(newBlock.hash, creatorPublicKey);

  return { block: newBlock, tokenAddress: finalTokenAddress };
}

// Mint new tokens (faucet functionality) - with fee
export async function mintTokens(
  minerPrivateKey: string,
  minerPublicKey: string,
  recipientPublicKey: string,
  amount: number = 100,
  symbol: string = "XRGE"
): Promise<Block> {
  const chain = await loadChain();
  const lastBlock = chain[chain.length - 1];
  
  if (!lastBlock) {
    throw new Error("Blockchain not initialized. Create genesis block first.");
  }

  // Only check supply cap for XRGE
  if (symbol === "XRGE") {
    const currentSupply = await getTotalSupply(symbol);
    if (currentSupply + amount > TOTAL_SUPPLY) {
      const remaining = TOTAL_SUPPLY - currentSupply;
      throw new Error(`Cannot mint ${amount} ${symbol}. Only ${remaining.toLocaleString()} remaining.`);
    }
  }

  const transaction: Transaction = {
    type: "mint",
    from: "FAUCET",
    to: recipientPublicKey,
    amount,
    symbol,
    timestamp: Date.now(),
    memo: "Token faucet mint",
    fee: 0, // Faucet mints are free
  };

  const newBlock = await mineBlock(
    lastBlock.index + 1,
    JSON.stringify(transaction),
    lastBlock.hash,
    minerPrivateKey,
    minerPublicKey,
    2
  );

  return newBlock;
}

// Helper functions
function truncateAddress(address: string): string {
  if (address === "FAUCET" || address === "GENESIS") return address;
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString();
}

// Get total supply minted for a token
export async function getTotalSupply(symbol: string = "XRGE"): Promise<number> {
  const transactions = await getAllTransactions();
  let supply = 0;

  for (const { tx } of transactions) {
    if (tx.symbol === symbol) {
      if (tx.type === "mint" || tx.from === "FAUCET" || tx.from === "GENESIS") {
        supply += tx.amount;
      }
      if (tx.type === "create_token" && tx.tokenData?.symbol === symbol) {
        supply += tx.tokenData.totalSupply;
      }
    }
  }

  return supply;
}

// Get remaining supply available to mint (XRGE only)
export async function getRemainingSupply(): Promise<number> {
  const minted = await getTotalSupply("XRGE");
  return TOTAL_SUPPLY - minted;
}
