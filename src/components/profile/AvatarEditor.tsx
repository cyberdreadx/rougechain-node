import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, Check, Image as ImageIcon, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WalletAvatar } from "@/components/WalletAvatar";
import { fitsAvatarLimit, isSafeAvatarUrl } from "@/lib/avatar";
import { fileToAvatarDataUri } from "@/lib/avatar-image";
import { setProfileAvatar } from "@/lib/profile";
import { getNftsByOwner, type NftToken } from "@/lib/secure-api";
import { useMyProfile } from "@/hooks/use-my-profile";
import { cn } from "@/lib/utils";

function ipfsToHttps(uri: string): string {
  return uri.startsWith("ipfs://") ? uri.replace("ipfs://", "https://ipfs.io/ipfs/") : uri;
}

/** Best-effort image for an NFT: metadata JSON's `image`, else the metadata URI itself (as the explorer does). */
async function resolveNftImage(token: NftToken): Promise<string | undefined> {
  const raw = token.metadata_uri?.trim();
  if (!raw) return undefined;
  const uri = ipfsToHttps(raw);
  const looksJson = /^data:application\/json/i.test(uri) || /\.json(\?|#|$)/i.test(uri);
  let image: string | undefined = uri;
  if (looksJson) {
    try {
      const res = await fetch(uri);
      const json = await res.json();
      image = typeof json?.image === "string" ? ipfsToHttps(json.image) : undefined;
    } catch {
      image = undefined;
    }
  }
  return isSafeAvatarUrl(image) && fitsAvatarLimit(image) ? image : undefined;
}

interface AvatarEditorProps {
  /** Preview edge in px. */
  size?: number;
  /** Stack controls under the preview (onboarding) instead of beside it (settings). */
  layout?: "row" | "stack";
  onChanged?: (avatar: string | null) => void;
}

/** Upload (square crop + JPEG under 256 KB), pick one of your NFTs, or remove your profile photo. */
export function AvatarEditor({ size = 88, layout = "row", onChanged }: AvatarEditorProps) {
  const { t } = useTranslation();
  const me = useMyProfile();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showNfts, setShowNfts] = useState(false);
  const [nfts, setNfts] = useState<Array<{ key: string; name: string; image: string }> | null>(null);
  const [nftLoading, setNftLoading] = useState(false);

  const canEdit = !!me.wallet;

  useEffect(() => {
    if (!showNfts || nfts !== null || !me.signingPublicKey) return;
    let cancelled = false;
    setNftLoading(true);
    (async () => {
      const res = await getNftsByOwner(me.signingPublicKey!);
      const tokens = res.success && Array.isArray(res.data) ? res.data.slice(0, 60) : [];
      const resolved = await Promise.all(
        tokens.map(async (tk) => {
          const image = await resolveNftImage(tk);
          return image ? { key: `${tk.collection_id}-${tk.token_id}`, name: tk.name || `#${tk.token_id}`, image } : null;
        }),
      );
      if (!cancelled) setNfts(resolved.filter((x): x is { key: string; name: string; image: string } => !!x));
    })()
      .catch(() => { if (!cancelled) setNfts([]); })
      .finally(() => { if (!cancelled) setNftLoading(false); });
    return () => { cancelled = true; };
  }, [showNfts, nfts, me.signingPublicKey]);

  const apply = async (url: string | null, successKey: string) => {
    setBusy(true);
    try {
      await setProfileAvatar(url);
      toast.success(t(successKey));
      onChanged?.(url);
    } catch (e) {
      toast.error(t("profile.avatar.failed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    let dataUri: string;
    try {
      dataUri = await fileToAvatarDataUri(file);
    } catch (err) {
      setBusy(false);
      toast.error(t("profile.avatar.tooLarge"), { description: err instanceof Error ? err.message : undefined });
      return;
    }
    await apply(dataUri, "profile.avatar.updated");
  };

  return (
    <div className="space-y-3">
      <div className={cn("flex gap-4", layout === "stack" ? "flex-col items-center text-center" : "items-center")}>
        <div className="relative">
          <WalletAvatar
            id={me.signingPublicKey}
            uri={me.avatar}
            name={me.displayName}
            size={size}
            ring
          />
          {busy && (
            <div className="absolute inset-0 rounded-full bg-background/60 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          )}
        </div>
        <div className={cn("flex flex-wrap gap-2", layout === "stack" && "justify-center")}>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={!canEdit || busy}>
            <Camera className="w-4 h-4 mr-1.5" />
            {me.avatar ? t("profile.avatar.change") : t("profile.avatar.upload")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowNfts((s) => !s)} disabled={!canEdit || busy}>
            <ImageIcon className="w-4 h-4 mr-1.5" />
            {t("profile.avatar.chooseNft")}
          </Button>
          {me.avatar && (
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => apply(null, "profile.avatar.removed")} disabled={busy}>
              <Trash2 className="w-4 h-4 mr-1.5" />
              {t("profile.avatar.remove")}
            </Button>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showNfts && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="rounded-xl border border-border/60 bg-background/40 p-3">
              {nftLoading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> {t("profile.avatar.loadingNfts")}
                </div>
              ) : !nfts || nfts.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t("profile.avatar.noNfts")}</p>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-5 gap-2 max-h-64 overflow-y-auto">
                  {nfts.map((n) => {
                    const selected = n.image === me.avatar;
                    return (
                      <button
                        key={n.key}
                        type="button"
                        title={n.name}
                        disabled={busy}
                        onClick={() => apply(n.image, "profile.avatar.updated")}
                        className={cn(
                          "relative aspect-square overflow-hidden rounded-lg border transition-all hover:scale-[1.03]",
                          selected ? "border-primary ring-2 ring-primary/50" : "border-border/60",
                        )}
                      >
                        <img src={n.image} alt={n.name} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                        {selected && (
                          <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5">
                            <Check className="w-3 h-3 text-primary-foreground" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {!canEdit && <p className="text-xs text-muted-foreground">{t("profile.avatar.unlockFirst")}</p>}
    </div>
  );
}

export default AvatarEditor;
