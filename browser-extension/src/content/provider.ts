/**
 * RougeChain dApp Provider — injected as window.rougechain
 *
 * This is the provider API that dApps interact with.
 * Communication with the extension happens via window.postMessage,
 * relayed by the content script to the service worker.
 */

type EventCallback = (...args: unknown[]) => void;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

const PROVIDER_ID = "rougechain-provider";
let requestId = 0;
const pendingRequests = new Map<number, PendingRequest>();
const eventListeners = new Map<string, Set<EventCallback>>();

function sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        pendingRequests.set(id, { resolve, reject });
        window.postMessage({
            source: PROVIDER_ID,
            type: "rougechain-request",
            id,
            method,
            params,
        }, "*");

        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error(`RougeChain: request "${method}" timed out`));
            }
        }, 120_000);
    });
}

window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "rougechain-content-script") return;

    if (msg.type === "rougechain-response") {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
            pendingRequests.delete(msg.id);
            if (msg.error) {
                pending.reject(new Error(msg.error));
            } else {
                pending.resolve(msg.result);
            }
        }
    }

    if (msg.type === "rougechain-event") {
        const listeners = eventListeners.get(msg.event);
        if (listeners) {
            listeners.forEach(cb => {
                try { cb(msg.data); } catch { /* noop */ }
            });
        }
    }
});

const rougechain = {
    isRougeChain: true,

    async connect(): Promise<{ publicKey: string }> {
        return sendRequest("connect") as Promise<{ publicKey: string }>;
    },

    async getBalance(): Promise<{ balance: number; tokens: Record<string, number> }> {
        return sendRequest("getBalance") as Promise<{ balance: number; tokens: Record<string, number> }>;
    },

    async signTransaction(payload: Record<string, unknown>): Promise<{ signature: string; signedPayload: string }> {
        return sendRequest("signTransaction", { payload }) as Promise<{ signature: string; signedPayload: string }>;
    },

    async sendTransaction(payload: Record<string, unknown>): Promise<{ txId: string }> {
        return sendRequest("sendTransaction", { payload }) as Promise<{ txId: string }>;
    },

    on(event: string, callback: EventCallback): void {
        if (!eventListeners.has(event)) {
            eventListeners.set(event, new Set());
        }
        eventListeners.get(event)!.add(callback);
    },

    removeListener(event: string, callback: EventCallback): void {
        const listeners = eventListeners.get(event);
        if (listeners) {
            listeners.delete(callback);
        }
    },
};

// Authenticity token: only the real extension sets this non-enumerable Symbol.
// dApps can verify authenticity via: window.rougechain?.[Symbol.for("rougechain:authentic")]
const AUTHENTIC = Symbol.for("rougechain:authentic");
const frozenProvider = Object.freeze({ ...rougechain, [AUTHENTIC]: true });

// Unconditionally overwrite — prevents malicious pages from pre-defining a fake.
// If a prior (malicious) definition used configurable: false we catch the error
// and warn, but the extension still loads correctly in the content script context.
try {
    Object.defineProperty(window, "rougechain", {
        value: frozenProvider,
        writable: false,
        configurable: false,
    });
} catch (e) {
    // Property was already defined as non-configurable (likely by us on a prior inject).
    // Overwrite via direct assignment as a fallback.
    try { (window as any).rougechain = frozenProvider; } catch { /* already frozen */ }
    console.warn("[RougeChain] Could not inject provider — window.rougechain was already defined by another script or is non-configurable.", e);
}

window.dispatchEvent(new Event("rougechain#initialized"));
