/**
 * Qwalla body kinds (apps/web RichBody): GIF / image URLs, data-URI photos, voice notes, stickers
 * and emoji-only messages. Media rule (core messenger-content): GIPHY and data: images load
 * automatically; any other https image is click-to-load so opening a chat doesn't leak your IP to
 * an arbitrary server. Returns null for plain text.
 */
import { useEffect, useState } from "react";
import { ImageIcon, Loader2, Search, X } from "lucide-react";
import { classifyBody, fetchGifs, isAutoloadImage, isRenderableImageUrl, parseSticker, type GifItem } from "@rougechain/core/messenger-content";
import { S, fmt } from "./strings";

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function RichBody({ body, blurred, onImageClick }: { body: string | undefined; blurred?: boolean; onImageClick?: (url: string) => void }) {
  const kind = classifyBody(body);
  const [load, setLoad] = useState(false);
  if (!body) return null;

  if (kind === "gif" || kind === "image") {
    const url = body.trim();
    if (!isRenderableImageUrl(url)) return null;
    if (!isAutoloadImage(url) && !load)
      return (
        <button
          type="button"
          className="msg-load-image"
          title={url}
          onClick={(e) => {
            e.stopPropagation();
            setLoad(true);
          }}
        >
          <ImageIcon size={15} aria-hidden="true" />
          <span>{fmt(S.media.loadImage, { host: safeHost(url) })}</span>
        </button>
      );
    return (
      <img
        src={url}
        alt={kind === "gif" ? "GIF" : S.media.image}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`msg-media ${blurred ? "blurred" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!blurred) onImageClick?.(url);
        }}
      />
    );
  }
  if (kind === "voice")
    return <audio controls src={blurred ? undefined : body} className="msg-audio" aria-label={S.media.voice} onClick={(e) => e.stopPropagation()} />;
  if (kind === "sticker") {
    const s = parseSticker(body);
    if (!s) return null;
    return (
      <span className={`msg-sticker ${blurred ? "blurred" : ""}`} title={s.label} aria-label={s.label}>
        {s.emoji}
      </span>
    );
  }
  if (kind === "emoji") return <span className={`msg-emoji ${blurred ? "blurred" : ""}`}>{body.trim()}</span>;
  return null;
}

/**
 * GIPHY picker (Qwalla GifPicker): trending when empty, search after 400 ms, 20 results, pg-13.
 * Selecting sends the original GIF URL as the message body. Only rendered when gifsEnabled().
 */
export function GifPicker({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        try {
          const items = await fetchGifs(query, ctrl.signal);
          setGifs(items);
          if (items.length === 0) setError(S.gif.none);
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          setGifs([]);
          setError(S.gif.unavailable);
        } finally {
          if (!ctrl.signal.aborted) setLoading(false);
        }
      },
      query ? 400 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  return (
    <div className="msg-gifs">
      <div className="msg-gifs-head">
        <Search size={15} aria-hidden="true" />
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={S.gif.search} aria-label={S.gif.search} autoFocus />
        <button type="button" className="button ghost icon msg-icon" aria-label={S.common.close} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="msg-gifs-grid">
        {loading && gifs.length === 0 ? (
          <Loader2 className="spin" size={18} />
        ) : error && gifs.length === 0 ? (
          <p className="muted">{error}</p>
        ) : (
          gifs.map((g) => (
            <button key={g.id} type="button" onClick={() => onSelect(g.full || g.preview)}>
              <img src={g.preview || g.full} alt="GIF" loading="lazy" referrerPolicy="no-referrer" />
            </button>
          ))
        )}
      </div>
      <p className="msg-gifs-foot">{S.gif.powered}</p>
    </div>
  );
}
