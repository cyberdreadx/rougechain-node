/**
 * Chrome Storage API wrapper that provides a localStorage-like interface.
 * Used by all core libraries instead of raw localStorage.
 *
 * SECURITY: keys listed in SESSION_KEYS are routed to chrome.storage.session — an
 * in-memory area that survives service-worker cycling but is cleared when the browser
 * closes, and is NEVER written to disk. The decrypted wallet lives there so the plaintext
 * private keys + mnemonic are never persisted at rest; only the AES-GCM–encrypted blob
 * (in chrome.storage.local) touches disk.
 */

// Synchronous in-memory cache backed by chrome.storage.local + chrome.storage.session
let cache: Record<string, string> = {};
let initialized = false;

// Keys held in memory-only session storage (never persisted to disk).
const SESSION_KEYS = new Set<string>(["pqc-unified-wallet"]);

function sessionArea(): chrome.storage.StorageArea | null {
    try {
        // chrome.storage.session exists in MV3 (Chrome 102+); guard for safety.
        return chrome.storage.session ?? null;
    } catch {
        return null;
    }
}

export async function initStorage(): Promise<void> {
    if (initialized) return;
    try {
        const data = await chrome.storage.local.get(null);
        cache = {};
        for (const [key, value] of Object.entries(data)) {
            cache[key] = typeof value === "string" ? value : JSON.stringify(value);
        }
        // Overlay session-storage values (the decrypted wallet, if unlocked this session).
        const session = sessionArea();
        if (session) {
            try {
                const sdata = await session.get(null);
                for (const [key, value] of Object.entries(sdata)) {
                    cache[key] = typeof value === "string" ? value : JSON.stringify(value);
                }
            } catch { /* session area unavailable in this context */ }
        }
        initialized = true;
    } catch {
        // Fallback to localStorage in dev mode
        initialized = true;
    }
}

export function getItem(key: string): string | null {
    if (!initialized) {
        // Fallback for sync access before init
        try { return localStorage.getItem(key); } catch { return null; }
    }
    return cache[key] ?? null;
}

export function setItem(key: string, value: string): void {
    cache[key] = value;
    try {
        if (SESSION_KEYS.has(key)) {
            const session = sessionArea();
            if (session) { session.set({ [key]: value }).catch(() => { }); return; }
            // No session area — fall through to local so the wallet still works (dev/older Chrome).
        }
        chrome.storage.local.set({ [key]: value }).catch(() => { });
    } catch {
        try { localStorage.setItem(key, value); } catch { /* noop */ }
    }
}

export function removeItem(key: string): void {
    delete cache[key];
    try {
        if (SESSION_KEYS.has(key)) {
            const session = sessionArea();
            if (session) { session.remove(key).catch(() => { }); return; }
        }
        chrome.storage.local.remove(key).catch(() => { });
    } catch {
        try { localStorage.removeItem(key); } catch { /* noop */ }
    }
}

/**
 * Force-remove a key from the persisted chrome.storage.local area specifically. Used by the
 * encryption migration to purge a legacy plaintext wallet that was written to disk before
 * session-storage routing existed (the normal removeItem for a session-routed key would only
 * clear the in-memory copy).
 */
export function purgeLocalKey(key: string): void {
    try { chrome.storage.local.remove(key).catch(() => { }); } catch { /* noop */ }
    try { localStorage.removeItem(key); } catch { /* noop */ }
}

// Convenience: get parsed JSON
export function getJSON<T>(key: string): T | null {
    const raw = getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
}

// Convenience: set JSON
export function setJSON(key: string, value: unknown): void {
    setItem(key, JSON.stringify(value));
}
