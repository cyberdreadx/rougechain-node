import { useEffect, useRef, useState, useCallback } from "react";
import { getCoreApiBaseUrl } from "@/lib/network";

// WebSocket event types from the daemon
export interface WsNewBlockEvent {
  type: "new_block";
  height: number;
  hash: string;
  tx_count: number;
  timestamp: number;
}

export interface WsNewTransactionEvent {
  type: "new_transaction";
  tx_hash: string;
  tx_type: string;
  from: string;
  to: string | null;
  amount: number | null;
}

export interface WsStatsEvent {
  type: "stats";
  block_height: number;
  peer_count: number;
  mempool_size: number;
}

export type WsEvent = WsNewBlockEvent | WsNewTransactionEvent | WsStatsEvent;

interface UseBlockchainWsOptions {
  onNewBlock?: (event: WsNewBlockEvent) => void;
  onNewTransaction?: (event: WsNewTransactionEvent) => void;
  onStats?: (event: WsStatsEvent) => void;
  fallbackPollInterval?: number; // ms, default 5000
}

interface UseBlockchainWsReturn {
  isConnected: boolean;
  lastBlockHeight: number;
  connectionType: "websocket" | "polling" | "disconnected";
  reconnect: () => void;
}

export function useBlockchainWs(options: UseBlockchainWsOptions = {}): UseBlockchainWsReturn {
  const {
    onNewBlock,
    onNewTransaction,
    onStats,
    fallbackPollInterval = 5000,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [connectionType, setConnectionType] = useState<"websocket" | "polling" | "disconnected">("disconnected");
  const [lastBlockHeight, setLastBlockHeight] = useState(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);

  // Build WebSocket URL from API base
  const getWsUrl = useCallback(() => {
    const apiBase = getCoreApiBaseUrl();
    if (!apiBase) return null;
    
    // Convert http(s) to ws(s)
    const wsUrl = apiBase
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")
      .replace(/\/api$/, "/api/ws");
    
    return wsUrl;
  }, []);

  // Fallback polling function
  const pollStats = useCallback(async () => {
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) return;
      
      const res = await fetch(`${apiBase}/stats`, {
        signal: AbortSignal.timeout(3000),
      });
      
      if (res.ok) {
        const data = await res.json();
        const height = data.network_height ?? data.networkHeight ?? 0;
        
        // Trigger callback if height changed
        if (height > lastBlockHeight) {
          setLastBlockHeight(height);
          onNewBlock?.({
            type: "new_block",
            height,
            hash: "",
            tx_count: 0,
            timestamp: Date.now(),
          });
        }
        
        onStats?.({
          type: "stats",
          block_height: height,
          peer_count: data.connected_peers ?? data.connectedPeers ?? 0,
          mempool_size: 0,
        });
        
        setIsConnected(true);
        setConnectionType("polling");
      }
    } catch {
      // Silent fail
    }
  }, [lastBlockHeight, onNewBlock, onStats]);

  // Start fallback polling
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return;
    
    console.log("[ws] Starting fallback polling");
    setConnectionType("polling");
    pollStats();
    pollIntervalRef.current = setInterval(pollStats, fallbackPollInterval);
  }, [pollStats, fallbackPollInterval]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    const wsUrl = getWsUrl();
    if (!wsUrl) {
      startPolling();
      return;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      console.log("[ws] Connecting to", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[ws] Connected");
        setIsConnected(true);
        setConnectionType("websocket");
        reconnectAttempts.current = 0;
        stopPolling();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsEvent;
          
          switch (data.type) {
            case "new_block":
              setLastBlockHeight(data.height);
              onNewBlock?.(data);
              break;
            case "new_transaction":
              onNewTransaction?.(data);
              break;
            case "stats":
              setLastBlockHeight(data.block_height);
              onStats?.(data);
              break;
          }
        } catch (e) {
          console.error("[ws] Failed to parse message:", e);
        }
      };

      ws.onerror = (error) => {
        console.warn("[ws] Error:", error);
      };

      ws.onclose = (event) => {
        console.log("[ws] Disconnected:", event.code, event.reason);
        setIsConnected(false);
        wsRef.current = null;

        // Exponential backoff for reconnection
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;

        // Start polling as fallback
        startPolling();

        // Try to reconnect
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[ws] Attempting reconnect...");
          connect();
        }, delay);
      };
    } catch (error) {
      console.error("[ws] Failed to connect:", error);
      startPolling();
    }
  }, [getWsUrl, onNewBlock, onNewTransaction, onStats, startPolling, stopPolling]);

  // Manual reconnect
  const reconnect = useCallback(() => {
    reconnectAttempts.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    connect();
  }, [connect]);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      stopPolling();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect, stopPolling]);

  return {
    isConnected,
    lastBlockHeight,
    connectionType,
    reconnect,
  };
}
