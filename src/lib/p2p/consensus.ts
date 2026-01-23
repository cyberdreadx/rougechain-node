// Distributed Consensus Protocol for RougeChain
// Implements Byzantine Fault Tolerant consensus across P2P network

import type { 
  ConsensusRound, 
  ProposedBlock, 
  BlockVote, 
  P2PMessage,
  ConsensusPhase,
  NodeIdentity
} from './types';
import { PeerConnectionManager } from './peer-connection';
import * as storage from './storage';
import { supabase } from '@/integrations/supabase/client';

const CONSENSUS_TIMEOUT = 30000; // 30 seconds
const VOTING_THRESHOLD = 2/3; // 2/3 majority required

type ConsensusEventHandler = (event: string, data: unknown) => void;

export class ConsensusProtocol {
  private peerManager: PeerConnectionManager;
  private identity: NodeIdentity | null = null;
  private currentRound: ConsensusRound | null = null;
  private eventHandlers: Set<ConsensusEventHandler> = new Set();
  private consensusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(peerManager: PeerConnectionManager) {
    this.peerManager = peerManager;
    this.setupMessageHandlers();
  }

  onEvent(handler: ConsensusEventHandler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: string, data: unknown) {
    this.eventHandlers.forEach(handler => handler(event, data));
  }

  private setupMessageHandlers() {
    this.peerManager.onMessage((message) => {
      switch (message.type) {
        case 'BLOCK_PROPOSE':
          this.handleBlockProposal(message);
          break;
        case 'BLOCK_VOTE':
          this.handleBlockVote(message);
          break;
        case 'BLOCK_COMMIT':
          this.handleBlockCommit(message);
          break;
        case 'BLOCK_FINALIZED':
          this.handleBlockFinalized(message);
          break;
        case 'CONSENSUS_STATE':
          this.handleConsensusState(message);
          break;
      }
    });
  }

  async initialize(identity: NodeIdentity): Promise<void> {
    this.identity = identity;
    await storage.initStorage();
    
    // Load any pending consensus rounds
    const activeRounds = await storage.getActiveConsensusRounds();
    if (activeRounds.length > 0) {
      this.currentRound = activeRounds[0];
    }
  }

  async proposeBlock(blockData: string): Promise<ConsensusRound | null> {
    if (!this.identity) {
      throw new Error('Node identity not initialized');
    }

    if (this.currentRound && this.currentRound.phase !== 'committed') {
      console.warn('[Consensus] Already in active consensus round');
      return null;
    }

    // Get current chain height
    const chainHeight = await storage.getChainHeight();
    const newIndex = chainHeight + 1;
    const chain = await storage.getAllBlocks();
    const previousHash = chain.length > 0 ? chain[chain.length - 1].hash : '0'.repeat(64);

    // Mine the block locally first
    const minedBlock = await this.mineBlockLocally(newIndex, blockData, previousHash);
    
    // Create consensus round
    const roundId = `round-${newIndex}-${Date.now()}`;
    const round: ConsensusRound = {
      roundId,
      blockIndex: newIndex,
      proposerId: this.identity.peerId,
      proposedBlock: minedBlock,
      phase: 'proposing',
      votes: new Map(),
      startedAt: Date.now(),
      expiresAt: Date.now() + CONSENSUS_TIMEOUT,
    };

    this.currentRound = round;
    await storage.saveConsensusRound(round);

    // Broadcast proposal to all peers
    const proposalMessage: P2PMessage = {
      type: 'BLOCK_PROPOSE',
      from: this.identity.peerId,
      timestamp: Date.now(),
      signature: await this.signMessage(roundId),
      payload: {
        roundId,
        block: minedBlock,
      },
    };

    const sent = this.peerManager.broadcast(proposalMessage);
    console.log(`[Consensus] Proposed block ${newIndex}, broadcast to ${sent} peers`);

    this.emit('round:started', round);
    this.startConsensusTimer(round);

    // Move to voting phase
    round.phase = 'voting';
    await storage.saveConsensusRound(round);

    return round;
  }

