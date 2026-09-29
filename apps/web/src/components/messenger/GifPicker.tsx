import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fetchGifs, type GifItem } from "@/lib/messenger-content";

/**
 * GIPHY picker (Qwalla components/chat/GifPicker.tsx): trending when the box is empty, search after a
 * 400 ms debounce, 20 results, rating pg-13. Selecting sends the original GIF URL as the message body.
 * Only rendered when VITE_GIPHY_API_KEY is set (see gifsEnabled).
 */
export function GifPicker({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const items = await fetchGifs(query, ctrl.signal);
        setGifs(items);
        if (items.length === 0) setError(t("chat.gif.none"));
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setGifs([]);
        setError(t("chat.gif.unavailable"));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, query ? 400 : 0);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [query, t]);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 300, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="glass border-t border-border/60 overflow-hidden flex flex-col"
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chat.gif.search")}
          className="cyber-input h-8 text-sm"
          autoFocus
        />
        <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose} aria-label={t("chat.common.close")}>
          <X className="w-4 h-4" />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {loading && gifs.length === 0 ? (
          <div className="flex justify-center pt-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : error && gifs.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground pt-10">{error}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {gifs.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelect(g.full || g.preview)}
                className="relative aspect-square overflow-hidden rounded-md bg-muted/40 hover:ring-2 hover:ring-[hsl(var(--hologram))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--hologram))] outline-none transition"
              >
                <img src={g.preview || g.full} alt="GIF" loading="lazy" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="bubble-meta text-center text-muted-foreground py-1">{t("chat.gif.powered")}</p>
    </motion.div>
  );
}

export default GifPicker;
