/**
 * Smart API Cache — TTL-based caching with request deduplication
 *
 * Reduces redundant network calls across extension tabs by:
 * - Caching responses with configurable TTL per endpoint category
 * - Deduplicating concurrent identical requests (single in-flight promise)
 * - Providing instant invalidation after mutations (send, create, etc.)
 */

interface CacheEntry<T> {
    data: T;
    expiry: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const TTL = {
    balance: 10_000,
    blocks: 15_000,
    tokens: 60_000,
    nftOwner: 15_000,
    nftCollections: 60_000,
    messengerWallets: 30_000,
    messengerConversations: 5_000,
    messengerMessages: 3_000,
    mailInbox: 5_000,
    mailSent: 10_000,
    mailTrash: 30_000,
    nameRegistry: 120_000,
} as const;

export type CacheCategory = keyof typeof TTL;

function cacheKey(category: string, ...parts: string[]): string {
    return `${category}:${parts.join(":")}`;
}

export async function cachedFetch<T>(
    category: CacheCategory,
    key: string,
    fetcher: () => Promise<T>,
): Promise<T> {
    const k = cacheKey(category, key);

    const cached = cache.get(k);
    if (cached && Date.now() < cached.expiry) {
        return cached.data as T;
    }

    const existing = inflight.get(k);
    if (existing) {
        return existing as Promise<T>;
    }

    const promise = fetcher()
        .then(data => {
            cache.set(k, { data, expiry: Date.now() + TTL[category] });
            inflight.delete(k);
            return data;
        })
        .catch(err => {
            inflight.delete(k);
            throw err;
        });

    inflight.set(k, promise);
    return promise;
}

export function invalidate(category: CacheCategory, key?: string): void {
    if (key) {
        cache.delete(cacheKey(category, key));
    } else {
        for (const k of cache.keys()) {
            if (k.startsWith(`${category}:`)) cache.delete(k);
        }
    }
}

export function invalidateAll(): void {
    cache.clear();
}
