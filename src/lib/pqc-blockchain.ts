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

export interface BlockchainState {
  chain: Block[];
  keypair: Keypair | null;
  isValid: boolean;
}

// Generate a new PQC keypair
export async function generateKeypair(): Promise<Keypair> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "generate-keypair" },
  });

  if (error) throw new Error(error.message);
  return data.keypair;
}

// Create genesis block
export async function createGenesisBlock(): Promise<{ block: Block; keypair: Keypair }> {
  const { data, error } = await supabase.functions.invoke("pqc-crypto", {
    body: { action: "create-genesis" },
  });

  if (error) throw new Error(error.message);
  return { block: data.block, keypair: data.keypair };
}

// Mine a new block
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

  // Then sign it with Dilithium
  const signResult = await supabase.functions.invoke("pqc-crypto", {
    body: {
      action: "sign-block",
      payload: { blockHash: minedBlock.hash, privateKey },
    },
  });

  if (signResult.error) throw new Error(signResult.error.message);

  return {
    ...minedBlock,
    signature: signResult.data.signature,
    signerPublicKey: publicKey,
  };
}

// Verify a block's signature
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

// Validate the entire chain
export async function validateChain(chain: Block[]): Promise<boolean> {
  for (let i = 1; i < chain.length; i++) {
    const currentBlock = chain[i];
    const previousBlock = chain[i - 1];

    // Check hash linkage
    if (currentBlock.previousHash !== previousBlock.hash) {
      return false;
    }

    // Verify PQC signature
    const validSig = await verifyBlockSignature(currentBlock);
    if (!validSig) {
      return false;
    }
  }
  return true;
}
