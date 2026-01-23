// P2P Network Types for RougeChain Distributed Consensus

export type NodeRole = 'validator' | 'full-node' | 'light-client';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';
export type ConsensusPhase = 'idle' | 'proposing' | 'voting' | 'finalizing' | 'committed';

export interface PeerInfo {
  peerId: string;
  publicKey: string;
  nodeRole: NodeRole;
  connectionState: ConnectionState;
  latency: number;
  lastSeen: number;
  chainHeight: number;
  version: string;
}

export interface NodeIdentity {
  peerId: string;
  publicKey: string;
  privateKey: string;
  nodeRole: NodeRole;
  version: string;
}

export interface P2PMessage {
  type: MessageType;
  from: string;
  to?: string; // undefined = broadcast
  timestamp: number;
  signature: string;
  payload: unknown;
}

export type MessageType = 
  | 'PEER_ANNOUNCE'
  | 'PEER_REQUEST'
  | 'PEER_RESPONSE'
  | 'CHAIN_SYNC_REQUEST'
  | 'CHAIN_SYNC_RESPONSE'
  | 'BLOCK_PROPOSE'
  | 'BLOCK_VOTE'
  | 'BLOCK_COMMIT'
  | 'BLOCK_FINALIZED'
  | 'CONSENSUS_STATE'
  | 'HEARTBEAT'
  | 'VALIDATOR_ANNOUNCE';

export interface ConsensusRound {
  roundId: string;
  blockIndex: number;
  proposerId: string;
  proposedBlock: ProposedBlock;
  phase: ConsensusPhase;
  votes: Map<string, boolean>;
  startedAt: number;
  expiresAt: number;
}

export interface ProposedBlock {
  index: number;
  timestamp: number;
  data: string;
  previousHash: string;
  hash: string;
  nonce: number;
  proposerSignature: string;
  proposerPublicKey: string;
}

export interface BlockVote {
  roundId: string;
  voterId: string;
  voterPublicKey: string;
  approve: boolean;
  signature: string;
  timestamp: number;
}

export interface SyncState {
  localHeight: number;
  networkHeight: number;
  isSyncing: boolean;
  syncProgress: number;
  lastSyncAt: number;
}

export interface NetworkStats {
  totalPeers: number;
  connectedPeers: number;
  activeValidators: number;
  networkHeight: number;
  consensusRound: number;
  averageBlockTime: number;
  hashRate: number;
}

export interface LocalBlockchainState {
  chain: ProposedBlock[];
  pendingBlocks: ProposedBlock[];
  consensusRounds: ConsensusRound[];
  lastCommittedIndex: number;
}

// Events emitted by P2P network
export interface P2PEvents {
  'peer:connected': PeerInfo;
  'peer:disconnected': PeerInfo;
  'block:proposed': ProposedBlock;
  'block:voted': BlockVote;
  'block:finalized': ProposedBlock;
  'consensus:started': ConsensusRound;
  'consensus:completed': ConsensusRound;
  'sync:started': SyncState;
  'sync:completed': SyncState;
  'network:stats': NetworkStats;
}
