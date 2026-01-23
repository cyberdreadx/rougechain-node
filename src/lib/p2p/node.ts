// Main P2P Node Manager for RougeChain
// Orchestrates peer connections, consensus, and sync

import type { 
  NodeIdentity, 
  PeerInfo, 
  NetworkStats, 
  SyncState,
  P2PMessage,
  NodeRole,
  ProposedBlock
} from './types';
import { PeerConnectionManager } from './peer-connection';
import { ConsensusProtocol } from './consensus';
import * as storage from './storage';
import * as chainSync from './chain-sync';
import { supabase } from '@/integrations/supabase/client';

const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const SYNC_INTERVAL = 10000; // 10 seconds
const SUPABASE_SYNC_INTERVAL = 30000; // 30 seconds
const NODE_VERSION = '1.0.0';

type NodeEventHandler = (event: string, data: unknown) => void;

export class P2PNode {
  private identity: NodeIdentity | null = null;
  private peerManager: PeerConnectionManager | null = null;
  private consensus: ConsensusProtocol | null = null;
  private signalingChannel: ReturnType<typeof supabase.channel> | null = null;
  private eventHandlers: Set<NodeEventHandler> = new Set();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private supabaseSyncInterval: ReturnType<typeof setInterval> | null = null;
  private blockSubscription: (() => void) | null = null;
  private isRunning = false;
  private syncState: SyncState = {
    localHeight: -1,
    networkHeight: -1,
    isSyncing: false,
    syncProgress: 0,
    lastSyncAt: 0,
  };

  onEvent(handler: NodeEventHandler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: string, data: unknown) {
    this.eventHandlers.forEach(handler => handler(event, data));
  }

  async initialize(role: NodeRole = 'full-node'): Promise<NodeIdentity> {
    console.log('[Node] Initializing P2P node...');
    
    // Initialize storage
    await storage.initStorage();

    // Check for existing identity
    let identity = await storage.getIdentity();
    
    if (!identity) {
      // Generate new identity with PQC keypair
      const { data, error } = await supabase.functions.invoke('pqc-crypto', {
        body: { action: 'generate-keypair' },
      });

      if (error) throw new Error(`Failed to generate keypair: ${error.message}`);

      identity = {
        peerId: this.generatePeerId(),
        publicKey: data.keypair.publicKey,
        privateKey: data.keypair.privateKey,
        nodeRole: role,
        version: NODE_VERSION,
      };

      await storage.saveIdentity(identity);
    }

    this.identity = identity;
    
    // Initialize peer manager
    this.peerManager = new PeerConnectionManager(identity.peerId);
    this.setupPeerHandlers();

    // Initialize consensus
    this.consensus = new ConsensusProtocol(this.peerManager);
    await this.consensus.initialize(identity);
    this.setupConsensusHandlers();

    console.log(`[Node] Initialized with peer ID: ${identity.peerId}`);
    this.emit('node:initialized', identity);

    return identity;
  }

