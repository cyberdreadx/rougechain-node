import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Sprout, Sun, Cpu, Palette, ArrowRight, MessageCircle, MapPin,
  Wallet, FolderCheck, Coins, Globe2, FileText, ListChecks, Camera, BadgeCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ProjectCard from "@/components/regenerate/ProjectCard";
import {
  REGEN_CATEGORIES, getTreasuryStats, getProjects, hasFundedProjects,
  type RegenCategoryKey, type TreasuryStats,
} from "@/lib/regenerate";

const PROPOSE_URL = "https://discord.gg/wZKsHfhXxm";

const CATEGORY_ICON: Record<RegenCategoryKey, typeof Sprout> = {
  ecology: Sprout, infrastructure: Sun, technology: Cpu, art: Palette,
};

/** Per-route SEO (SPA-safe): set title/description on mount, restore on unmount. */
function useRouteSeo(title: string, description: string) {
  useEffect(() => {
    const prevTitle = document.title;
    const meta = document.querySelector('meta[name="description"]');
    const prevDesc = meta?.getAttribute("content") ?? null;
    document.title = title;
    meta?.setAttribute("content", description);
    return () => { document.title = prevTitle; if (meta && prevDesc !== null) meta.setAttribute("content", prevDesc); };
  }, [title, description]);
}

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.5 },
};

function TreasuryStat({ icon: Icon, label, value }: { icon: typeof Wallet; label: string; value: string | null }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3 text-muted-foreground">
        <Icon className="w-4 h-4 text-success" aria-hidden="true" />
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      {value !== null
        ? <p className="text-2xl font-bold text-foreground tabular-nums">{value}</p>
        : <p className="text-sm font-medium text-muted-foreground/70">Coming&nbsp;Soon</p>}
    </div>
  );
}

const PROTOCOL_STEPS = [
  { icon: FileText, label: "Project" },
  { icon: MapPin, label: "Location" },
  { icon: Coins, label: "Funding" },
  { icon: ListChecks, label: "Milestones" },
  { icon: Camera, label: "Evidence" },
  { icon: BadgeCheck, label: "Verification" },
];

