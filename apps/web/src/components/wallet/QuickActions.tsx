import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";

export type ActionTone = "magenta" | "teal" | "cyan" | "green" | "violet" | "amber" | "purple";

/** Gradient per action colour, and the glow hue (HSL triplet) the chip breathes with. */
const TONES: Record<ActionTone, { bg: string; glow: string }> = {
  magenta: { bg: "linear-gradient(135deg, hsl(349 100% 59%), hsl(331 75% 51%))", glow: "331 75% 51%" },
  teal:    { bg: "linear-gradient(135deg, hsl(166 85% 50%), hsl(186 80% 42%))", glow: "166 85% 50%" },
  cyan:    { bg: "linear-gradient(135deg, hsl(196 95% 55%), hsl(221 85% 58%))", glow: "196 95% 55%" },
  green:   { bg: "linear-gradient(135deg, hsl(145 70% 45%), hsl(166 80% 40%))", glow: "145 70% 45%" },
  violet:  { bg: "linear-gradient(135deg, hsl(262 87% 60%), hsl(286 75% 55%))", glow: "262 87% 60%" },
  amber:   { bg: "linear-gradient(135deg, hsl(38 95% 55%), hsl(20 90% 55%))", glow: "38 95% 55%" },
  purple:  { bg: "linear-gradient(135deg, hsl(280 70% 55%), hsl(310 70% 50%))", glow: "280 70% 55%" },
};

export interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: ActionTone;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}

/** Wallet quick actions: an even grid of glass tiles with gradient icon chips. */
export default function QuickActions({ actions }: { actions: QuickAction[] }) {
  const cols = actions.length <= 4 ? "grid-cols-4" : actions.length <= 6 ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-4";
  return (
    <div className={`grid ${cols} gap-2.5`}>
      {actions.map(({ key, label, icon: Icon, tone, onClick, disabled, loading, title }) => (
        <button
          key={key}
          type="button"
          className="action-tile"
          onClick={onClick}
          disabled={disabled || loading}
          title={title ?? label}
        >
          <span className="action-chip" style={{ background: TONES[tone].bg, ["--chip-glow" as string]: TONES[tone].glow }}>
            {loading ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <Icon className="w-[18px] h-[18px]" strokeWidth={2.2} />}
          </span>
          <span className="text-[11px] font-medium leading-tight text-foreground/90 text-center">{label}</span>
        </button>
      ))}
    </div>
  );
}
