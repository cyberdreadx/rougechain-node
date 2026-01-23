import { useState, useEffect, useCallback } from 'react';
import { getNode, getSyncStatus, type NodeIdentity, type PeerInfo, type NetworkStats, type SyncState, type NodeRole, type ChainSyncStatus } from '@/lib/p2p';

export function useP2PNode() {
  const [identity, setIdentity] = useState<NodeIdentity | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [networkStats, setNetworkStats] = useState<NetworkStats | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [chainSyncStatus, setChainSyncStatus] = useState<ChainSyncStatus | null>(null);
  const [consensusPhase, setConsensusPhase] = useState<string>('idle');
  const [logs, setLogs] = useState<Array<{ time: string; message: string; type: string }>>([]);

  const addLog = useCallback((message: string, type: string = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-50), { time, message, type }]);
  }, []);

  useEffect(() => {
    const node = getNode();
    
    const unsubscribe = node.onEvent((event, data) => {
      switch (event) {
        case 'node:initialized':
          setIdentity(data as NodeIdentity);
          addLog('Node initialized', 'success');
          break;
        case 'node:started':
          setIsRunning(true);
          addLog('Node started', 'success');
          break;
        case 'node:stopped':
          setIsRunning(false);
          addLog('Node stopped', 'warning');
          break;
        case 'peer:discovered':
          addLog(`Discovered peer: ${(data as PeerInfo).peerId}`, 'info');
          break;
        case 'peer:stateChange':
          const { peerId, state } = data as { peerId: string; state: string };
          addLog(`Peer ${peerId.slice(0, 12)}... ${state}`, state === 'connected' ? 'success' : 'warning');
          setPeers(node.getConnectedPeers());
          break;
        case 'signaling:connected':
          addLog('Connected to signaling server', 'success');
          break;
        case 'consensus:round:started':
          setConsensusPhase('proposing');
          addLog('Consensus round started', 'info');
          break;
        case 'consensus:vote:cast':
          addLog('Vote cast for block', 'info');
          break;
        case 'consensus:vote:received':
          addLog('Received vote from peer', 'info');
          break;
        case 'consensus:block:finalized':
          setConsensusPhase('idle');
          addLog('Block finalized by consensus!', 'success');
          break;
        case 'consensus:block:rejected':
          setConsensusPhase('idle');
          addLog('Block rejected by consensus', 'error');
          break;
        case 'sync:started':
          addLog('Chain sync started', 'info');
          break;
        case 'sync:supabase':
          const syncResult = data as { added: number; conflicts: number };
          if (syncResult.added > 0) {
            addLog(`Synced ${syncResult.added} blocks from network`, 'success');
          }
          break;
        case 'sync:progress':
          setSyncState(data as SyncState);
          break;
        case 'sync:completed':
          setSyncState(data as SyncState);
          addLog('Chain sync completed', 'success');
          break;
        case 'block:received':
          addLog(`New block received from network`, 'info');
          break;
      }
    });

    // Check if already initialized
    const existingIdentity = node.getIdentity();
    if (existingIdentity) {
      setIdentity(existingIdentity);
      setIsRunning(node.isNodeRunning());
    }

    return () => {
      unsubscribe();
    };
  }, [addLog]);

  useEffect(() => {
    if (!isRunning) return;

    const node = getNode();
    const interval = setInterval(async () => {
      setPeers(node.getConnectedPeers());
      setNetworkStats(await node.getNetworkStats());
      setSyncState(node.getSyncState());
      
      // Get chain sync status
      const status = await getSyncStatus();
      setChainSyncStatus(status);
    }, 2000);

    return () => clearInterval(interval);
  }, [isRunning]);

  const initializeNode = useCallback(async (role: NodeRole = 'full-node') => {
    setIsInitializing(true);
    try {
      const node = getNode();
      const id = await node.initialize(role);
      setIdentity(id);
    } catch (error) {
      addLog(`Failed to initialize: ${error}`, 'error');
    } finally {
      setIsInitializing(false);
    }
  }, [addLog]);

  const startNode = useCallback(async () => {
    try {
      const node = getNode();
      await node.start();
    } catch (error) {
      addLog(`Failed to start: ${error}`, 'error');
    }
  }, [addLog]);

  const stopNode = useCallback(async () => {
    try {
      const node = getNode();
      await node.stop();
    } catch (error) {
      addLog(`Failed to stop: ${error}`, 'error');
    }
  }, [addLog]);

  const proposeBlock = useCallback(async (data: string) => {
    try {
      const node = getNode();
      await node.proposeBlock(data);
      addLog('Block proposed, awaiting consensus...', 'info');
    } catch (error) {
      addLog(`Failed to propose block: ${error}`, 'error');
    }
  }, [addLog]);

  const resetNode = useCallback(async () => {
    try {
      const node = getNode();
      await node.resetNode();
      setIdentity(null);
      setPeers([]);
      setNetworkStats(null);
      setSyncState(null);
      setLogs([]);
      addLog('Node reset complete', 'info');
    } catch (error) {
      addLog(`Failed to reset: ${error}`, 'error');
    }
  }, [addLog]);

  return {
    identity,
    isRunning,
    isInitializing,
    peers,
    networkStats,
    syncState,
    chainSyncStatus,
    consensusPhase,
    logs,
    initializeNode,
    startNode,
    stopNode,
    proposeBlock,
    resetNode,
  };
}
