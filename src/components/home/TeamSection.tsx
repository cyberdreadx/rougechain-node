import { Github, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { team, type TeamMember } from "@/data/team";

/* X (Twitter) glyph — lucide 0.462 has no X-logo icon; keep it as a tiny inline path. */
const XGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
    <path d="M18.244 2H21.5l-7.5 8.57L22.8 22h-6.9l-5.4-7.06L4.3 22H1.04l8.02-9.17L.6 2h7.08l4.88 6.45L18.24 2Zm-1.2 18.1h1.9L6.98 3.8H4.94l12.1 16.3Z" />
  </svg>
);

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");

const SocialLink = ({ href, label, children }: { href: string; label: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={label}
    title={label}
    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground motion-safe:transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
  >
    {children}
  </a>
);

const MemberCard = ({ m }: { m: TeamMember }) => {
  const { t } = useTranslation();
  const hasSocial = Boolean(m.x || m.github || m.website);
  return (
    <li className="group flex flex-col">
      {/* Photo: 4:5, restrained border, desaturated until hover (motion-safe only) */}
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-lg border border-border bg-muted/40 motion-safe:transition-colors group-hover:border-primary/40">
        {m.image ? (
          <img
            src={m.image}
            alt={t("home.team.photoAlt", { name: m.name })}
            loading="lazy"
            className="h-full w-full object-cover grayscale contrast-[1.05] motion-safe:transition-[filter] motion-safe:duration-500 group-hover:grayscale-0"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center font-mono text-2xl tracking-[0.2em] text-muted-foreground/60"
            aria-hidden="true"
          >
            {initials(m.name)}
          </div>
        )}
        {/* hairline corner marks — technical, not decorative frames */}
        <span aria-hidden="true" className="pointer-events-none absolute left-1.5 top-1.5 h-2 w-2 border-l border-t border-primary/40" />
        <span aria-hidden="true" className="pointer-events-none absolute bottom-1.5 right-1.5 h-2 w-2 border-b border-r border-primary/40" />
      </div>

      <div className="mt-3 flex flex-col gap-0.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary/80">{m.role}</span>
        <h3 className="text-lg font-semibold leading-tight text-foreground">{m.name}</h3>
        {m.alias && <span className="font-mono text-xs text-muted-foreground">{m.alias}</span>}
        {m.bio && <p className="mt-1 text-sm text-muted-foreground">{m.bio}</p>}
        {hasSocial && (
          <div className="mt-2 -ml-1.5 flex items-center gap-0.5">
            {m.x && <SocialLink href={m.x} label={t("home.team.social.x", { name: m.name })}><XGlyph className="h-3.5 w-3.5" /></SocialLink>}
            {m.github && <SocialLink href={m.github} label={t("home.team.social.github", { name: m.name })}><Github className="h-3.5 w-3.5" /></SocialLink>}
            {m.website && <SocialLink href={m.website} label={t("home.team.social.website", { name: m.name })}><Globe className="h-3.5 w-3.5" /></SocialLink>}
          </div>
        )}
      </div>
    </li>
  );
};

/**
 * Homepage TEAM section. Data lives in src/data/team.ts. Lattice motif = the site's own
 * `circuit-bg` grid, masked to near-invisibility; accent hues are the existing tokens.
 */
export const TeamSection = () => {
  const { t } = useTranslation();
  if (team.length === 0) return null;
  return (
    <section id="team" aria-labelledby="team-heading" className="relative mb-16 scroll-mt-20 rounded-2xl border border-border bg-card/40 p-6 sm:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl circuit-bg opacity-[0.07] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]"
      />
      <div className="relative">
        <div className="mb-8 max-w-xl">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent">{t("home.team.eyebrow")}</div>
          <h2 id="team-heading" className="mt-3 text-2xl font-bold text-balance text-foreground md:text-3xl">{t("home.team.title")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("home.team.subtitle")}</p>
        </div>
        <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          {team.map((m) => <MemberCard key={m.name} m={m} />)}
        </ul>
      </div>
    </section>
  );
};
