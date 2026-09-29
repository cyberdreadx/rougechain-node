import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  /** Optional call to action: a button (onClick) and/or custom node via `action`. */
  ctaLabel?: ReactNode;
  onCta?: () => void;
  action?: ReactNode;
  /** Tighter padding for use inside cards / list panels. */
  compact?: boolean;
  className?: string;
}

/**
 * Shared empty state: an icon floating in an animated gradient ring, a title, a hint and an
 * optional CTA. Motion is CSS-only (.empty-orb) and stops for prefers-reduced-motion.
 */
export function EmptyState({ icon: Icon, title, hint, ctaLabel, onCta, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center text-center px-4", compact ? "py-8" : "py-12 sm:py-16", className)}>
      <div className={cn("empty-orb gradient-ring rounded-full grid place-items-center mb-4", compact ? "w-14 h-14" : "w-20 h-20")}>
        <Icon className={cn("empty-orb__icon text-primary", compact ? "w-6 h-6" : "w-8 h-8")} />
      </div>
      <h3 className={cn("font-semibold text-foreground", compact ? "text-sm" : "text-base sm:text-lg")}>{title}</h3>
      {hint ? <p className={cn("text-muted-foreground mt-1 max-w-sm", compact ? "text-xs" : "text-sm")}>{hint}</p> : null}
      {ctaLabel && onCta ? (
        <Button variant="outline" size="sm" className="mt-4 border-primary/40 hover:border-primary hover:bg-primary/10" onClick={onCta}>
          {ctaLabel}
        </Button>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
