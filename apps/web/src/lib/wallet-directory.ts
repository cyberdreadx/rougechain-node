/**
 * Shared, cached view of the messenger wallet directory, so any component can
 * resolve a wallet's display name + avatar without refetching. Keyed by every
 * id a wallet can be referenced by (id / signing key / encryption key).
 * Mirrors Qwalla's lib/wallet-directory.ts.
 */
import { getWallets, type Wallet } from "@/lib/pqc-messenger";
import { getActiveNetwork } from "@/lib/network";

export type DirEntry = { name?: string; avatar?: string };

const TTL_MS = 60_000;

let cache: Map<string, DirEntry> | null = null;
let cacheNetwork = "";
let fetchedAt = 0;
let inflight: Promise<Map<string, DirEntry>> | null = null;
/** Local overrides (my own freshly-changed avatar) that win over a stale directory. */
const overrides = new Map<string, DirEntry>();

export function buildDirectoryMap(list: Wallet[]): Map<string, DirEntry> {
  const entries = new Map<string, DirEntry>();
  for (const w of list) {
    const name = w.displayName || undefined;
    const avatar = w.avatarUrl || undefined;
    if (!name && !avatar) continue;
    const entry: DirEntry = { name, avatar };
    for (const key of [w.id, w.signingPublicKey, w.encryptionPublicKey]) {
      if (key) entries.set(key, entry);
    }
  }
  return entries;
}

/** The directory, refetched at most once per TTL (or when `force`). */
export async function getWalletDirectory(force = false): Promise<Map<string, DirEntry>> {
  const net = getActiveNetwork();
  if (!force && cache && cacheNetwork === net && Date.now() - fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await getWallets();
      cache = buildDirectoryMap(list);
      cacheNetwork = net;
      fetchedAt = Date.now();
      return cache;
    } catch {
      return cache ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** One wallet's entry (cached map if fresh). Local overrides win. */
export async function resolveWalletEntry(id: string | null | undefined): Promise<DirEntry | undefined> {
  if (!id) return undefined;
  const local = overrides.get(id);
  const dir = await getWalletDirectory();
  const remote = dir.get(id);
  if (!local) return remote;
  return { name: local.name ?? remote?.name, avatar: "avatar" in local ? local.avatar : remote?.avatar };
}

/** Synchronous peek (no fetch) — lets avatars paint immediately when already cached. */
export function peekWalletEntry(id: string | null | undefined): DirEntry | undefined {
  if (!id) return undefined;
  const local = overrides.get(id);
  const remote = cache?.get(id);
  if (!local) return remote;
  return { name: local.name ?? remote?.name, avatar: "avatar" in local ? local.avatar : remote?.avatar };
}

/** Record my own avatar under all my ids so every WalletAvatar shows it before the directory refreshes. */
export function setLocalDirectoryAvatar(ids: Array<string | null | undefined>, avatar: string | null): void {
  for (const id of ids) {
    if (!id) continue;
    const prev = overrides.get(id) ?? {};
    overrides.set(id, { ...prev, avatar: avatar ?? undefined });
  }
}

/** Drop the cached directory (e.g. after re-registering). */
export function invalidateWalletDirectory(): void {
  fetchedAt = 0;
}
