/**
 * Messenger real-time events — one WebSocket per popup lifetime.
 *
 * `new_message` events are PRIVATE: the node only sends them to a socket that
 * authenticated with `{ auth: <signed request, payload.action =
 * "messenger_ws_subscribe"> }` for a participant's signing key. They carry routing
 * metadata only (conversation/message ids, sender + participant signing keys),
 * never content. The signed request has a single-use nonce, so it is re-signed on
 * every (re)connect. Polling stays as a safety net.
 */
import { getCoreApiBaseUrl } from "./network";

export interface NewMessageHint {
    type: "new_message";
    conversation_id: string;
    message_id: string;
    created_at: string;
    sender_wallet_id: string;
    participant_ids: string[];
}

/** Returns a fresh signed request, e.g. buildSignedRequest({action:"messenger_ws_subscribe"}, priv, pub). */
export type AuthSigner = () => unknown | null;
let authSigner: AuthSigner | null = null;

type Listener = (hint: NewMessageHint) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let connected = false;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string | null {
    const base = getCoreApiBaseUrl();
    if (!base) return null;
    return base.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/api\/?$/, "/api/ws");
}

function open(): void {
    if (socket || listeners.size === 0) return;
    const url = wsUrl();
    if (!url) return;
    try {
        const ws = new WebSocket(url);
        socket = ws;
        ws.onopen = () => { attempts = 0; sendAuth(); };
        ws.onmessage = (ev) => {
            try {
                const data = JSON.parse(String(ev.data)) as Partial<NewMessageHint> & { topics?: string[]; error?: string };
                if ((data?.type as string) === "subscribed" && data.topics?.includes("messenger")) {
                    connected = true;
                    return;
                }
                if ((data?.type as string) === "auth_error") {
                    console.warn("[messenger-ws] auth rejected:", data.error);
                    return;
                }
                if (data?.type === "new_message" && typeof data.conversation_id === "string") {
                    for (const l of listeners) {
                        try { l(data as NewMessageHint); } catch { /* keep the socket alive */ }
                    }
                }
            } catch { /* ignore non-JSON (pong etc.) */ }
        };
        ws.onclose = () => {
            connected = false;
            socket = null;
            if (listeners.size === 0) return;
            const delay = Math.min(1000 * 2 ** attempts, 30000);
            attempts++;
            reconnectTimer = setTimeout(open, delay);
        };
        ws.onerror = () => { /* onclose follows */ };
    } catch {
        socket = null;
    }
}

function sendAuth(): void {
    if (!authSigner || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
        const signed = authSigner();
        if (signed) socket.send(JSON.stringify({ auth: signed }));
    } catch (e) {
        console.warn("[messenger-ws] auth signing failed", e);
    }
}

/** Set the identity this socket authenticates as (re-sent on every reconnect). */
export function setMessengerAuthSigner(signer: AuthSigner | null): void {
    authSigner = signer;
    connected = false;
    sendAuth();
}

function closeIfIdle(): void {
    if (listeners.size > 0) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
    connected = false;
}

/** Subscribe to new_message hints; the socket opens on first subscriber and closes on last. */
export function subscribeNewMessage(listener: Listener): () => void {
    listeners.add(listener);
    open();
    return () => { listeners.delete(listener); closeIfIdle(); };
}

/** True once the node accepted the signed subscription on the current socket. */
export function isMessengerWsConnected(): boolean {
    return connected;
}
