import { MapPin, CheckCircle2, Circle, ExternalLink, Hash } from "lucide-react";
import type { RegenProject } from "@/lib/regenerate";
import { REGEN_CATEGORIES, REGEN_STATUS_LABEL } from "@/lib/regenerate";

const STATUS_STYLES: Record<RegenProject["status"], string> = {
  proposed: "text-muted-foreground border-border bg-muted/40",
  reviewing: "text-accent border-accent/30 bg-accent/10",
  funded: "text-success border-success/30 bg-success/10",
  in_progress: "text-success border-success/30 bg-success/10",
  completed: "text-success border-success/40 bg-success/15",
};

const CATEGORY_LABEL = Object.fromEntries(REGEN_CATEGORIES.map((c) => [c.key, c.title]));

/**
 * Reusable Regenerate project card. Purely presentational — it renders whatever a
 * RegenProject holds, so real on-chain/API data can be dropped in unchanged.
 * Fields with no data yet (funding, evidence, tx) render honest "pending" states.
 */
export default function ProjectCard({ project }: { project: RegenProject }) {
  const {
    name, location, category, requestedXrge, status, description, milestones, evidenceUrl, txHash,
  } = project;

  return (
    <article className="flex flex-col h-full rounded-2xl border border-border bg-card p-5 hover:border-success/40 transition-colors">
      <header className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground leading-tight">{name}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{location}</span>
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status]}`}>
          {REGEN_STATUS_LABEL[status]}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="rounded-md bg-muted/50 border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {CATEGORY_LABEL[category] ?? category}
        </span>
        <span className="rounded-md bg-muted/50 border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {requestedXrge != null ? `${requestedXrge.toLocaleString()} XRGE requested` : "Funding: TBD"}
        </span>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed mb-4">{description}</p>

      {milestones.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Milestones</p>
          <ul className="space-y-1.5">
            {milestones.map((m, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {m.done
                  ? <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" aria-hidden="true" />
                  : <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />}
                <span className={m.done ? "text-foreground" : "text-muted-foreground"}>{m.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="mt-auto pt-3 border-t border-border flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {evidenceUrl ? (
          <a href={evidenceUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-success hover:underline">
            Evidence <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        ) : (
          <span className="text-muted-foreground/70">Evidence: pending</span>
        )}
        {txHash ? (
          <a href={`/tx/${txHash}`} className="flex items-center gap-1 text-primary hover:underline font-mono">
            <Hash className="w-3 h-3" aria-hidden="true" />{txHash.slice(0, 10)}…
          </a>
        ) : (
          <span className="text-muted-foreground/70">Funding tx: pending</span>
        )}
      </footer>
    </article>
  );
}
