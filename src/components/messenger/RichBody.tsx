import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { classifyBody, isAutoloadImage, isRenderableImageUrl, parseSticker } from "@/lib/messenger-content";

/**
 * Renders the Qwalla body kinds the site used to show as raw text: GIF / image URLs, data-URI
 * photos, voice notes, stickers and emoji-only messages. Returns null for anything else so the
 * caller falls back to its normal text rendering.
 */
export function RichBody({ body, blurred, onImageClick }: { body: string | undefined; blurred?: boolean; onImageClick?: (url: string) => void }) {
  const { t } = useTranslation();
  const kind = classifyBody(body);
  const [load, setLoad] = useState(false);
  if (!body) return null;

  if (kind === "gif" || kind === "image") {
    const url = body.trim();
    if (!isRenderableImageUrl(url)) return null;
    if (!isAutoloadImage(url) && !load) {
      return (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setLoad(true); }}
          className="my-1 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs hover:bg-muted/40"
          title={url}
        >
          <ImageIcon className="w-4 h-4" />
          <span className="truncate max-w-[180px]">{t("chat.media.loadImage", { host: safeHost(url) })}</span>
        </button>
      );
    }
    return (
      <img
        src={url}
        alt={kind === "gif" ? "GIF" : t("chat.media.image")}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`my-1 max-w-full w-[240px] max-h-[260px] object-cover rounded-md cursor-pointer transition-all duration-300 ${blurred ? "blur-xl" : ""}`}
        onClick={(e) => { e.stopPropagation(); if (!blurred) onImageClick?.(url); }}
      />
    );
  }

  if (kind === "voice") {
    return (
      <audio
        controls
        src={blurred ? undefined : body}
        className="my-1 max-w-[240px] h-10"
        onClick={(e) => e.stopPropagation()}
        aria-label={t("chat.media.voice")}
      />
    );
  }

  if (kind === "sticker") {
    const s = parseSticker(body);
    if (!s) return null;
    return (
      <span className={`block text-6xl leading-none py-1 ${blurred ? "blur-md" : ""}`} title={s.label} aria-label={s.label}>
        {s.emoji}
      </span>
    );
  }

  if (kind === "emoji") {
    return <span className={`block text-4xl leading-tight ${blurred ? "blur-md" : ""}`}>{body.trim()}</span>;
  }

  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export default RichBody;
