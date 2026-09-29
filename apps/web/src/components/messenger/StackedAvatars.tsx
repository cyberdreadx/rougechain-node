import { WalletAvatar } from "@/components/WalletAvatar";
import type { ParticipantLike } from "@/lib/messenger-prefs";

/** Up to three overlapping member avatars (group headers / list rows), with a "+N" chip for the rest. */
export function StackedAvatars({ members, size = 40, max = 3 }: { members: ParticipantLike[]; size?: number; max?: number }) {
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  const inner = Math.round(size * 0.62);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} aria-hidden>
      {shown.map((m, i) => {
        const pos = shown.length === 1
          ? { left: (size - inner) / 2, top: (size - inner) / 2 }
          : [{ left: 0, top: 0 }, { left: size - inner, top: size - inner }, { left: size - inner, top: 0 }][i];
        return (
          <div key={(m.signingPublicKey || m.id || "") + i} className="absolute rounded-full ring-2 ring-background" style={{ ...pos, zIndex: max - i }}>
            <WalletAvatar id={m.id || m.signingPublicKey} uri={m.avatarUrl} name={m.displayName} size={inner} />
          </div>
        );
      })}
      {rest > 0 && (
        <span className="absolute -bottom-0.5 -left-0.5 z-10 rounded-full bg-primary text-primary-foreground text-[9px] font-bold px-1 leading-4 ring-2 ring-background">
          +{rest}
        </span>
      )}
    </div>
  );
}
