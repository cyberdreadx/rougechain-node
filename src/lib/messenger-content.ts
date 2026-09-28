/**
 * Message body kinds Qwalla sends as plain `b` bodies inside a `{"v":1,"k":"msg"}` envelope
 * (Qwalla app/(tabs)/messenger/[id].tsx classifyContent — same regexes, same order):
 *   voice    data:audio/…;base64,…                     (lib/voice.ts, data:audio/mp4 from the recorder)
 *   tip      [tip:<amount>:<SYMBOL>]                   (see messenger-envelope parseTip)
 *   gif      https://….gif|.webp…                      (GifPicker sends GIPHY images.original.url)
 *   image    https://….(gif|webp|jpg|jpeg|png|bmp|svg) or data:image/…;base64,…
 *   sticker  [sticker:<label>]<emoji>
 *   emoji    1–12 emoji only (rendered large)
 *   text     anything else
 * GIFs are sent exactly as Qwalla's sendGif does: sendContent(url) → {"v":1,"k":"msg","b":"<url>"}.
 */

export type BodyKind = "voice" | "tip" | "gif" | "image" | "sticker" | "emoji" | "text";

const EMOJI_ONLY_RE = /^[\p{Emoji}\p{Emoji_Component}\s]{1,12}$/u;
const GIF_RE = /^https?:\/\/.*\.(gif|webp)/i;
const IMAGE_RE = /^(https?:\/\/.*\.(gif|webp|jpg|jpeg|png|bmp|svg)|data:image\/[^;]+;base64,)/i;
const STICKER_RE = /^\[sticker:(.+?)\](.+)$/;
const TIP_RE = /^\[tip:([\d.]+):([A-Za-z]{2,8})\]$/;
const VOICE_RE = /^data:audio\//i;

export function classifyBody(text: string | undefined): BodyKind {
  if (!text) return "text";
  if (VOICE_RE.test(text)) return "voice";
  if (TIP_RE.test(text.trim())) return "tip";
  if (GIF_RE.test(text)) return "gif";
  if (IMAGE_RE.test(text.trim())) return "image";
  if (STICKER_RE.test(text)) return "sticker";
  // Plain digits match \p{Emoji} (keycap bases); a number is text, not an emoji.
  if (EMOJI_ONLY_RE.test(text.trim()) && /\p{Extended_Pictographic}/u.test(text)) return "emoji";
  return "text";
}

/** `[sticker:<label>]<emoji>` → its parts, or null. */
export function parseSticker(text: string | undefined): { label: string; emoji: string } | null {
  const m = text ? STICKER_RE.exec(text) : null;
  return m ? { label: m[1], emoji: m[2] } : null;
}

/** Qwalla's sticker body. */
export function buildStickerBody(label: string, emoji: string): string {
  return `[sticker:${label}]${emoji}`;
}

/**
 * Hosts whose images load automatically. Anything else shows a "load image" button first: a remote
 * URL someone sends you would otherwise reveal your IP / online status to that server on open.
 */
const AUTOLOAD_HOSTS = /(^|\.)giphy\.com$/i;

export function isAutoloadImage(url: string): boolean {
  if (/^data:image\//i.test(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && AUTOLOAD_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Only http(s) and data:image URLs are ever put in an <img>. */
export function isRenderableImageUrl(url: string): boolean {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ── GIPHY (same provider and query as Qwalla components/chat/GifPicker.tsx) ──────────────────

const GIPHY_SEARCH = "https://api.giphy.com/v1/gifs/search";
const GIPHY_TRENDING = "https://api.giphy.com/v1/gifs/trending";

/** GIPHY API key from the build env (VITE_GIPHY_API_KEY). The picker is hidden when unset. */
export function giphyKey(): string {
  const k = (import.meta.env?.VITE_GIPHY_API_KEY as string | undefined) ?? "";
  return k.trim();
}

export function gifsEnabled(): boolean {
  return giphyKey().length > 0;
}

export interface GifItem {
  id: string;
  preview: string;
  full: string;
}

/** Build the GIPHY request URL: trending for an empty query, search otherwise (limit 20, pg-13). */
export function giphyUrl(query: string, key = giphyKey()): string {
  const q = query.trim();
  const params = new URLSearchParams({ api_key: key, limit: "20", rating: "pg-13" });
  if (q) params.set("q", q);
  return `${q ? GIPHY_SEARCH : GIPHY_TRENDING}?${params}`;
}

/** Map a GIPHY response to picker items (preview = small still, full = original, as Qwalla). */
export function parseGiphyResponse(data: unknown): GifItem[] {
  const list = (data as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((g) => {
      const o = g as { id?: string; images?: Record<string, { url?: string } | undefined> };
      const preview = o.images?.fixed_width_small?.url || o.images?.fixed_width?.url || "";
      const full = o.images?.original?.url || "";
      return { id: String(o.id ?? full), preview, full };
    })
    .filter((g) => g.preview || g.full);
}

export async function fetchGifs(query: string, signal?: AbortSignal): Promise<GifItem[]> {
  const key = giphyKey();
  if (!key) return [];
  const res = await fetch(giphyUrl(query, key), { signal });
  if (!res.ok) throw new Error(`GIPHY ${res.status}`);
  return parseGiphyResponse(await res.json());
}
