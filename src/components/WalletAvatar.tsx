import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { PROFILE_CHANGED_EVENT, avatarInitials, isSafeAvatarUrl } from "@/lib/avatar";
import { peekWalletEntry, resolveWalletEntry } from "@/lib/wallet-directory";
import { cn } from "@/lib/utils";

interface WalletAvatarProps {
  /** Any id the directory knows the wallet by (id / signing key / encryption key). */
  id?: string | null;
  /** Name for the initials fallback. */
  name?: string | null;
  /** Known avatar: skips the directory lookup. */
  uri?: string | null;
  /** Edge in px. */
  size?: number;
  className?: string;
  /** Wrap in the animated gradient ring. */
  ring?: boolean;
}

/**
 * A wallet's directory avatar: image → initials → person icon. Resolves from
 * the cached messenger directory by `id` unless `uri` is given. Mirrors
 * Qwalla's components/WalletAvatar.tsx.
 */
export function WalletAvatar({ id, name, uri, size = 40, className, ring = false }: WalletAvatarProps) {
  const initialAvatar = isSafeAvatarUrl(uri) ? uri : peekWalletEntry(id)?.avatar;
  const [avatar, setAvatar] = useState<string | undefined>(initialAvatar);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(PROFILE_CHANGED_EVENT, bump);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, bump);
  }, []);

  useEffect(() => {
    setFailed(false);
    if (isSafeAvatarUrl(uri)) {
      setAvatar(uri);
      return;
    }
    setAvatar(peekWalletEntry(id)?.avatar);
    if (!id) return;
    let cancelled = false;
    resolveWalletEntry(id)
      .then((e) => {
        if (!cancelled) setAvatar(isSafeAvatarUrl(e?.avatar) ? e?.avatar : undefined);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, uri, version]);

  const initials = avatarInitials(name);
  const dim = { width: size, height: size };

  const inner =
    avatar && !failed ? (
      <img
        src={avatar}
        alt={name ?? ""}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full rounded-full object-cover"
      />
    ) : initials ? (
      <span className="font-semibold text-foreground/80 select-none" style={{ fontSize: Math.max(10, size * 0.38) }}>
        {initials}
      </span>
    ) : (
      <User className="text-muted-foreground" style={{ width: size * 0.5, height: size * 0.5 }} />
    );

  return (
    <div
      style={dim}
      className={cn(
        "relative shrink-0 rounded-full flex items-center justify-center overflow-hidden bg-gradient-to-br from-primary/25 via-card to-accent/25 border border-border/60",
        ring && "gradient-ring p-[2px] border-transparent",
        className,
      )}
    >
      {inner}
    </div>
  );
}

export default WalletAvatar;