  private async mineBlockLocally(
    index: number, 
    data: string, 
    previousHash: string
  ): Promise<ProposedBlock> {
    // Call edge function for mining (uses PQC signatures)
    const { data: result, error } = await supabase.functions.invoke('pqc-crypto', {
      body: {
        action: 'mine-block',
        payload: { index, data, previousHash, difficulty: 2 },
      },
    });

    if (error) throw new Error(error.message);

    // Sign with proposer key
    const { data: signResult, error: signError } = await supabase.functions.invoke('pqc-crypto', {
      body: {
        action: 'sign-block',
        payload: { 
          blockHash: result.block.hash, 
          privateKey: this.identity?.privateKey 
        },
      },
    });

    if (signError) throw new Error(signError.message);

    return {
      ...result.block,
      proposerSignature: signResult.signature,
      proposerPublicKey: this.identity?.publicKey || '',
    };
  }

  private async signMessage(data: string): Promise<string> {
    const { data: result, error } = await supabase.functions.invoke('pqc-crypto', {
      body: {
        action: 'sign-message',
        payload: { 
          message: data, 
          privateKey: this.identity?.privateKey 
        },
      },
    });

    if (error) return '';
    return result.signature;
  }

  private async handleBlockProposal(message: P2PMessage) {
    const { roundId, block } = message.payload as { 
      roundId: string; 
      block: ProposedBlock 
    };

    console.log(`[Consensus] Received block proposal ${block.index} from ${message.from}`);

    // Verify the block
    const isValid = await this.verifyProposedBlock(block);
    
    // Create vote
    const vote: BlockVote = {
      roundId,
      voterId: this.identity?.peerId || '',
      voterPublicKey: this.identity?.publicKey || '',
      approve: isValid,
      signature: await this.signMessage(`${roundId}:${isValid}`),
      timestamp: Date.now(),
    };

    // Store the round locally
    const round: ConsensusRound = {
      roundId,
      blockIndex: block.index,
      proposerId: message.from,
      proposedBlock: block,
      phase: 'voting',
      votes: new Map([[this.identity?.peerId || '', isValid]]),
      startedAt: Date.now(),
      expiresAt: Date.now() + CONSENSUS_TIMEOUT,
    };
    
    this.currentRound = round;
    await storage.saveConsensusRound(round);

    // Broadcast vote
    const voteMessage: P2PMessage = {
      type: 'BLOCK_VOTE',
      from: this.identity?.peerId || '',
      timestamp: Date.now(),
      signature: vote.signature,
      payload: vote,
    };

    this.peerManager.broadcast(voteMessage);
    this.emit('vote:cast', vote);
  }

