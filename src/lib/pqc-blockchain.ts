import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

export interface Block {
  index: number;
  timestamp: number;
  data: string;
  previousHash: string;
  hash: string;
  nonce: number;
  signature: string;
  signerPublicKey: string;
}

export interface Keypair {
  publicKey: string;
  privateKey: string;
}

export interface CryptoInfo {
  algorithm: string;
  standard: string;
  publicKeySize: string;
  signatureSize: string;
  securityLevel: string;
}

export interface BlockchainState {
  chain: Block[];
  keypair: Keypair | null;
  isValid: boolean;
}

const CHAIN_STORAGE_KEY = "pqc-demo-chain";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}


function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function hashBlock(block: { index: number; timestamp: number; data: string; previousHash: string; nonce: number }): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(
    `${block.index}${block.timestamp}${block.data}${block.previousHash}${block.nonce}`
  );
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function saveChain(chain: Block[]): Promise<void> {
  localStorage.setItem(CHAIN_STORAGE_KEY, JSON.stringify(chain));
}

// Generate a new PQC keypair (ML-DSA-65)
export async function generateKeypair(): Promise<{ keypair: Keypair; info: CryptoInfo }> {
  // Let the library generate its own secure random seed
  const keypair = ml_dsa65.keygen();
  return {
    keypair: {
      publicKey: bytesToHex(keypair.publicKey),
      privateKey: bytesToHex(keypair.secretKey),
    },
    info: {
      algorithm: "ML-DSA-65 (CRYSTALS-Dilithium)",
      standard: "FIPS 204",
      publicKeySize: `${keypair.publicKey.length} bytes`,
      signatureSize: "~3300 bytes",
      securityLevel: "NIST Level 3",
    },
  };
}

// Create genesis block with local PQC crypto
export async function createGenesisBlock(): Promise<{ block: Block; keypair: Keypair; crypto: CryptoInfo }> {
  const { keypair, info } = await generateKeypair();
  const block = await mineBlock(
    0,
    "Genesis Block - PQC Blockchain",
    "0".repeat(64),
    keypair.privateKey,
    keypair.publicKey,
    2
  );
  await saveChain([block]);
  return { block, keypair, crypto: info };
}

// Mine a new block with ML-DSA-65 signature (local demo only)
export async function mineBlock(
  index: number,
  blockData: string,
  previousHash: string,
  privateKey: string,
  publicKey: string,
  difficulty: number = 2
): Promise<Block> {
  let nonce = 0;
  let hash = "";
  const timestamp = Date.now();
  const target = "0".repeat(difficulty);

  while (!hash.startsWith(target)) {
    nonce++;
    hash = await hashBlock({ index, timestamp, data: blockData, previousHash, nonce });
    if (nonce > 1_000_000) break;
  }

  const messageBytes = new TextEncoder().encode(hash);
  const signature = ml_dsa65.sign(messageBytes, hexToBytes(privateKey));

  return {
    index,
    timestamp,
    data: blockData,
    previousHash,
    hash,
    nonce,
    signature: bytesToHex(signature),
    signerPublicKey: publicKey,
  };
}

// Verify a block's signature with ML-DSA-65 (demo chain only)
export async function verifyBlockSignature(block: Block): Promise<boolean> {
  try {
    const messageBytes = new TextEncoder().encode(block.hash);
    const signatureBytes = hexToBytes(block.signature);
    const publicKeyBytes = hexToBytes(block.signerPublicKey);
    return ml_dsa65.verify(signatureBytes, messageBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

// Load the entire chain from localStorage (demo only)
export async function loadChain(): Promise<Block[]> {
  try {
    const raw = localStorage.getItem(CHAIN_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Block[];
  } catch (e) {
    console.error("Load chain error:", e);
    return [];
  }
}

// Reset the blockchain (clear local demo chain)
export async function resetChain(): Promise<void> {
  localStorage.removeItem(CHAIN_STORAGE_KEY);
}

// Validate the entire chain
export async function validateChain(chain: Block[]): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const currentBlock = chain[i];
    if (i > 0) {
      const previousBlock = chain[i - 1];
      if (currentBlock.previousHash !== previousBlock.hash) {
        errors.push(`Block ${i}: Invalid previous hash linkage`);
      }
    }

    const validSig = await verifyBlockSignature(currentBlock);
    if (!validSig) {
      errors.push(`Block ${i}: Invalid ML-DSA-65 signature`);
    }
  }

  return { valid: errors.length === 0, errors };
}
