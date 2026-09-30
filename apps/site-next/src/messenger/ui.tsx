/** Shared messenger / mail UI: directory avatars, stacked group avatars and the bottom sheet. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { PROFILE_CHANGED_EVENT, isSafeAvatarUrl } from "@rougechain/core/avatar";
import { peekWalletEntry, resolveWalletEntry } from "@rougechain/core/wallet-directory";
import type { ParticipantLike } from "@rougechain/core/messenger-prefs";
import { Avatar } from "../wallet/profile";
import { useTranslation } from "react-i18next";

/**
 * A wallet's directory avatar (image → initials), resolved from core's cached messenger directory
 * by `id` unless `uri` is given — apps/web's WalletAvatar, drawn with site-next's Avatar.
 */
export function PeerAvatar({ id, name, uri, size = 40 }: { id?: string | null; name?: string | null; uri?: string | null; size?: number }) {
  const [avatar, setAvatar] = useState<string | undefined>(() => (isSafeAvatarUrl(uri) ? uri : peekWalletEntry(id)?.avatar));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(PROFILE_CHANGED_EVENT, bump);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, bump);
  }, []);
  useEffect(() => {
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
  return <Avatar uri={avatar} name={name || "?"} size={size} />;
}

/** Up to three overlapping member avatars with a "+N" chip (group rows / headers). */
export function StackedAvatars({ members, size = 40, max = 3 }: { members: ParticipantLike[]; size?: number; max?: number }) {
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  const inner = Math.round(size * 0.62);
  return (
    <span className="msg-stack" style={{ width: size, height: size }} aria-hidden="true">
      {shown.map((m, i) => {
        const pos =
          shown.length === 1
            ? { left: (size - inner) / 2, top: (size - inner) / 2 }
            : [
                { left: 0, top: 0 },
                { left: size - inner, top: size - inner },
                { left: size - inner, top: 0 },
              ][i];
        return (
          <span key={(m.signingPublicKey || m.id || "") + i} className="msg-stack-item" style={{ ...pos, zIndex: max - i }}>
            <PeerAvatar id={m.id || m.signingPublicKey} uri={m.avatarUrl} name={m.displayName} size={inner} />
          </span>
        );
      })}
      {rest > 0 && <span className="msg-stack-more">+{rest}</span>}
    </span>
  );
}

/**
 * Messenger sheet: a bottom sheet on phones, a centered card on wider screens. Escape and the
 * backdrop close it; focus moves into it on open.
 */
export function Sheet({
  title,
  icon,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation("messenger");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="msg-sheet-backdrop" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={`msg-sheet ${wide ? "wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="msg-sheet-head">
          {icon}
          <h2>{title}</h2>
          <button type="button" className="button ghost icon" aria-label={t("common.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="msg-sheet-body">{children}</div>
        {footer && <div className="msg-sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Small icon button in the design system's ghost style. */
export function IconButton({
  label,
  onClick,
  children,
  disabled,
  active,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`button ghost icon msg-icon ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
