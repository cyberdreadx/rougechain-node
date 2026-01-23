// Chain Synchronization Module
// Bridges local P2P node storage with Supabase blockchain
// Enables true decentralized sync between nodes

import { supabase } from '@/integrations/supabase/client';
import type { ProposedBlock } from './types';
import * as storage from './storage';

export interface ChainSyncStatus {
  localHeight: number;
  supabaseHeight: number;
  networkHeight: number;
  isSynced: boolean;
  lastSyncTime: number;
}

// Fetch chain from Supabase and merge with local
export async function syncFromSupabase(): Promise<{ added: number; conflicts: number }> {
  console.log('[ChainSync] Syncing from Supabase...');
  
  const { data: supabaseBlocks, error } = await supabase.functions.invoke('pqc-crypto', {
    body: { action: 'load-chain' },
  });

  if (error || !supabaseBlocks?.chain) {
    console.error('[ChainSync] Failed to load from Supabase:', error);
    return { added: 0, conflicts: 0 };
  }

  const remoteChain = supabaseBlocks.chain as Array<{
    index: number;
    timestamp: number;
    data: string;
    previousHash: string;
    hash: string;
    nonce: number;
    signature: string;
    signerPublicKey: string;
  }>;

  const localChain = await storage.getAllBlocks();
  let added = 0;
  let conflicts = 0;

  for (const remoteBlock of remoteChain) {
    const localBlock = localChain.find(b => b.index === remoteBlock.index);
    
    if (!localBlock) {
      // Block doesn't exist locally, add it
      const block: ProposedBlock = {
        index: remoteBlock.index,
        timestamp: remoteBlock.timestamp,
        data: remoteBlock.data,
        previousHash: remoteBlock.previousHash,
        hash: remoteBlock.hash,
        nonce: remoteBlock.nonce,
        proposerSignature: remoteBlock.signature,
        proposerPublicKey: remoteBlock.signerPublicKey,
      };
      await storage.saveBlock(block);
      added++;
    } else if (localBlock.hash !== remoteBlock.hash) {
      // Conflict! Different blocks at same index
      // In a real system, we'd use longest-chain rule or finality
      console.warn(`[ChainSync] Conflict at index ${remoteBlock.index}`);
      conflicts++;
    }
  }

  console.log(`[ChainSync] Sync complete: ${added} blocks added, ${conflicts} conflicts`);
  return { added, conflicts };
}

// Push local block to Supabase (for when we mine a block via P2P consensus)
export async function pushToSupabase(block: ProposedBlock): Promise<boolean> {
  console.log(`[ChainSync] Pushing block ${block.index} to Supabase...`);
  
  const { error } = await supabase.functions.invoke('pqc-crypto', {
    body: {
      action: 'save-block',
      payload: {
        block: {
          index: block.index,
          timestamp: block.timestamp,
          data: block.data,
          previousHash: block.previousHash,
          hash: block.hash,
          nonce: block.nonce,
          signature: block.proposerSignature,
          signerPublicKey: block.proposerPublicKey,
        },
      },
    },
  });

  if (error) {
    console.error('[ChainSync] Failed to push to Supabase:', error);
    return false;
  }

  return true;
}

// Get sync status
export async function getSyncStatus(): Promise<ChainSyncStatus> {
  const localChain = await storage.getAllBlocks();
  const localHeight = localChain.length > 0 ? localChain[localChain.length - 1].index : -1;

  // Get Supabase height
  let supabaseHeight = -1;
  try {
    const { data } = await supabase.functions.invoke('pqc-crypto', {
      body: { action: 'load-chain' },
    });
    if (data?.chain?.length > 0) {
      supabaseHeight = data.chain[data.chain.length - 1].index;
    }
  } catch (e) {
    console.error('[ChainSync] Error getting Supabase height:', e);
  }

  const networkHeight = await storage.getMetadata<number>('networkHeight') ?? -1;
  const lastSyncTime = await storage.getMetadata<number>('lastSyncTime') ?? 0;

  return {
    localHeight,
    supabaseHeight,
    networkHeight: Math.max(networkHeight, supabaseHeight),
    isSynced: localHeight >= supabaseHeight && localHeight >= networkHeight,
    lastSyncTime,
  };
}

// Subscribe to real-time block updates from Supabase
export function subscribeToBlockUpdates(
  onNewBlock: (block: ProposedBlock) => void
): () => void {
  const channel = supabase
    .channel('blockchain-updates')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'pqc_blocks',
      },
      async (payload) => {
        console.log('[ChainSync] New block from Supabase:', payload.new);
        
        const newBlock = payload.new as {
          block_index: number;
          timestamp: number;
          data: string;
          previous_hash: string;
          hash: string;
          nonce: number;
          signature: string;
          signer_public_key: string;
        };

        const block: ProposedBlock = {
          index: newBlock.block_index,
          timestamp: Number(newBlock.timestamp),
          data: newBlock.data,
          previousHash: newBlock.previous_hash,
          hash: newBlock.hash,
          nonce: newBlock.nonce,
          proposerSignature: newBlock.signature,
          proposerPublicKey: newBlock.signer_public_key,
        };

        // Save to local storage
        const existingBlock = await storage.getBlock(block.index);
        if (!existingBlock) {
          await storage.saveBlock(block);
          onNewBlock(block);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Verify a block's integrity
export async function verifyBlock(block: ProposedBlock): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke('pqc-crypto', {
      body: {
        action: 'verify-signature',
        payload: {
          blockHash: block.hash,
          signature: block.proposerSignature,
          publicKey: block.proposerPublicKey,
        },
      },
    });

    if (error) return false;
    return data?.valid === true;
  } catch (e) {
    console.error('[ChainSync] Block verification failed:', e);
    return false;
  }
}

// Full chain validation
export async function validateFullChain(): Promise<{ valid: boolean; errors: string[] }> {
  const chain = await storage.getAllBlocks();
  const errors: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const block = chain[i];

    // Check chain linkage (skip genesis)
    if (i > 0) {
      const prevBlock = chain[i - 1];
      if (block.previousHash !== prevBlock.hash) {
        errors.push(`Block ${i}: Invalid chain linkage`);
      }
      if (block.index !== prevBlock.index + 1) {
        errors.push(`Block ${i}: Invalid index sequence`);
      }
    }

    // Verify PQC signature
    const valid = await verifyBlock(block);
    if (!valid) {
      errors.push(`Block ${i}: Invalid ML-DSA-65 signature`);
    }
  }

  return { valid: errors.length === 0, errors };
}