  private generatePeerId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'peer-';
    for (let i = 0; i < 16; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  private setupPeerHandlers() {
    if (!this.peerManager) return;

    this.peerManager.onStateChange((peerId, state) => {
      console.log(`[Node] Peer ${peerId} state: ${state}`);
      this.emit('peer:stateChange', { peerId, state });

      if (state === 'connected') {
        this.sendHeartbeat(peerId);
      }
    });

    this.peerManager.onMessage((message) => {
      if (message.type === 'HEARTBEAT') {
        this.handleHeartbeat(message);
      } else if (message.type === 'CHAIN_SYNC_REQUEST') {
        this.handleSyncRequest(message);
      } else if (message.type === 'CHAIN_SYNC_RESPONSE') {
        this.handleSyncResponse(message);
      }
    });
  }

  private setupConsensusHandlers() {
    if (!this.consensus) return;

    this.consensus.onEvent((event, data) => {
      this.emit(`consensus:${event}`, data);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!this.identity) {
      throw new Error('Node not initialized. Call initialize() first.');
    }

    console.log('[Node] Starting P2P node...');
    this.isRunning = true;

    // Initial sync from Supabase (get the canonical chain state)
    await this.syncFromSupabase();

    // Connect to signaling server (using Supabase Realtime)
    await this.connectSignaling();

    // Subscribe to real-time block updates from Supabase
    this.subscribeToBlockchain();

    // Start heartbeat
    this.startHeartbeat();

    // Start P2P sync
    this.startSync();

    // Start periodic Supabase sync
    this.startSupabaseSync();

    // Announce presence
    await this.announcePresence();

    this.emit('node:started', this.identity);
  }

  private async syncFromSupabase(): Promise<void> {
    console.log('[Node] Initial sync from Supabase...');
    this.syncState.isSyncing = true;
    this.emit('sync:started', this.syncState);

    try {
      const result = await chainSync.syncFromSupabase();
      console.log(`[Node] Supabase sync: ${result.added} blocks added`);
      
      this.syncState.localHeight = await storage.getChainHeight();
      this.syncState.lastSyncAt = Date.now();
      await storage.setMetadata('lastSyncTime', Date.now());
      
      this.emit('sync:supabase', { added: result.added, conflicts: result.conflicts });
    } catch (error) {
      console.error('[Node] Supabase sync error:', error);
    }

    this.syncState.isSyncing = false;
    this.emit('sync:completed', this.syncState);
  }

  private subscribeToBlockchain(): void {
    console.log('[Node] Subscribing to blockchain updates...');
    
    this.blockSubscription = chainSync.subscribeToBlockUpdates((block) => {
      console.log(`[Node] New block from Supabase: ${block.index}`);
      this.syncState.localHeight = block.index;
      this.emit('block:received', block);
      
      // Broadcast to P2P peers
      if (this.peerManager && this.identity) {
        const message: P2PMessage = {
          type: 'BLOCK_FINALIZED',
          from: this.identity.peerId,
          timestamp: Date.now(),
          signature: '',
          payload: { block },
        };
        this.peerManager.broadcast(message);
      }
    });
  }

  private startSupabaseSync(): void {
    this.supabaseSyncInterval = setInterval(async () => {
      const status = await chainSync.getSyncStatus();
      if (!status.isSynced) {
        await this.syncFromSupabase();
      }
    }, SUPABASE_SYNC_INTERVAL);
  }

  private async connectSignaling(): Promise<void> {
    console.log('[Node] Connecting to signaling server...');

    this.signalingChannel = supabase.channel('rougechain-signaling', {
      config: {
        broadcast: { self: false },
      },
    });

    this.signalingChannel
      .on('broadcast', { event: 'peer-announce' }, ({ payload }) => {
        this.handlePeerAnnounce(payload);
      })
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        this.handleSignal(payload);
      })
      .subscribe((status) => {
        console.log(`[Node] Signaling channel status: ${status}`);
        if (status === 'SUBSCRIBED') {
          this.emit('signaling:connected', null);
        }
      });

    // Setup WebRTC signaling handlers
    this.peerManager?.setSignalingHandlers({
      onIceCandidate: (peerId, candidate) => {
        this.sendSignal(peerId, 'ice-candidate', candidate);
      },
      onOffer: (peerId, offer) => {
        this.sendSignal(peerId, 'offer', offer);
      },
      onAnswer: (peerId, answer) => {
        this.sendSignal(peerId, 'answer', answer);
      },
    });
  }

  private async announcePresence(): Promise<void> {
    if (!this.signalingChannel || !this.identity) return;

    const chainHeight = await storage.getChainHeight();

    await this.signalingChannel.send({
      type: 'broadcast',
      event: 'peer-announce',
      payload: {
        peerId: this.identity.peerId,
        publicKey: this.identity.publicKey,
        nodeRole: this.identity.nodeRole,
        chainHeight,
        version: NODE_VERSION,
        timestamp: Date.now(),
      },
    });

    console.log('[Node] Announced presence to network');
  }

  private handlePeerAnnounce(payload: PeerInfo & { timestamp: number }) {
    if (!this.identity || payload.peerId === this.identity.peerId) return;

    console.log(`[Node] Discovered peer: ${payload.peerId}`);
    this.emit('peer:discovered', payload);

    // Initiate connection if we don't have one
    this.peerManager?.initiateConnection(payload.peerId);
    this.peerManager?.updatePeerInfo(payload.peerId, payload);
  }

