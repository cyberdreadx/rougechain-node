// IndexedDB storage for local blockchain state
// Each node maintains its own copy of the chain

import type { LocalBlockchainState, ProposedBlock, ConsensusRound, NodeIdentity } from './types';

const DB_NAME = 'rougechain-node';
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

export async function initStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    
    request.onsuccess = () => {
      db = request.result;
      resolve();
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      
      // Store for blockchain blocks
      if (!database.objectStoreNames.contains('blocks')) {
        const blocksStore = database.createObjectStore('blocks', { keyPath: 'index' });
        blocksStore.createIndex('hash', 'hash', { unique: true });
      }

      // Store for pending consensus rounds
      if (!database.objectStoreNames.contains('consensus_rounds')) {
        database.createObjectStore('consensus_rounds', { keyPath: 'roundId' });
      }

      // Store for node identity
      if (!database.objectStoreNames.contains('identity')) {
        database.createObjectStore('identity', { keyPath: 'peerId' });
      }

      // Store for known peers
      if (!database.objectStoreNames.contains('peers')) {
        database.createObjectStore('peers', { keyPath: 'peerId' });
      }

      // Store for metadata
      if (!database.objectStoreNames.contains('metadata')) {
        database.createObjectStore('metadata', { keyPath: 'key' });
      }
    };
  });
}

function getDb(): IDBDatabase {
  if (!db) throw new Error('Database not initialized. Call initStorage() first.');
  return db;
}

// Block operations
export async function saveBlock(block: ProposedBlock): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('blocks', 'readwrite');
    const store = tx.objectStore('blocks');
    const request = store.put(block);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function getBlock(index: number): Promise<ProposedBlock | null> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('blocks', 'readonly');
    const store = tx.objectStore('blocks');
    const request = store.get(index);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

export async function getBlockByHash(hash: string): Promise<ProposedBlock | null> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('blocks', 'readonly');
    const store = tx.objectStore('blocks');
    const index = store.index('hash');
    const request = index.get(hash);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

export async function getAllBlocks(): Promise<ProposedBlock[]> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('blocks', 'readonly');
    const store = tx.objectStore('blocks');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const blocks = request.result || [];
      blocks.sort((a, b) => a.index - b.index);
      resolve(blocks);
    };
  });
}

export async function getChainHeight(): Promise<number> {
  const blocks = await getAllBlocks();
  return blocks.length > 0 ? blocks[blocks.length - 1].index : -1;
}

export async function clearBlocks(): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('blocks', 'readwrite');
    const store = tx.objectStore('blocks');
    const request = store.clear();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Node identity operations
export async function saveIdentity(identity: NodeIdentity): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('identity', 'readwrite');
    const store = tx.objectStore('identity');
    const request = store.put(identity);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function getIdentity(): Promise<NodeIdentity | null> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('identity', 'readonly');
    const store = tx.objectStore('identity');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result?.[0] || null);
  });
}

export async function clearIdentity(): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('identity', 'readwrite');
    const store = tx.objectStore('identity');
    const request = store.clear();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Consensus round operations
export async function saveConsensusRound(round: ConsensusRound): Promise<void> {
  const serializable = {
    ...round,
    votes: Object.fromEntries(round.votes),
  };
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('consensus_rounds', 'readwrite');
    const store = tx.objectStore('consensus_rounds');
    const request = store.put(serializable);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function getConsensusRound(roundId: string): Promise<ConsensusRound | null> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('consensus_rounds', 'readonly');
    const store = tx.objectStore('consensus_rounds');
    const request = store.get(roundId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (!request.result) {
        resolve(null);
        return;
      }
      const round = {
        ...request.result,
        votes: new Map(Object.entries(request.result.votes)),
      };
      resolve(round);
    };
  });
}

export async function getActiveConsensusRounds(): Promise<ConsensusRound[]> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('consensus_rounds', 'readonly');
    const store = tx.objectStore('consensus_rounds');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const rounds = (request.result || [])
        .map((r: { votes: Record<string, boolean> } & Omit<ConsensusRound, 'votes'>) => ({
          ...r,
          votes: new Map(Object.entries(r.votes)),
        }))
        .filter((r: ConsensusRound) => r.phase !== 'committed');
      resolve(rounds);
    };
  });
}

// Metadata operations
export async function setMetadata(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('metadata', 'readwrite');
    const store = tx.objectStore('metadata');
    const request = store.put({ key, value });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function getMetadata<T>(key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction('metadata', 'readonly');
    const store = tx.objectStore('metadata');
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result?.value ?? null);
  });
}

// Get full local state
export async function getLocalState(): Promise<LocalBlockchainState> {
  const chain = await getAllBlocks();
  const consensusRounds = await getActiveConsensusRounds();
  const lastCommittedIndex = await getMetadata<number>('lastCommittedIndex') ?? -1;
  
  return {
    chain,
    pendingBlocks: [],
    consensusRounds,
    lastCommittedIndex,
  };
}

// Clear all data (for resetting node)
export async function clearAllData(): Promise<void> {
  const stores = ['blocks', 'consensus_rounds', 'identity', 'peers', 'metadata'];
  
  for (const storeName of stores) {
    await new Promise<void>((resolve, reject) => {
      const tx = getDb().transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}