export default function Regenerate() {
  useRouteSeo(
    "RougeChain Regenerate — Fund the future where you live",
    "RougeChain Regenerate is a regeneration program and treasury on RougeChain, funding transparent, measurable local projects — starting in Tulum, Mexico.",
  );

  const [treasury, setTreasury] = useState<TreasuryStats>({
    balanceXrge: null, projectsFunded: null, totalDeployedXrge: null, activeTerritories: null,
  });
  useEffect(() => {
    let active = true;
    getTreasuryStats().then((t) => { if (active) setTreasury(t); });
    return () => { active = false; };
  }, []);
  const projects = getProjects();
  const anyFunded = hasFundedProjects(projects);
  const fmt = (n: number | null, suffix = "") => (n == null ? null : `${n.toLocaleString()}${suffix}`);

  return (
    <div className="min-h-screen bg-background relative">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[820px] h-[520px] rounded-full bg-success/5 blur-3xl" />
        <div className="absolute top-1/2 -right-32 w-[420px] h-[420px] rounded-full bg-accent/5 blur-3xl" />
      </div>

      <main className="relative z-10 max-w-5xl mx-auto px-4 py-12">

        {/* Hero — named program */}
        <motion.header initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-14">
          <div className="inline-flex items-center gap-3 text-xs font-mono uppercase tracking-[0.22em] text-muted-foreground">
            <span className="h-px w-8 bg-success/50" />
            <span className="flex items-center gap-1.5 text-success"><Sprout className="w-3.5 h-3.5" aria-hidden="true" /> RougeChain Regenerate</span>
            <span className="h-px w-8 bg-success/50" />
          </div>
          <p className="mt-3 text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground/70">
            A regeneration program &amp; treasury on RougeChain
          </p>
          <h1 className="mt-5 text-4xl md:text-6xl font-bold text-balance">
            <span className="bg-gradient-to-r from-success via-primary to-accent bg-clip-text text-transparent">Fund the future</span>{" "}
            where you live.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base md:text-lg text-muted-foreground">
            RougeChain Regenerate connects digital infrastructure with real-world regeneration — funding transparent,
            measurable projects that improve the communities and ecosystems around us.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="#projects">
              <Button size="lg" className="gap-2 bg-success hover:bg-success/90 text-background font-semibold">
                <FolderCheck className="w-5 h-5" aria-hidden="true" /> View Projects
              </Button>
            </a>
            <a href={PROPOSE_URL} target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="gap-2 border-success/50 text-success hover:bg-success/10">
                <MessageCircle className="w-5 h-5" aria-hidden="true" /> Propose a Project
              </Button>
            </a>
          </div>
        </motion.header>

        {/* Statement — the strongest line, high on the page */}
        <motion.section {...fadeUp} className="mb-24">
          <div className="mx-auto max-w-4xl text-center border-y border-border py-12">
            <h2 className="text-3xl md:text-5xl font-bold leading-[1.1] text-balance">
              Technology should improve the<br className="hidden md:block" />{" "}
              <span className="text-success">territory it touches.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-muted-foreground leading-relaxed">
              Global problems are real, but change becomes tangible at the local level. RougeChain Regenerate begins with
              communities, ecosystems, and infrastructure we can actually see, measure, and improve.
            </p>
            <p className="mx-auto mt-6 max-w-2xl text-sm text-muted-foreground/85 leading-relaxed">
              A <span className="text-success font-medium">solarpunk</span> stance: technology, architecture, art and
              community building a future worth living in — not just one that survives.
            </p>
          </div>
        </motion.section>

        {/* Categories */}
        <motion.section {...fadeUp} className="mb-24">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {REGEN_CATEGORIES.map((c) => {
              const Icon = CATEGORY_ICON[c.key];
              return (
                <div key={c.key} className="rounded-2xl border border-border bg-card p-5 hover:border-success/40 transition-colors">
                  <div className="w-11 h-11 rounded-xl bg-success/10 border border-success/20 flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-success" aria-hidden="true" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">{c.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{c.blurb}</p>
                </div>
              );
            })}
          </div>
        </motion.section>

        {/* First Territory: Tulum — visually unmistakable */}
        <motion.section {...fadeUp} className="mb-24">
          <div className="relative overflow-hidden rounded-3xl border border-success/25 bg-gradient-to-br from-success/10 via-card to-accent/8">
            {/* survey-grid motif — infrastructure, not decoration */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.10]"
              style={{ backgroundImage: "linear-gradient(hsl(var(--success)/0.5) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--success)/0.5) 1px, transparent 1px)", backgroundSize: "44px 44px" }}
              aria-hidden="true"
            />
            <div className="relative p-8 md:p-12">
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-success">
                <MapPin className="w-4 h-4" aria-hidden="true" /> First Territory
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-2">
                <h2 className="text-5xl md:text-7xl font-bold tracking-tight text-foreground">TULUM</h2>
                <span className="pb-2 font-mono text-sm text-muted-foreground">20.2114° N · 87.4654° W · Quintana Roo, MX</span>
              </div>
              <p className="mt-6 max-w-3xl text-lg text-foreground/90 leading-relaxed">
                Regeneration should begin somewhere real. RougeChain Regenerate will begin by exploring projects in Tulum,
                where technology, ecology, culture and rapid development intersect.
              </p>
              <p className="mt-3 text-sm text-muted-foreground">Exploring projects — nothing funded yet.</p>
            </div>
          </div>
        </motion.section>

        {/* Treasury & Impact */}
        <motion.section {...fadeUp} className="mb-24">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-xl font-bold text-foreground">Treasury &amp; Impact</h2>
            <span className="text-xs text-muted-foreground">Live on-chain values connect here as the treasury goes live</span>
          </div>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <TreasuryStat icon={Wallet} label="Treasury Balance" value={fmt(treasury.balanceXrge, " XRGE")} />
            <TreasuryStat icon={FolderCheck} label="Projects Funded" value={fmt(treasury.projectsFunded)} />
            <TreasuryStat icon={Coins} label="Total Deployed" value={fmt(treasury.totalDeployedXrge, " XRGE")} />
            <TreasuryStat icon={Globe2} label="Active Territories" value={fmt(treasury.activeTerritories)} />
          </div>
        </motion.section>

        {/* Proof of Impact — protocol flow */}
        <motion.section {...fadeUp} className="mb-24">
          <div className="rounded-3xl border border-border bg-card p-8 md:p-10">
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-primary">
              <BadgeCheck className="w-4 h-4" aria-hidden="true" /> Proof of Impact
            </div>
            <p className="mt-4 max-w-3xl text-muted-foreground leading-relaxed">
              Every funded project carries a permanent, on-chain impact record — where funding went, what was promised,
              what was completed, and evidence of the result. Not charity branding: a protocol.
            </p>
            <ol className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {PROTOCOL_STEPS.map((s, i) => (
                <li key={s.label} className="relative flex flex-col items-center text-center">
                  {i < PROTOCOL_STEPS.length - 1 && (
                    <span className="hidden lg:block absolute top-6 left-1/2 w-full h-px bg-border" aria-hidden="true" />
                  )}
                  <span className="relative z-10 flex items-center justify-center w-12 h-12 rounded-xl border border-border bg-background text-primary">
                    <s.icon className="w-5 h-5" aria-hidden="true" />
                  </span>
                  <span className="mt-2 text-[11px] font-mono text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-sm font-medium text-foreground">{s.label}</span>
                </li>
              ))}
            </ol>
          </div>
        </motion.section>

        {/* Projects */}
        <motion.section {...fadeUp} id="projects" className="mb-24 scroll-mt-20">
          <h2 className="text-xl font-bold text-foreground mb-1">Projects</h2>
          {!anyFunded && (
            <p className="mb-5 text-sm text-muted-foreground">
              Illustrative candidate proposals — <span className="text-foreground">no projects funded yet</span>. Cards
              populate from real proposals and on-chain records as the pipeline opens.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
          </div>
        </motion.section>

        {/* Propose CTA */}
        <motion.section {...fadeUp} className="mb-8">
          <div className="rounded-3xl border border-success/25 bg-gradient-to-r from-success/10 via-card to-accent/8 p-8 md:p-10 text-center">
            <h2 className="text-2xl md:text-3xl font-bold text-foreground text-balance">Have a project for the territory?</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
              We're building the first territory in Tulum. If you're working on local ecology, infrastructure, open
              technology, or community — bring it forward.
            </p>
            <div className="mt-7">
              <a href={PROPOSE_URL} target="_blank" rel="noopener noreferrer">
                <Button size="lg" className="gap-2 bg-success hover:bg-success/90 text-background font-semibold">
                  <MessageCircle className="w-5 h-5" aria-hidden="true" /> Propose a Project <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </Button>
              </a>
            </div>
          </div>
        </motion.section>
      </main>
    </div>
  );
}
