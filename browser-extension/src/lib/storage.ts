/**
 * Chrome Storage API wrapper that provides a localStorage-like interface.
 * Used by all core libraries instead of raw localStorage.
 */

// Synchronous in-memory cache backed by chrome.storage.local
let cache: Record<string, string> = {};
let initialized = false;

export async function initStorage(): Promise<void> {
    if (initialized) return;
    try {
        const data = await chrome.storage.local.get(null);
        cache = {};
        for (const [key, value] of Object.entries(data)) {
            cache[key] = typeof value === "string" ? value : JSON.stringify(value);
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
        chrome.storage.local.set({ [key]: value }).catch(() => { });
    } catch {
        try { localStorage.setItem(key, value); } catch { /* noop */ }
    }
}

export function removeItem(key: string): void {
    delete cache[key];
    try {
        chrome.storage.local.remove(key).catch(() => { });
    } catch {
        try { localStorage.removeItem(key); } catch { /* noop */ }
    }
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
