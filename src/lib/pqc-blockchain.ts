import { supabase } from "@/integrations/supabase/client";

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

// Generate a new PQC keypair (REAL ML-DSA-65)
export async function generateKeypair(): Promise<{ keypair: Keypair; info: CryptoInfo }> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "generate-keypair" },
  });

  if (error) throw new Error(error.message);
  return {
    keypair: data.keypair,
    info: {
      algorithm: data.algorithm,
      standard: data.standard,
      publicKeySize: data.publicKeySize,
      signatureSize: "~3300 bytes",
      securityLevel: "NIST Level 3",
    },
  };
}

// Create genesis block with REAL PQC crypto
export async function createGenesisBlock(): Promise<{ block: Block; keypair: Keypair; crypto: CryptoInfo }> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "create-genesis" },
  });

  if (error) throw new Error(error.message);
  return { 
    block: data.block, 
    keypair: data.keypair,
    crypto: data.crypto,
  };
}

// Mine a new block with REAL PQC signature
export async function mineBlock(
  index: number,
  blockData: string,
  previousHash: string,
  privateKey: string,
  publicKey: string,
  difficulty: number = 2
): Promise<Block> {
  // First mine the block
  const mineResult = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "mine-block",
      payload: { index, data: blockData, previousHash, difficulty },
    },
  });

  if (mineResult.error) throw new Error(mineResult.error.message);

  const minedBlock = mineResult.data.block;

  // Then sign it with REAL ML-DSA-65
  const signResult = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "sign-block",
      payload: { blockHash: minedBlock.hash, privateKey },
    },
  });

  if (signResult.error) throw new Error(signResult.error.message);

  const fullBlock = {
    ...minedBlock,
    signature: signResult.data.signature,
    signerPublicKey: publicKey,
  };

  // Save to database
  await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "save-block",
      payload: { block: fullBlock },
    },
  });

  return fullBlock;
}

// Verify a block's signature with REAL ML-DSA-65
export async function verifyBlockSignature(block: Block): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "verify-signature",
      payload: {
        blockHash: block.hash,
        signature: block.signature,
        publicKey: block.signerPublicKey,
      },
    },
  });

  if (error) return false;
  return data.valid;
}

// Load the entire chain from database
export async function loadChain(): Promise<Block[]> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "load-chain" },
  });

  if (error) throw new Error(error.message);
  return data.chain || [];
}

// Reset the blockchain (clear database)
export async function resetChain(): Promise<void> {
  const { error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "reset-chain" },
  });

  if (error) throw new Error(error.message);
}

// Validate the entire chain
export async function validateChain(chain: Block[]): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const currentBlock = chain[i];
    
    // Check hash linkage (skip genesis)
    if (i > 0) {
      const previousBlock = chain[i - 1];
      if (currentBlock.previousHash !== previousBlock.hash) {
        errors.push(`Block ${i}: Invalid previous hash linkage`);
      }
    }

    // Verify PQC signature
    const validSig = await verifyBlockSignature(currentBlock);
    if (!validSig) {
      errors.push(`Block ${i}: Invalid ML-DSA-65 signature`);
    }
  }

  return { valid: errors.length === 0, errors };
}
