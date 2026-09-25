/**
 * Messenger real-time hints — one WebSocket per popup lifetime.
 *
 * The node broadcasts `{ type: "new_message", conversation_id, message_id, created_at }`
 * whenever an encrypted message is stored. It carries no content and no sender;
 * listeners just refetch the conversation. Polling stays as a slow safety net.
 */
import { getCoreApiBaseUrl } from "./network";

export interface NewMessageHint {
    type: "new_message";
    conversation_id: string;
    message_id: string;
    created_at: string;
}

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
        ws.onopen = () => { connected = true; attempts = 0; };
        ws.onmessage = (ev) => {
            try {
                const data = JSON.parse(String(ev.data)) as Partial<NewMessageHint>;
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

export function isMessengerWsConnected(): boolean {
    return connected;
}
