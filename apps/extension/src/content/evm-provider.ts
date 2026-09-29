/**
 * EVM (Base) dApp provider — injected as window.ethereum (MetaMask-compatible).
 *
 * This lets the RougeChain wallet stand in for MetaMask on the rougechain.io ↔ Base
 * bridge: the bridge page calls window.ethereum.request({ method: ... }) and those
 * calls are relayed — over a bus DEDICATED to EVM, separate from window.rougechain —
 * to the extension service worker, which holds the secp256k1 key and gates signing
 * behind user approval.
 *
 * Coexistence: if another wallet already defined window.ethereum (e.g. MetaMask),
 * we do NOT clobber it — we still announce ourselves via EIP-6963 so dApps that
 * support provider discovery can pick RougeChain.
 */

type EventCallback = (...args: unknown[]) => void;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

const OUTBOUND = "rougechain-evm-provider";
const INBOUND = "rougechain-evm-content";
const DEFAULT_CHAIN_ID = "0x2105"; // Base mainnet

let requestId = 0;
const pending = new Map<number, PendingRequest>();
const listeners = new Map<string, Set<EventCallback>>();

let cachedChainId: string = DEFAULT_CHAIN_ID;
let cachedAccounts: string[] = [];

interface RpcError extends Error {
    code: number;
    data?: unknown;
}
function rpcError(code: number, message: string): RpcError {
    const e = new Error(message) as RpcError;
    e.code = code;
    return e;
}

function relay(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });
        window.postMessage({ source: OUTBOUND, type: "evm-request", id, method, params }, "*");
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(rpcError(4001, `RougeChain: request "${method}" timed out`));
            }
        }, 180_000);
    });
}

function emit(event: string, data: unknown) {
    const set = listeners.get(event);
    if (set) set.forEach((cb) => { try { cb(data); } catch { /* noop */ } });
}

window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== INBOUND) return;

    if (msg.type === "evm-response") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) {
            p.reject(rpcError(typeof msg.error.code === "number" ? msg.error.code : 4001, msg.error.message || "Request rejected"));
        } else {
            p.resolve(msg.result);
        }
    }

    if (msg.type === "evm-event") {
        if (msg.event === "chainChanged" && typeof msg.data === "string") cachedChainId = msg.data;
        if (msg.event === "accountsChanged" && Array.isArray(msg.data)) cachedAccounts = msg.data as string[];
        emit(msg.event, msg.data);
    }
});

interface RequestArgs { method: string; params?: unknown[] | object }

const provider = {
    isMetaMask: true,      // dApp-compatibility flag; many dApps gate features on this
    isRougeWallet: true,   // lets dApps detect RougeChain specifically

    get chainId() { return cachedChainId; },
    get networkVersion() { return String(parseInt(cachedChainId, 16)); },
    get selectedAddress() { return cachedAccounts[0] ?? null; },

    async request(args: RequestArgs): Promise<unknown> {
        if (!args || typeof args.method !== "string") throw rpcError(4001, "Invalid request");
        const params = (args.params as unknown) ?? [];
        const result = await relay(args.method, params);
        // Keep local mirrors fresh for synchronous getters.
        if (args.method === "eth_chainId" && typeof result === "string") cachedChainId = result;
        if ((args.method === "eth_requestAccounts" || args.method === "eth_accounts") && Array.isArray(result)) {
            cachedAccounts = result as string[];
        }
        return result;
    },

    // Legacy compatibility shims -------------------------------------------
    async enable(): Promise<unknown> {
        return this.request({ method: "eth_requestAccounts" });
    },
    async send(methodOrPayload: string | RequestArgs, paramsOrCb?: unknown): Promise<unknown> {
        if (typeof methodOrPayload === "string") {
            return this.request({ method: methodOrPayload, params: (paramsOrCb as unknown[]) ?? [] });
        }
        return this.request(methodOrPayload);
    },
    sendAsync(payload: RequestArgs & { id?: number; jsonrpc?: string }, callback: (err: unknown, res?: unknown) => void): void {
        this.request(payload)
            .then((result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }))
            .catch((err) => callback(err));
    },

    on(event: string, cb: EventCallback) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return this;
    },
    removeListener(event: string, cb: EventCallback) {
        listeners.get(event)?.delete(cb);
        return this;
    },
};

// ── Install as window.ethereum (only if nothing else claimed it) ──────────
try {
    if (!(window as any).ethereum) {
        Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: false });
    }
} catch { /* another wallet froze it — EIP-6963 below still exposes us */ }

// Always expose under a namespaced handle so the bridge can prefer us explicitly.
try {
    Object.defineProperty(window, "rougechainEvm", { value: provider, configurable: true, writable: false });
} catch { /* noop */ }

// ── EIP-6963 multi-wallet discovery ───────────────────────────────────────
const info = {
    uuid: "b7e3a2c1-4d5f-4a6b-9c8d-rougechain001".slice(0, 36),
    name: "RougeChain Wallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNiIgZmlsbD0iIzdjM2FlZCIvPjwvc3ZnPg==",
    rdns: "io.rougechain.wallet",
};
function announce() {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
    }));
}
window.addEventListener("eip6963:requestProvider", announce);
announce();

window.dispatchEvent(new Event("rougechain-evm#initialized"));

export {};
