/**
 * Real-time messenger events, as apps/web's hooks/use-blockchain-ws.ts does it: the node only
 * sends `new_message` (routing metadata, never content) to a socket that authenticated with
 * `{ auth: <signed request, payload.action = "messenger_ws_subscribe"> }` for a participant's
 * signing key. Nonces are single-use, so the auth is re-signed on every (re)connect.
 *
 * One socket per page, owned by the Messenger page (useMessengerSocket); an open chat listens via
 * subscribeNewMessage without opening a second socket.
 */
import { useEffect, useState } from "react";
import { getCoreApiBaseUrl } from "@rougechain/core/network";
import { buildSignedRequest, type WalletWithPrivateKeys } from "@rougechain/core/pqc-messenger";

export interface WsNewMessageEvent {
  type: "new_message";
  conversation_id: string;
  message_id: string;
  created_at: string;
  sender_wallet_id: string;
  participant_ids: string[];
}

type Listener = (e: WsNewMessageEvent) => void;
const listeners = new Set<Listener>();
let live = false;

export function subscribeNewMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True once the node confirmed the private messenger subscription. */
export function isMessengerLive(): boolean {
  return live;
}

/** ws(s)://…/api/ws for the active network's API base (same mapping as apps/web). */
export function messengerWsUrl(apiBase = getCoreApiBaseUrl()): string | null {
  if (!apiBase) return null;
  return apiBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/api$/, "/api/ws");
}

/** The auth frame apps/web sends: `{ auth: buildSignedRequest({action:"messenger_ws_subscribe"}) }`. */
export function messengerAuthFrame(identity: Pick<WalletWithPrivateKeys, "signingPrivateKey" | "signingPublicKey">): string {
  return JSON.stringify({
    auth: buildSignedRequest({ action: "messenger_ws_subscribe" }, identity.signingPrivateKey, identity.signingPublicKey),
  });
}

/**
 * Open (and keep reconnecting) the messenger socket for `identity`. Returns whether private
 * events are flowing; `onNewMessage` fires for every `new_message`. `networkKey` re-opens the
 * socket when the active network changes.
 */
export function useMessengerSocket(
  identity: WalletWithPrivateKeys | null,
  networkKey: string,
  onNewMessage: (e: WsNewMessageEvent) => void,
): boolean {
  const [isLive, setLive] = useState(false);
  const signingPrivateKey = identity?.signingPrivateKey ?? "";
  const signingPublicKey = identity?.signingPublicKey ?? "";

  useEffect(() => subscribeNewMessage(onNewMessage), [onNewMessage]);

  useEffect(() => {
    if (!signingPrivateKey || !signingPublicKey || typeof WebSocket === "undefined") return;
    const url = messengerWsUrl();
    if (!url) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let attempts = 0;
    let timer: number | null = null;
    const setState = (v: boolean) => {
      live = v;
      setLive(v);
    };
    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }
      ws.onopen = () => {
        attempts = 0;
        try {
          ws?.send(messengerAuthFrame({ signingPrivateKey, signingPublicKey }));
        } catch {
          /* signing failed: stay on polling */
        }
      };
      ws.onmessage = (event) => {
        let data: { type?: string; topics?: string[]; conversation_id?: unknown };
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === "subscribed") {
          if (data.topics?.includes("messenger")) setState(true);
          return;
        }
        if (data.type === "new_message" && typeof data.conversation_id === "string") {
          for (const l of listeners) {
            try {
              l(data as unknown as WsNewMessageEvent);
            } catch {
              /* a listener error must not kill the socket */
            }
          }
        }
      };
      ws.onclose = () => {
        setState(false);
        ws = null;
        if (closed) return;
        const delay = Math.min(1000 * 2 ** attempts, 30_000);
        attempts++;
        timer = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      setState(false);
    };
  }, [signingPrivateKey, signingPublicKey, networkKey]);

  return isLive;
}
