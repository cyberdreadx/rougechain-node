import { Block } from "./pqc-blockchain";
import { getActiveNetwork, getCoreApiBaseUrl, getCoreApiHeaders } from "./network";

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
  type: "send" | "receive" | "swap" | "create_token" | "fee" | "stake" | "unstake" | "add_liquidity" | "remove_liquidity" | "create_pool" | "nft_mint" | "nft_transfer" | "bridge";
  amount: string;
  symbol: string;
  address: string;
  timeLabel: string;
  timestamp: number;
  status: "completed" | "pending";
  blockIndex: number;
  txHash: string;
  fee?: number;
  from?: string;
  to?: string;
  memo?: string;
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
// Now supports both node API (for public deployment) and local Supabase (for dev)
export async function getAllTransactions(): Promise<{ tx: Transaction; block: Block }[]> {
  const NODE_API_URL = getCoreApiBaseUrl();
  if (!NODE_API_URL) {
    return [];
  }

  try {
    const res = await fetch(`${NODE_API_URL}/blocks`, {
      headers: getCoreApiHeaders(),
    });
    if (res.ok) {
      const data = await res.json() as { blocks: Array<{
        version: 1;
        header: {
          height: number;
          time: number;
          prevHash?: string;
          prev_hash?: string;
          proposerPubKey?: string;
          proposer_pub_key?: string;
        };
        txs: Array<{
          version: 1;
          type?: string;
          tx_type?: string;
          fromPubKey?: string;
          from_pub_key?: string;
          nonce: number;
          payload: Record<string, unknown>;
          fee: number;
          sig: string;
        }>;
        proposerSig?: string;
        proposer_sig?: string;
        hash: string;
      }> };

      const transactions: { tx: Transaction; block: Block }[] = [];

      for (const blockV1 of data.blocks) {
        const header = blockV1.header;
        const prevHash = header.prevHash ?? header.prev_hash ?? "";
        const proposerPubKey = header.proposerPubKey ?? header.proposer_pub_key ?? "";
        const proposerSig = blockV1.proposerSig ?? blockV1.proposer_sig ?? "";
        for (const txV1 of blockV1.txs) {
          const txType = txV1.type ?? txV1.tx_type;
          const fromPubKey = txV1.fromPubKey ?? txV1.from_pub_key ?? "";
          
          if (txType === "transfer") {
            const payload = txV1.payload as { 
              toPubKeyHex?: string; 
              to_pub_key_hex?: string; 
              amount?: number; 
              faucet?: boolean;
              token_symbol?: string;
              tokenSymbol?: string;
            };
            const isFaucet = payload.faucet === true;
            // Check for token symbol - if present, this is a token transfer
            const tokenSymbol = payload.token_symbol || payload.tokenSymbol;
            const tx: Transaction = {
              type: isFaucet ? "mint" : "transfer",
              from: isFaucet ? "FAUCET" : fromPubKey,
              to: payload.toPubKeyHex || payload.to_pub_key_hex || "",
              amount: payload.amount || 0,
              symbol: tokenSymbol || "XRGE", // Use token symbol if present, otherwise XRGE
              timestamp: blockV1.header.time,
              memo: isFaucet ? "Faucet" : (tokenSymbol ? `${tokenSymbol} transfer` : undefined),
              fee: txV1.fee,
              feeRecipient: proposerPubKey,
            };

            const block: Block = {
              index: blockV1.header.height,
              timestamp: blockV1.header.time,
              data: JSON.stringify(tx),
              previousHash: prevHash,
              hash: blockV1.hash,
              nonce: 0,
              signature: proposerSig,
              signerPublicKey: proposerPubKey,
            };

            transactions.push({ tx, block });
          } else if (txType === "create_token") {
            try {
              const p = txV1.payload;
              const tokenName = (p.token_name || p.tokenName || "Unknown Token") as string;
              const tokenSymbol = (p.token_symbol || p.tokenSymbol || "TOKEN") as string;
              const tokenDecimals = (p.token_decimals ?? p.tokenDecimals ?? 18) as number;
              const totalSupply = (p.token_total_supply || p.tokenTotalSupply || p.amount || 0) as number;
              const safeFromPubKey = fromPubKey || "";
              const tokenAddress = safeFromPubKey.length >= 16 
                ? `token:${safeFromPubKey.slice(0, 16)}:${tokenSymbol.toLowerCase()}`
                : `token:unknown:${tokenSymbol.toLowerCase()}`;
              
              const tx: Transaction = {
                type: "create_token",
                from: fromPubKey,
                to: fromPubKey,
                amount: totalSupply,
                symbol: tokenSymbol,
                timestamp: blockV1.header.time,
                memo: `Created ${tokenName} (${tokenSymbol})`,
                fee: txV1.fee,
                feeRecipient: proposerPubKey,
                tokenData: {
                  name: tokenName,
                  symbol: tokenSymbol,
                  decimals: tokenDecimals,
                  totalSupply: totalSupply,
                  tokenAddress: tokenAddress,
                  creatorAddress: fromPubKey,
                },
              };

              const block: Block = {
                index: blockV1.header.height,
                timestamp: blockV1.header.time,
                data: JSON.stringify(tx),
                previousHash: prevHash,
                hash: blockV1.hash,
                nonce: 0,
                signature: proposerSig,
                signerPublicKey: proposerPubKey,
              };

              transactions.push({ tx, block });
            } catch (tokenParseError) {
              console.error("Error parsing create_token tx:", tokenParseError);
            }
          } else if (txType === "swap") {
            const p = txV1.payload;
            const tokenIn = (p.token_in || p.tokenIn || "") as string;
            const tokenOut = (p.token_out || p.tokenOut || "") as string;
            const amountIn = (p.amount_in || p.amountIn || 0) as number;

            const tx: Transaction = {
              type: "transfer",
              from: fromPubKey,
              to: fromPubKey,
              amount: amountIn,
              symbol: tokenIn,
              timestamp: blockV1.header.time,
              memo: `Swap ${amountIn} ${tokenIn} → ${tokenOut}`,
              fee: txV1.fee,
              feeRecipient: proposerPubKey,
            };

            const block: Block = {
              index: blockV1.header.height,
              timestamp: blockV1.header.time,
              data: JSON.stringify(tx),
              previousHash: prevHash,
              hash: blockV1.hash,
              nonce: 0,
              signature: proposerSig,
              signerPublicKey: proposerPubKey,
            };

            transactions.push({ tx, block });
          } else if (txType === "stake" || txType === "unstake") {
            const p = txV1.payload;
            const amount = (p.amount || 0) as number;

            const tx: Transaction = {
              type: "transfer",
              from: fromPubKey,
              to: fromPubKey,
              amount: amount,
              symbol: "XRGE",
              timestamp: blockV1.header.time,
              memo: txType === "stake" ? `Staked ${amount} XRGE` : `Unstaked ${amount} XRGE`,
              fee: txV1.fee,
              feeRecipient: proposerPubKey,
            };

            const block: Block = {
              index: blockV1.header.height,
              timestamp: blockV1.header.time,
              data: JSON.stringify(tx),
              previousHash: prevHash,
              hash: blockV1.hash,
              nonce: 0,
              signature: proposerSig,
              signerPublicKey: proposerPubKey,
            };

            transactions.push({ tx, block });
          } else if (txType === "create_pool" || txType === "add_liquidity" || txType === "remove_liquidity") {
            const p = txV1.payload;
            const tokenA = (p.token_a_symbol || p.tokenASymbol || p.token_a || "") as string;
            const tokenB = (p.token_b_symbol || p.tokenBSymbol || p.token_b || "") as string;
            const label = txType === "create_pool" ? "Created pool" : txType === "add_liquidity" ? "Added liquidity" : "Removed liquidity";

            const tx: Transaction = {
              type: "transfer",
              from: fromPubKey,
              to: fromPubKey,
              amount: 0,
              symbol: "XRGE",
              timestamp: blockV1.header.time,
              memo: `${label}: ${tokenA}/${tokenB}`,
              fee: txV1.fee,
              feeRecipient: proposerPubKey,
            };

            const block: Block = {
              index: blockV1.header.height,
              timestamp: blockV1.header.time,
              data: JSON.stringify(tx),
              previousHash: prevHash,
              hash: blockV1.hash,
              nonce: 0,
              signature: proposerSig,
              signerPublicKey: proposerPubKey,
            };

            transactions.push({ tx, block });
          } else if (txType?.startsWith("nft_")) {
            const p = txV1.payload;
            const colId = (p.nft_collection_id || p.nftCollectionId || "") as string;
            const tokenId = (p.nft_token_id || p.nftTokenId || "") as string;
            const labels: Record<string, string> = {
              nft_create_collection: "Created NFT collection",
              nft_mint: "Minted NFT",
              nft_batch_mint: "Batch minted NFTs",
              nft_transfer: "NFT transfer",
              nft_burn: "Burned NFT",
              nft_lock: "Locked/Unlocked NFT",
              nft_freeze_collection: "Froze collection",
            };

            const tx: Transaction = {
              type: "transfer",
              from: fromPubKey,
              to: (p.to_pub_key_hex || p.toPubKeyHex || fromPubKey) as string,
              amount: txV1.fee,
              symbol: "XRGE",
              timestamp: blockV1.header.time,
              memo: `${labels[txType || ""] || txType}${colId ? ` (${(colId as string).slice(0, 12)}...)` : ""}${tokenId ? ` #${tokenId}` : ""}`,
              fee: txV1.fee,
              feeRecipient: proposerPubKey,
            };

            const block: Block = {
              index: blockV1.header.height,
              timestamp: blockV1.header.time,
              data: JSON.stringify(tx),
              previousHash: prevHash,
              hash: blockV1.hash,
              nonce: 0,
              signature: proposerSig,
              signerPublicKey: proposerPubKey,
            };

            transactions.push({ tx, block });
          } else if (txType === "bridge_mint" || txType === "bridge_withdraw") {
            const p = txV1.payload;
            const amount = (p.amount || 0) as number;
            const tokenSymbol = (p.token_symbol || p.tokenSymbol || "qETH") as string;

            const tx: Transaction = {
              type: "transfer",
              from: txType === "bridge_mint" ? "BRIDGE" : fromPubKey,
              to: txType === "bridge_mint" ? ((p.to_pub_key_hex || p.toPubKeyHex || "") as string) : "BRIDGE",
              amount: amount,
              symbol: tokenSymbol,
              timestamp: blockV1.header.time,
              memo: txType === "bridge_mint" ? `Bridge deposit: ${amount} ${tokenSymbol}` : `Bridge withdrawal: ${amount} ${tokenSymbol}`,
              fee: txV1.fee,
              feeRecipient: proposerPubKey,
            };

            const block: Block = {
              index: blockV1.header.height,
              timestamp: blockV1.header.time,
              data: JSON.stringify(tx),
              previousHash: prevHash,
              hash: blockV1.hash,
              nonce: 0,
              signature: proposerSig,
              signerPublicKey: proposerPubKey,
            };

            transactions.push({ tx, block });
          }
        }
      }

      // Debug logging (only in development)
      if (import.meta.env.DEV) {
        console.log(`[Wallet] Loaded ${transactions.length} transactions from ${data.blocks.length} blocks`);
      }

      return transactions;
    }
  } catch (nodeError) {
    if (getActiveNetwork() === "mainnet") {
      return [];
    }
    console.log("Node API unavailable.", nodeError);
  }

  return [];
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
  const balances: WalletBalance[] = [];
  
  // Try node API first (for public deployment)
  const NODE_API_URL = getCoreApiBaseUrl();
  if (!NODE_API_URL) {
    return [{
      symbol: "XRGE",
      balance: 0,
      name: "RougeCoin",
      icon: "🔴",
      tokenAddress: "",
    }];
  }
  
  try {
    // Get XRGE balance AND token balances from API
    const res = await fetch(`${NODE_API_URL}/balance/${publicKey}`, {
      headers: getCoreApiHeaders(),
    });
    if (res.ok) {
      const data = await res.json() as { 
        success: boolean; 
        balance: number;
        token_balances?: Record<string, number>;
      };
      
      if (data.success) {
        // Add XRGE balance
        balances.push({
          symbol: "XRGE",
          balance: data.balance,
          name: "RougeCoin",
          icon: "🔴",
          tokenAddress: "",
        });
        
        // Add custom token balances from API (this includes swap results!)
        if (data.token_balances) {
          for (const [symbol, balance] of Object.entries(data.token_balances)) {
            if (balance > 0) {
              balances.push({
                symbol,
                balance,
                name: symbol, // We could fetch token metadata if needed
                icon: symbol.charAt(0)?.toUpperCase() || "T",
                tokenAddress: `token:${symbol.toLowerCase()}`,
              });
            }
          }
        }
      }
    }
    
    // If we got balances from API, return them
    if (balances.length > 0) {
      return balances;
    }
  } catch (nodeError) {
    if (getActiveNetwork() === "mainnet") {
      return [{
        symbol: "XRGE",
        balance: 0,
        name: "RougeCoin",
        icon: "🔴",
        tokenAddress: "",
      }];
    }
    console.log("Node API unavailable, falling back to local...", nodeError);
  }

  // Fallback to local Supabase method (for dev)
  const fallbackTxs = await getAllTransactions();
  const tokens = await getAllTokens();
  const fallbackBalances: Record<string, number> = {};

  for (const { tx } of fallbackTxs) {
    const symbol = tx.symbol || "XRGE";
    
    if (!fallbackBalances[symbol]) {
      fallbackBalances[symbol] = 0;
    }

    // For token creation, creator receives the full supply (don't double-count)
    if (tx.type === "create_token" && tx.from === publicKey) {
      fallbackBalances[symbol] += tx.amount;
      // Deduct the creation fee
      if (tx.fee && tx.fee > 0) {
        if (!fallbackBalances["XRGE"]) fallbackBalances["XRGE"] = 0;
        fallbackBalances["XRGE"] -= tx.fee;
      }
      continue;
    }

    // Received tokens
    if (tx.to === publicKey && tx.type !== "fee") {
      fallbackBalances[symbol] += tx.amount;
    }

    // Sent tokens (including fees)
    if (tx.from === publicKey) {
      fallbackBalances[symbol] -= tx.amount;
      // Deduct fee if present
      if (tx.fee && tx.fee > 0) {
        if (!fallbackBalances["XRGE"]) fallbackBalances["XRGE"] = 0;
        fallbackBalances["XRGE"] -= tx.fee;
      }
    }

    // Fee recipient receives the fee
    if (tx.feeRecipient === publicKey && tx.fee) {
      if (!fallbackBalances["XRGE"]) fallbackBalances["XRGE"] = 0;
      fallbackBalances["XRGE"] += tx.fee;
    }
  }

  // Convert to array format with token info
  return Object.entries(fallbackBalances)
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
    
    // Map memo-based types for display
    const memo = tx.memo || "";
    if (memo.startsWith("Swap ")) type = "swap";
    else if (memo.startsWith("Staked ")) type = "stake";
    else if (memo.startsWith("Unstaked ")) type = "unstake";
    else if (memo.startsWith("Created pool") || memo.startsWith("Added liquidity")) type = "add_liquidity";
    else if (memo.startsWith("Removed liquidity")) type = "remove_liquidity";
    else if (memo.startsWith("Created NFT") || memo.startsWith("Minted NFT") || memo.startsWith("Batch minted") || memo.startsWith("NFT transfer") || memo.startsWith("Burned NFT") || memo.startsWith("Locked/Unlocked") || memo.startsWith("Froze collection")) type = "nft_mint";
    else if (memo.startsWith("Bridge ")) type = "bridge";

    const counterparty = isSender ? tx.to : tx.from;

    walletTxs.push({
      id: block.hash.slice(0, 16),
      type,
      amount: tx.amount.toString(),
      symbol: tx.symbol || "XRGE",
      address: truncateAddress(counterparty),
      timeLabel: formatTimestamp(tx.timestamp),
      timestamp: tx.timestamp,
      status: "completed",
      blockIndex: block.index,
      txHash: block.hash,
      fee: tx.fee,
      from: tx.from,
      to: tx.to,
      memo: tx.memo,
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
  const NODE_API_URL = getCoreApiBaseUrl();
  
  try {
    const res = await fetch(`${NODE_API_URL}/tx/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
      body: JSON.stringify({
        fromPrivateKey,
        fromPublicKey,
        toPublicKey,
        amount,
        fee: BASE_TRANSFER_FEE,
        tokenSymbol: symbol !== "XRGE" ? symbol : undefined, // Include token symbol for non-XRGE transfers
      }),
    });

    // Check for empty response
    const text = await res.text();
    if (!text) {
      console.error("Empty response from tx/submit, status:", res.status);
      throw new Error(`Server returned empty response (status ${res.status})`);
    }
    
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error("Failed to parse response:", text);
      throw new Error(`Invalid JSON response: ${text.substring(0, 100)}`);
    }
    
    if (res.ok && data.success) {
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
    
    // Backend returned an error
    if (data.error) {
      throw new Error(data.error);
    }
    
    throw new Error(`Transaction failed: ${res.status} ${res.statusText}`);
  } catch (nodeError) {
    if (nodeError instanceof Error && !nodeError.message.includes("Node API")) {
      throw nodeError; // Re-throw backend errors
    }
    console.log("Node API unavailable.", nodeError);
    throw new Error("Node API is unavailable. Start a node with --mine to submit transactions.");
  }
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
  const NODE_API_URL = getCoreApiBaseUrl();
  if (!NODE_API_URL) {
    throw new Error("Node API is not configured");
  }
  
  try {
    const res = await fetch(`${NODE_API_URL}/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
      body: JSON.stringify({
        fromPrivateKey: creatorPrivateKey,
        fromPublicKey: creatorPublicKey,
        tokenName,
        tokenSymbol,
        totalSupply,
        decimals,
      }),
    });

    const data = await res.json();
    
    if (res.ok && data.success) {
      return {
        block: {
          index: 0,
          timestamp: Date.now(),
          data: JSON.stringify({ type: "create_token", tokenName, tokenSymbol, totalSupply }),
          previousHash: "",
          hash: data.txId || "",
          nonce: 0,
          signature: "",
          signerPublicKey: creatorPublicKey,
        },
        tokenAddress: data.tokenAddress,
      };
    }
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    throw new Error(`Token creation failed: ${res.status}`);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to create token");
  }
}

// Mint new tokens (faucet functionality) - with fee
// Now supports both node API (for public deployment) and local Supabase (for dev)
export async function mintTokens(
  minerPrivateKey: string,
  minerPublicKey: string,
  recipientPublicKey: string,
  amount: number = 100,
  symbol: string = "XRGE"
): Promise<Block> {
  // Try node API first (for public deployment)
  const NODE_API_URL = getCoreApiBaseUrl();
  if (!NODE_API_URL) {
    throw new Error("Mainnet API is not configured");
  }
  
  try {
    // Use the faucet endpoint which handles minting properly
    const res = await fetch(`${NODE_API_URL}/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
      body: JSON.stringify({
        recipientPublicKey,
        amount,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        // Return a mock Block object for compatibility
        return {
          index: 0, // Will be updated when block is mined
          timestamp: Date.now(),
          data: JSON.stringify({ type: "mint", from: "FAUCET", to: recipientPublicKey, amount, symbol }),
          previousHash: "",
          hash: data.txId || "",
          nonce: 0,
          signature: "",
          signerPublicKey: minerPublicKey,
        };
      }
    }
  } catch (nodeError) {
    throw nodeError instanceof Error ? nodeError : new Error("Faucet request failed");
  }
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
      // Devnet/Testnet node: faucet uses miner keys and transfer txs.
      // Treat transfers originating from the block proposer as mint-like issuance.
      if (tx.type === "transfer" && tx.feeRecipient && tx.from === tx.feeRecipient) {
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
