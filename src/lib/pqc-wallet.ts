import { Block, loadChain, mineBlock } from "./pqc-blockchain";

// RougeChain constants
export const TOTAL_SUPPLY = 36_000_000_000; // 36 Billion XRGE
export const TOKEN_SYMBOL = "XRGE";
export const TOKEN_NAME = "RougeCoin";
export const CHAIN_NAME = "RougeChain";
export const TOKEN_ADDRESS = "xrge:0xR0UG3CH41N-X7G3-QU4N7UM-C01N-R0UG33L4B5";
export const TOKEN_DECIMALS = 18;
export const CHAIN_ID = "rougechain-1";
export const EXPLORER_URL = "https://rougeelabs.com";

// Transaction structure embedded in block data
export interface Transaction {
  type: "transfer" | "mint" | "genesis";
  from: string; // public key or "GENESIS"/"FAUCET"
  to: string; // public key
  amount: number;
  symbol: string;
  timestamp: number;
  memo?: string;
}

export interface WalletBalance {
  symbol: string;
  balance: number;
  name: string;
  icon: string;
}

export interface WalletTransaction {
  id: string;
  type: "send" | "receive" | "swap";
  amount: string;
  symbol: string;
  address: string; // counterparty
  time: string;
  status: "completed" | "pending";
  blockIndex: number;
  txHash: string;
}

// Parse transaction data from a block
export function parseBlockTransaction(block: Block): Transaction | null {
  try {
    const data = JSON.parse(block.data);
    if (data.type && data.to && typeof data.amount === "number") {
      return data as Transaction;
    }
    return null;
  } catch {
    // Not a transaction block (could be genesis or other data)
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

// Calculate balance for a specific wallet (by public key)
export async function getWalletBalance(publicKey: string): Promise<WalletBalance[]> {
  const transactions = await getAllTransactions();
  const balances: Record<string, number> = {};

  for (const { tx } of transactions) {
    const symbol = tx.symbol || "XRGE";
    
    // Initialize if needed
    if (!balances[symbol]) {
      balances[symbol] = 0;
    }

    // Received tokens
    if (tx.to === publicKey) {
      balances[symbol] += tx.amount;
    }

    // Sent tokens
    if (tx.from === publicKey) {
      balances[symbol] -= tx.amount;
    }
  }

  // Convert to array format
  return Object.entries(balances).map(([symbol, balance]) => ({
    symbol,
    balance,
    name: symbol === "XRGE" ? "RougeCoin" : symbol,
    icon: symbol === "XRGE" ? "🔴" : "🪙",
  }));
}

// Get transaction history for a wallet
export async function getWalletTransactions(publicKey: string): Promise<WalletTransaction[]> {
  const transactions = await getAllTransactions();
  const walletTxs: WalletTransaction[] = [];

  for (const { tx, block } of transactions) {
    const isSender = tx.from === publicKey;
    const isReceiver = tx.to === publicKey;

    if (!isSender && !isReceiver) continue;

    const type = isSender ? "send" : "receive";
    const counterparty = isSender ? tx.to : tx.from;

    walletTxs.push({
      id: block.hash.slice(0, 16),
      type,
      amount: tx.amount.toString(),
      symbol: tx.symbol || "QBIT",
      address: truncateAddress(counterparty),
      time: formatTimestamp(tx.timestamp),
      status: "completed",
      blockIndex: block.index,
      txHash: block.hash,
    });
  }

  // Sort by block index (most recent first)
  return walletTxs.sort((a, b) => b.blockIndex - a.blockIndex);
}

// Create and mine a transfer transaction
export async function sendTransaction(
  fromPrivateKey: string,
  fromPublicKey: string,
  toPublicKey: string,
  amount: number,
  symbol: string = "XRGE",
  memo?: string
): Promise<Block> {
  const chain = await loadChain();
  const lastBlock = chain[chain.length - 1];
  
  if (!lastBlock) {
    throw new Error("Blockchain not initialized");
  }

  // Check balance
  const balances = await getWalletBalance(fromPublicKey);
  const tokenBalance = balances.find(b => b.symbol === symbol);
  
  if (!tokenBalance || tokenBalance.balance < amount) {
    throw new Error(`Insufficient ${symbol} balance`);
  }

  const transaction: Transaction = {
    type: "transfer",
    from: fromPublicKey,
    to: toPublicKey,
    amount,
    symbol,
    timestamp: Date.now(),
    memo,
  };

  // Mine the block with transaction data
  const newBlock = await mineBlock(
    lastBlock.index + 1,
    JSON.stringify(transaction),
    lastBlock.hash,
    fromPrivateKey,
    fromPublicKey,
    2 // difficulty
  );

  return newBlock;
}

// Mint new tokens (faucet functionality)
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

  // Check total supply cap
  const currentSupply = await getTotalSupply(symbol);
  if (currentSupply + amount > TOTAL_SUPPLY) {
    const remaining = TOTAL_SUPPLY - currentSupply;
    throw new Error(`Cannot mint ${amount} ${symbol}. Only ${remaining.toLocaleString()} tokens remaining of ${TOTAL_SUPPLY.toLocaleString()} total supply.`);
  }

  const transaction: Transaction = {
    type: "mint",
    from: "FAUCET",
    to: recipientPublicKey,
    amount,
    symbol,
    timestamp: Date.now(),
    memo: "Token faucet mint",
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

// Get remaining supply available to mint
export async function getRemainingSupply(symbol: string = "XRGE"): Promise<number> {
  const minted = await getTotalSupply(symbol);
  return TOTAL_SUPPLY - minted;
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

// Get total supply minted
export async function getTotalSupply(symbol: string = "XRGE"): Promise<number> {
  const transactions = await getAllTransactions();
  let supply = 0;

  for (const { tx } of transactions) {
    if (tx.symbol === symbol && (tx.type === "mint" || tx.from === "FAUCET" || tx.from === "GENESIS")) {
      supply += tx.amount;
    }
  }

  return supply;
}