  private sendSignal(peerId: string, type: string, data: unknown) {
    if (!this.signalingChannel || !this.identity) return;

    this.signalingChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: {
        from: this.identity.peerId,
        to: peerId,
        signalType: type,
        data,
      },
    });
  }

  private async handleSignal(payload: { 
    from: string; 
    to: string; 
    signalType: string; 
    data: unknown 
  }) {
    if (!this.identity || payload.to !== this.identity.peerId) return;

    console.log(`[Node] Received signal ${payload.signalType} from ${payload.from}`);

    switch (payload.signalType) {
      case 'offer':
        await this.peerManager?.handleOffer(payload.from, payload.data as RTCSessionDescriptionInit);
        break;
      case 'answer':
        await this.peerManager?.handleAnswer(payload.from, payload.data as RTCSessionDescriptionInit);
        break;
      case 'ice-candidate':
        await this.peerManager?.handleIceCandidate(payload.from, payload.data as RTCIceCandidateInit);
        break;
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.broadcastHeartbeat();
    }, HEARTBEAT_INTERVAL);
  }

  private async broadcastHeartbeat() {
    if (!this.identity || !this.peerManager) return;

    const chainHeight = await storage.getChainHeight();
    const message: P2PMessage = {
      type: 'HEARTBEAT',
      from: this.identity.peerId,
      timestamp: Date.now(),
      signature: '',
      payload: {
        chainHeight,
        nodeRole: this.identity.nodeRole,
        consensusPhase: this.consensus?.getPhase() || 'idle',
      },
    };

    this.peerManager.broadcast(message);
  }

  private sendHeartbeat(peerId: string) {
    if (!this.identity || !this.peerManager) return;

    storage.getChainHeight().then(chainHeight => {
      const message: P2PMessage = {
        type: 'HEARTBEAT',
        from: this.identity!.peerId,
        timestamp: Date.now(),
        signature: '',
        payload: {
          chainHeight,
          nodeRole: this.identity!.nodeRole,
        },
      };

      this.peerManager?.sendMessage(peerId, message);
    });
  }

  private handleHeartbeat(message: P2PMessage) {
    const payload = message.payload as { 
      chainHeight: number; 
      nodeRole: NodeRole 
    };

    this.peerManager?.updatePeerInfo(message.from, {
      chainHeight: payload.chainHeight,
      nodeRole: payload.nodeRole,
      lastSeen: message.timestamp,
    });

    // Update network height
    if (payload.chainHeight > this.syncState.networkHeight) {
      this.syncState.networkHeight = payload.chainHeight;
    }
  }

  private startSync() {
    this.syncInterval = setInterval(() => {
      this.checkSync();
    }, SYNC_INTERVAL);
  }

  private async checkSync() {
    const localHeight = await storage.getChainHeight();
    this.syncState.localHeight = localHeight;

    if (this.syncState.networkHeight > localHeight) {
      await this.requestSync();
    }
  }

  private async requestSync() {
    if (!this.identity || !this.peerManager || this.syncState.isSyncing) return;

    const peers = this.peerManager.getConnectedPeers();
    const peerWithHighestChain = peers.reduce((best, peer) => 
      peer.chainHeight > (best?.chainHeight || 0) ? peer : best
    , null as PeerInfo | null);

    if (!peerWithHighestChain) return;

    console.log(`[Node] Requesting sync from ${peerWithHighestChain.peerId}`);
    this.syncState.isSyncing = true;
    this.emit('sync:started', this.syncState);

    const message: P2PMessage = {
      type: 'CHAIN_SYNC_REQUEST',
      from: this.identity.peerId,
      to: peerWithHighestChain.peerId,
      timestamp: Date.now(),
      signature: '',
      payload: {
        fromIndex: this.syncState.localHeight + 1,
        toIndex: peerWithHighestChain.chainHeight,
      },
    };

    this.peerManager.sendMessage(peerWithHighestChain.peerId, message);
  }

  private async handleSyncRequest(message: P2PMessage) {
    if (!this.identity || !this.peerManager) return;

    const { fromIndex, toIndex } = message.payload as { 
      fromIndex: number; 
      toIndex: number 
    };

    console.log(`[Node] Sync request from ${message.from}: blocks ${fromIndex}-${toIndex}`);

    const chain = await storage.getAllBlocks();
    const blocks = chain.filter(b => b.index >= fromIndex && b.index <= toIndex);

    const response: P2PMessage = {
      type: 'CHAIN_SYNC_RESPONSE',
      from: this.identity.peerId,
      to: message.from,
      timestamp: Date.now(),
      signature: '',
      payload: { blocks },
    };

    this.peerManager.sendMessage(message.from, response);
  }

  private async handleSyncResponse(message: P2PMessage) {
    const { blocks } = message.payload as { blocks: ProposedBlock[] };

    console.log(`[Node] Received ${blocks.length} blocks from ${message.from}`);

    for (const block of blocks) {
      // Verify the block's PQC signature
      const isValid = await chainSync.verifyBlock(block);
      if (!isValid) {
        console.warn(`[Node] Invalid block signature at index ${block.index}`);
        continue;
      }

      // Store locally
      await storage.saveBlock(block);
      
      // Push to Supabase so all nodes see it
      await chainSync.pushToSupabase(block);
      
      this.syncState.syncProgress = (blocks.indexOf(block) + 1) / blocks.length;
      this.emit('sync:progress', this.syncState);
    }

    this.syncState.isSyncing = false;
    this.syncState.lastSyncAt = Date.now();
    this.syncState.localHeight = await storage.getChainHeight();
    this.emit('sync:completed', this.syncState);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    console.log('[Node] Stopping P2P node...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    if (this.supabaseSyncInterval) {
      clearInterval(this.supabaseSyncInterval);
      this.supabaseSyncInterval = null;
    }

    if (this.blockSubscription) {
      this.blockSubscription();
      this.blockSubscription = null;
    }

    if (this.signalingChannel) {
      await this.signalingChannel.unsubscribe();
      this.signalingChannel = null;
    }

    this.peerManager?.disconnectAll();
    this.isRunning = false;

    this.emit('node:stopped', null);
  }

  async proposeBlock(data: string): Promise<void> {
    if (!this.consensus) {
      throw new Error('Consensus not initialized');
    }

    await this.consensus.proposeBlock(data);
  }

  getIdentity(): NodeIdentity | null {
    return this.identity;
  }

  getConnectedPeers(): PeerInfo[] {
    return this.peerManager?.getConnectedPeers() || [];
  }

  getSyncState(): SyncState {
    return { ...this.syncState };
  }

  async getNetworkStats(): Promise<NetworkStats> {
    const peers = this.peerManager?.getConnectedPeers() || [];
    const chain = await storage.getAllBlocks();
    
    let averageBlockTime = 0;
    if (chain.length > 1) {
      const times = chain.slice(1).map((b, i) => b.timestamp - chain[i].timestamp);
      averageBlockTime = times.reduce((a, b) => a + b, 0) / times.length;
    }

    const validators = peers.filter(p => p.nodeRole === 'validator').length;

    return {
      totalPeers: this.peerManager?.getPeerCount() || 0,
      connectedPeers: this.peerManager?.getConnectedCount() || 0,
      activeValidators: validators + (this.identity?.nodeRole === 'validator' ? 1 : 0),
      networkHeight: Math.max(this.syncState.networkHeight, chain.length - 1),
      consensusRound: this.consensus?.getCurrentRound()?.blockIndex || 0,
      averageBlockTime: Math.round(averageBlockTime),
      hashRate: 0, // Would need mining stats
    };
  }

  isNodeRunning(): boolean {
    return this.isRunning;
  }

  async resetNode(): Promise<void> {
    await this.stop();
    await storage.clearAllData();
    this.identity = null;
    this.emit('node:reset', null);
  }
}

// Singleton instance
let nodeInstance: P2PNode | null = null;

export function getNode(): P2PNode {
  if (!nodeInstance) {
    nodeInstance = new P2PNode();
  }
  return nodeInstance;
}

export function resetNode(): void {
  nodeInstance = null;
}
