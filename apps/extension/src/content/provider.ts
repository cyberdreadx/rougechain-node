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

    /**
     * Sign a payload after the user approves it. `signedPayload` is the exact JSON that was
     * signed and `payload` the object it encodes; submit `{ payload, signature, public_key }`.
     * For `contract_call` / `contract_deploy`, missing `from` / `timestamp` / `nonce` are filled in.
     */
    async signTransaction(payload: Record<string, unknown>): Promise<{
        signature: string; signedPayload: string; publicKey: string; payload: Record<string, unknown>;
    }> {
        return sendRequest("signTransaction", { payload }) as Promise<{
            signature: string; signedPayload: string; publicKey: string; payload: Record<string, unknown>;
        }>;
    },

    /**
     * Sign and submit. A transfer by default; `type: "contract_call"` goes to
     * /v2/contract/execute and `type: "contract_deploy"` to /v2/contract/publish.
     */
    async sendTransaction(payload: Record<string, unknown>): Promise<{ txId: string; fee?: number; address?: string; preview?: unknown }> {
        return sendRequest("sendTransaction", { payload }) as Promise<{ txId: string; fee?: number; address?: string; preview?: unknown }>;
    },

    /**
     * Sign a text message to prove control of the wallet (login, token gating). Never a
     * transaction: the signature is over
     * `"\x19RougeChain Signed Message:\n" + decimal(byte length) + "\n" + UTF-8(message)`,
     * which the node can never accept as a transaction. The site must be connected, the user
     * approves every request, the message is at most 4,096 bytes, and a message that looks like a
     * transaction payload is refused (use `signTransaction`). Verify with `verifyMessage` /
     * `verifySignIn` from `@rougechain/sdk`. Since 1.8.0 — feature-detect with
     * `typeof window.rougechain.signMessage === "function"`.
     */
    async signMessage(params: { message: string }): Promise<{ signature: string; publicKey: string; address: string }> {
        return sendRequest("signMessage", { message: params?.message }) as Promise<{
            signature: string; publicKey: string; address: string;
        }>;
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

// Module scope (no runtime exports): keeps this script's top-level consts out of the global
// type scope it would otherwise share with the other content scripts under tsc.
export {};
