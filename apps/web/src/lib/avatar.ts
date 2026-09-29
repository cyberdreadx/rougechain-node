/**
 * Profile avatars: pure helpers + the per-device avatar store.
 *
 * The node shares an optional avatar through the messenger wallet directory
 * (signed register payload field `avatarUrl`, returned as `avatar_url`). It is
 * REPLACED on every register, so every re-register must carry the avatar or it
 * gets wiped. The store below remembers the avatar per signing public key so
 * registerWalletOnNode can always include it (see resolveAvatarForRegistration
 * in pqc-messenger.ts).
 */

/** Node cap on the avatar string (a data URI), see MESSENGER_AVATAR_MAX_BYTES in the daemon. */
export const AVATAR_MAX_BYTES = 256 * 1024;

const AVATAR_STORE_KEY = "rougechain-profile-avatars";

/**
 * Pull the avatar out of a directory / wallet record whatever its casing
 * (`avatarUrl`, `avatar_url` or `avatar`). Empty / non-string → undefined.
 */
export function normalizeAvatarField(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  for (const v of [r.avatarUrl, r.avatar_url, r.avatar]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Only render / send image data URIs and https URLs (never javascript:, http:, etc.). */
export function isSafeAvatarUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  return /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url) || /^https:\/\//i.test(url);
}

/** Whether the node will accept this avatar (size is measured on the string, like the daemon). */
export function fitsAvatarLimit(url: string): boolean {
  return new TextEncoder().encode(url).length <= AVATAR_MAX_BYTES;
}

/** Up to two initials for the fallback bubble ("Ada Lovelace" → "AL", "rouge" → "RO"). */
export function avatarInitials(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  if (!clean) return "";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
  return Array.from(clean).slice(0, 2).join("").toUpperCase();
}

/**
 * Centered square crop of a w×h image, then scaled so the edge is at most
 * `maxEdge` (never upscaled). Returns the source rect and the output edge.
 */
export function squareCropRect(
  width: number,
  height: number,
  maxEdge: number,
): { sx: number; sy: number; side: number; out: number } {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const side = Math.min(w, h);
  const sx = Math.floor((w - side) / 2);
  const sy = Math.floor((h - side) / 2);
  const out = Math.max(1, Math.min(side, Math.floor(maxEdge)));
  return { sx, sy, side, out };
}

/** Compression ladder for avatars: first attempt that fits under the cap wins. */
export const AVATAR_ATTEMPTS: ReadonlyArray<{ edge: number; quality: number }> = [
  { edge: 512, quality: 0.85 },
  { edge: 512, quality: 0.7 },
  { edge: 384, quality: 0.7 },
  { edge: 320, quality: 0.6 },
  { edge: 256, quality: 0.6 },
  { edge: 192, quality: 0.5 },
  { edge: 128, quality: 0.5 },
];

// ── Per-device store, keyed by signing public key ─────────────────────────
// value: string = avatar; null = user REMOVED it (don't adopt the directory's);
// missing = unknown on this device.

function readStore(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(AVATAR_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** string = known avatar, null = explicitly removed, undefined = unknown. */
export function getStoredAvatar(signingPublicKey: string | null | undefined): string | null | undefined {
  if (!signingPublicKey) return undefined;
  const store = readStore();
  return Object.prototype.hasOwnProperty.call(store, signingPublicKey) ? store[signingPublicKey] : undefined;
}

export function setStoredAvatar(signingPublicKey: string, url: string | null): void {
  if (!signingPublicKey) return;
  try {
    const store = readStore();
    store[signingPublicKey] = url;
    localStorage.setItem(AVATAR_STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage full / unavailable: the directory copy still works */
  }
  try {
    window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT, { detail: { signingPublicKey } }));
  } catch {
    /* non-browser */
  }
}

/** Fired on window when the user's own avatar / name changes, so profile UI re-renders. */
export const PROFILE_CHANGED_EVENT = "rougechain:profile-changed";

// ── Display name, same idea ───────────────────────────────────────────────
// A vault-encrypted wallet only re-encrypts when the password is set, so a
// rename made while unlocked would be lost on the next unlock. The name is
// public (it's in the directory), so keep it per key and overlay it on unlock.

const NAME_STORE_KEY = "rougechain-profile-names";

export function getStoredDisplayName(signingPublicKey: string | null | undefined): string | undefined {
  if (!signingPublicKey) return undefined;
  try {
    const raw = localStorage.getItem(NAME_STORE_KEY);
    const store = raw ? JSON.parse(raw) : {};
    const v = store?.[signingPublicKey];
    return typeof v === "string" && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
}

export function setStoredDisplayName(signingPublicKey: string, name: string): void {
  if (!signingPublicKey) return;
  try {
    const raw = localStorage.getItem(NAME_STORE_KEY);
    const store = raw ? JSON.parse(raw) : {};
    store[signingPublicKey] = name;
    localStorage.setItem(NAME_STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable */
  }
}

/** Apply this device's newer profile (name + avatar) over a wallet decrypted from an older vault blob. */
export function overlayStoredProfile<T extends { signingPublicKey: string; displayName: string; avatarUrl?: string }>(wallet: T): T {
  const name = getStoredDisplayName(wallet.signingPublicKey);
  const avatar = getStoredAvatar(wallet.signingPublicKey);
  const out = { ...wallet };
  if (name) out.displayName = name;
  if (avatar === null) delete out.avatarUrl;
  else if (typeof avatar === "string") out.avatarUrl = avatar;
  return out;
}