  private async verifyProposedBlock(block: ProposedBlock): Promise<boolean> {
    try {
      // Verify block hash
      const { data: verifyResult, error } = await supabase.functions.invoke('pqc-crypto', {
        body: {
          action: 'verify-block-hash',
          payload: { block },
        },
      });

      if (error || !verifyResult.valid) return false;

      // Verify signature
      const { data: sigResult, error: sigError } = await supabase.functions.invoke('pqc-crypto', {
        body: {
          action: 'verify-signature',
          payload: {
            blockHash: block.hash,
            signature: block.proposerSignature,
            publicKey: block.proposerPublicKey,
          },
        },
      });

      if (sigError || !sigResult.valid) return false;

      // Verify chain linkage
      const chain = await storage.getAllBlocks();
      if (chain.length > 0) {
        const lastBlock = chain[chain.length - 1];
        if (block.previousHash !== lastBlock.hash) {
          console.warn('[Consensus] Block does not link to local chain');
          return false;
        }
        if (block.index !== lastBlock.index + 1) {
          console.warn('[Consensus] Block index mismatch');
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('[Consensus] Block verification failed:', error);
      return false;
    }
  }

  private async handleBlockVote(message: P2PMessage) {
    const vote = message.payload as BlockVote;

    if (!this.currentRound || this.currentRound.roundId !== vote.roundId) {
      console.warn('[Consensus] Vote for unknown round:', vote.roundId);
      return;
    }

    console.log(`[Consensus] Received vote from ${vote.voterId}: ${vote.approve ? 'APPROVE' : 'REJECT'}`);

    // Record the vote
    this.currentRound.votes.set(vote.voterId, vote.approve);
    await storage.saveConsensusRound(this.currentRound);

    this.emit('vote:received', vote);

    // Check if we have enough votes
    await this.checkConsensus();
  }

  private async checkConsensus() {
    if (!this.currentRound || this.currentRound.phase !== 'voting') return;

    const totalPeers = this.peerManager.getConnectedCount() + 1; // +1 for self
    const votes = Array.from(this.currentRound.votes.values());
    const approvals = votes.filter(v => v).length;
    const rejections = votes.filter(v => !v).length;

    console.log(`[Consensus] Votes: ${approvals} approve, ${rejections} reject (need ${Math.ceil(totalPeers * VOTING_THRESHOLD)}/${totalPeers})`);

    // Check for 2/3 majority
    const threshold = Math.ceil(totalPeers * VOTING_THRESHOLD);

    if (approvals >= threshold) {
      await this.finalizeBlock();
    } else if (rejections >= threshold) {
      await this.rejectBlock();
    }
  }

  private async finalizeBlock() {
    if (!this.currentRound) return;

    console.log(`[Consensus] Block ${this.currentRound.blockIndex} FINALIZED`);

    this.currentRound.phase = 'finalizing';
    await storage.saveConsensusRound(this.currentRound);

    // Store block locally
    await storage.saveBlock(this.currentRound.proposedBlock);
    await storage.setMetadata('lastCommittedIndex', this.currentRound.blockIndex);

    // Broadcast finalization
    const finalizeMessage: P2PMessage = {
      type: 'BLOCK_FINALIZED',
      from: this.identity?.peerId || '',
      timestamp: Date.now(),
      signature: await this.signMessage(this.currentRound.roundId),
      payload: {
        roundId: this.currentRound.roundId,
        block: this.currentRound.proposedBlock,
      },
    };

    this.peerManager.broadcast(finalizeMessage);

    this.currentRound.phase = 'committed';
    await storage.saveConsensusRound(this.currentRound);

    this.emit('block:finalized', this.currentRound.proposedBlock);
    this.clearConsensusTimer();
    this.currentRound = null;
  }

  private async rejectBlock() {
    if (!this.currentRound) return;

    console.log(`[Consensus] Block ${this.currentRound.blockIndex} REJECTED`);

    this.currentRound.phase = 'committed'; // Mark as completed (rejected)
    await storage.saveConsensusRound(this.currentRound);

    this.emit('block:rejected', this.currentRound);
    this.clearConsensusTimer();
    this.currentRound = null;
  }

  private async handleBlockCommit(message: P2PMessage) {
    // Handle explicit commit messages
    console.log(`[Consensus] Received commit from ${message.from}`);
  }

  private async handleBlockFinalized(message: P2PMessage) {
    const { roundId, block } = message.payload as { 
      roundId: string; 
      block: ProposedBlock 
    };

    console.log(`[Consensus] Block ${block.index} finalized by network`);

    // Verify and store
    const isValid = await this.verifyProposedBlock(block);
    if (isValid) {
      await storage.saveBlock(block);
      await storage.setMetadata('lastCommittedIndex', block.index);
      this.emit('block:finalized', block);
    }

    if (this.currentRound?.roundId === roundId) {
      this.currentRound.phase = 'committed';
      await storage.saveConsensusRound(this.currentRound);
      this.clearConsensusTimer();
      this.currentRound = null;
    }
  }

  private handleConsensusState(message: P2PMessage) {
    // Sync consensus state with peers
    const state = message.payload as ConsensusRound;
    console.log(`[Consensus] Received state from ${message.from}:`, state.phase);
  }

  private startConsensusTimer(round: ConsensusRound) {
    this.clearConsensusTimer();
    this.consensusTimer = setTimeout(() => {
      if (this.currentRound?.roundId === round.roundId) {
        console.log(`[Consensus] Round ${round.roundId} timed out`);
        this.rejectBlock();
      }
    }, CONSENSUS_TIMEOUT);
  }

  private clearConsensusTimer() {
    if (this.consensusTimer) {
      clearTimeout(this.consensusTimer);
      this.consensusTimer = null;
    }
  }

  getCurrentRound(): ConsensusRound | null {
    return this.currentRound;
  }

  getPhase(): ConsensusPhase {
    return this.currentRound?.phase || 'idle';
  }
}
