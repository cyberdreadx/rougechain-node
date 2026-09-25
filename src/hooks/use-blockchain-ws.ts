import { useEffect, useRef, useState, useCallback } from "react";
import { getCoreApiBaseUrl } from "@/lib/network";

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

/** Private messenger event (only sent to an authenticated participant's socket):
 *  a new encrypted message was stored. Routing metadata only, never content. */
export interface WsNewMessageEvent {
  type: "new_message";
  conversation_id: string;
  message_id: string;
  created_at: string;
  /** Sender's signing public key. */
  sender_wallet_id: string;
  /** Participants' signing public keys. */
  participant_ids: string[];
}

export type WsEvent = WsNewBlockEvent | WsNewTransactionEvent | WsStatsEvent | WsNewMessageEvent;

// Module-level fan-out so components that don't own the socket (e.g. an open chat)
// can react to new_message events without opening a second WebSocket.
type NewMessageListener = (event: WsNewMessageEvent) => void;
const newMessageListeners = new Set<NewMessageListener>();
export function subscribeNewMessage(listener: NewMessageListener): () => void {
  newMessageListeners.add(listener);
  return () => { newMessageListeners.delete(listener); };
}

/**
 * Messenger events are PRIVATE: the node only delivers `new_message` to sockets
 * that sent `{ auth: <signed request, payload.action = "messenger_ws_subscribe"> }`
 * for a participant's signing key. Nonces are single-use, so the signer is called
 * again on every (re)connect.
 */
export type MessengerAuthSigner = () => unknown | null;
let messengerAuthSigner: MessengerAuthSigner | null = null;
let messengerLive = false;
const openSockets = new Set<WebSocket>();

function sendMessengerAuth(ws: WebSocket) {
  if (!messengerAuthSigner || ws.readyState !== WebSocket.OPEN) return;
  try {
    const signed = messengerAuthSigner();
    if (signed) ws.send(JSON.stringify({ auth: signed }));
  } catch (e) {
    console.warn("[ws] messenger auth signing failed", e);
  }
}

export function setMessengerAuthSigner(signer: MessengerAuthSigner | null): void {
  messengerAuthSigner = signer;
  messengerLive = false;
  for (const ws of openSockets) sendMessengerAuth(ws);
}

/** True once the node confirmed the private messenger subscription. */
export function isMessengerLive(): boolean {
  return messengerLive;
}

interface UseBlockchainWsOptions {
  onNewBlock?: (event: WsNewBlockEvent) => void;
  onNewTransaction?: (event: WsNewTransactionEvent) => void;
  onStats?: (event: WsStatsEvent) => void;
  onNewMessage?: (event: WsNewMessageEvent) => void;
  fallbackPollInterval?: number;
}

interface UseBlockchainWsReturn {
  isConnected: boolean;
  /** Private messenger events are flowing (socket up AND signed subscription accepted). */
  messengerLive: boolean;
  lastBlockHeight: number;
  connectionType: "websocket" | "polling" | "disconnected";
  reconnect: () => void;
}

export function useBlockchainWs(options: UseBlockchainWsOptions = {}): UseBlockchainWsReturn {
  const { fallbackPollInterval = 5000 } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [connectionType, setConnectionType] = useState<"websocket" | "polling" | "disconnected">("disconnected");
  const [lastBlockHeight, setLastBlockHeight] = useState(0);
  const [messengerLiveState, setMessengerLiveState] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const lastHeightRef = useRef(0);

  // Store callbacks in refs to avoid re-creating connect on every render
  const onNewBlockRef = useRef(options.onNewBlock);
  const onNewTransactionRef = useRef(options.onNewTransaction);
  const onStatsRef = useRef(options.onStats);
  const onNewMessageRef = useRef(options.onNewMessage);
  onNewBlockRef.current = options.onNewBlock;
  onNewTransactionRef.current = options.onNewTransaction;
  onStatsRef.current = options.onStats;
  onNewMessageRef.current = options.onNewMessage;

  const getWsUrl = useCallback(() => {
    const apiBase = getCoreApiBaseUrl();
    if (!apiBase) return null;
    return apiBase
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")
      .replace(/\/api$/, "/api/ws");
  }, []);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return;

    console.log("[ws] Starting fallback polling");
    setConnectionType("polling");

    const poll = async () => {
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) return;
        const res = await fetch(`${apiBase}/stats`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const data = await res.json();
        const height = data.network_height ?? data.networkHeight ?? 0;

        if (height > lastHeightRef.current) {
          lastHeightRef.current = height;
          setLastBlockHeight(height);
          onNewBlockRef.current?.({
            type: "new_block",
            height,
            hash: "",
            tx_count: 0,
            timestamp: Date.now(),
          });
        }

        onStatsRef.current?.({
          type: "stats",
          block_height: height,
          peer_count: data.connected_peers ?? 0,
          mempool_size: 0,
        });

        setIsConnected(true);
        setConnectionType("polling");
      } catch {
        // silent
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, fallbackPollInterval);
  }, [fallbackPollInterval]);

  const connect = useCallback(() => {
    const wsUrl = getWsUrl();
    if (!wsUrl) {
      startPolling();
      return;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      console.log("[ws] Connecting to", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[ws] Connected");
        openSockets.add(ws);
        sendMessengerAuth(ws);
        setIsConnected(true);
        setConnectionType("websocket");
        reconnectAttempts.current = 0;
        stopPolling();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsEvent | { type: "subscribed"; topics?: string[] } | { type: "auth_error"; error?: string };
          if (data.type === "subscribed") {
            if (data.topics?.includes("messenger")) { messengerLive = true; setMessengerLiveState(true); }
            return;
          }
          if (data.type === "auth_error") {
            console.warn("[ws] messenger auth rejected:", data.error);
            return;
          }
          switch (data.type) {
            case "new_block":
              lastHeightRef.current = data.height;
              setLastBlockHeight(data.height);
              onNewBlockRef.current?.(data);
              break;
            case "new_transaction":
              onNewTransactionRef.current?.(data);
              break;
            case "stats":
              lastHeightRef.current = data.block_height;
              setLastBlockHeight(data.block_height);
              onStatsRef.current?.(data);
              break;
            case "new_message":
              onNewMessageRef.current?.(data);
              for (const l of newMessageListeners) {
                try { l(data); } catch { /* listener error must not kill the socket */ }
              }
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = (error) => {
        console.warn("[ws] Error:", error);
      };

      ws.onclose = (event) => {
        console.log("[ws] Disconnected:", event.code, event.reason);
        openSockets.delete(ws);
        messengerLive = false;
        setMessengerLiveState(false);
        setIsConnected(false);
        wsRef.current = null;

        startPolling();

        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;

        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[ws] Attempting reconnect...");
          connect();
        }, delay);
      };
    } catch (error) {
      console.error("[ws] Failed to connect:", error);
      startPolling();
    }
  }, [getWsUrl, startPolling, stopPolling]);

  const reconnect = useCallback(() => {
    reconnectAttempts.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    connect();
  }, [connect]);

  // Single stable effect — connect once on mount, cleanup on unmount
  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      stopPolling();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { isConnected, messengerLive: messengerLiveState, lastBlockHeight, connectionType, reconnect };
}
