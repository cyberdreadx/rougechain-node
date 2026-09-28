import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Small HUD eyebrow above the title (mono, caps, teal). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Badges / chips rendered inline after the title. */
  badges?: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (buttons, search). Wraps under the title on phones. */
  actions?: ReactNode;
  className?: string;
}

/** Consistent page heading: `.hud-label` eyebrow + title (+ badges, description, actions). */
export function PageHeader({ eyebrow, title, badges, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? <p className="hud-label">{eyebrow}</p> : null}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h1 className="page-title">{title}</h1>
          {badges}
        </div>
        {description ? <p className="text-sm text-muted-foreground max-w-2xl">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 min-w-0">{actions}</div> : null}
    </div>
  );
}

export default PageHeader;
