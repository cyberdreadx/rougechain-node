import { useEffect } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Sprout, Sun, Cpu, Palette, ArrowRight, MessageCircle, MapPin,
  Wallet, FolderCheck, Coins, Globe2, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ProjectCard from "@/components/regenerate/ProjectCard";
import {
  REGEN_CATEGORIES, getTreasuryStats, getProjects, hasFundedProjects, type RegenCategoryKey,
} from "@/lib/regenerate";

const PROPOSE_URL = "https://discord.gg/wZKsHfhXxm";

const CATEGORY_ICON: Record<RegenCategoryKey, typeof Sprout> = {
  ecology: Sprout,
  infrastructure: Sun,
  technology: Cpu,
  art: Palette,
};

/** Lightweight per-route SEO (the app is a Vite SPA with a static index.html).
 *  Sets the document title + description on mount and restores them on unmount.
 *  Full crawler coverage would need prerendering; this covers tabs/shares. */
function useRouteSeo(title: string, description: string) {
  useEffect(() => {
    const prevTitle = document.title;
    const metaDesc = document.querySelector('meta[name="description"]');
    const prevDesc = metaDesc?.getAttribute("content") ?? null;
    document.title = title;
    metaDesc?.setAttribute("content", description);
    return () => {
      document.title = prevTitle;
      if (metaDesc && prevDesc !== null) metaDesc.setAttribute("content", prevDesc);
    };
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
      {value !== null ? (
        <p className="text-2xl font-bold text-foreground tabular-nums">{value}</p>
      ) : (
        <p className="text-sm font-medium text-muted-foreground/70">Coming&nbsp;Soon</p>
      )}
    </div>
  );
}

export default function Regenerate() {
  useRouteSeo(
    "RougeChain Regenerate — Fund the future where you live",
    "RougeChain Regenerate is a transparent regeneration treasury funding measurable local projects — ecology, infrastructure, open technology, and community — starting in Tulum, Mexico.",
  );

  const treasury = getTreasuryStats();
  const projects = getProjects();
  const anyFunded = hasFundedProjects(projects);

  const fmt = (n: number | null, suffix = "") => (n == null ? null : `${n.toLocaleString()}${suffix}`);

  return (
    <div className="min-h-screen bg-background relative">
      {/* Subtle, restrained ambience — greens folded into the existing teal/purple system */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[820px] h-[520px] rounded-full bg-success/5 blur-3xl" />
        <div className="absolute top-1/3 -right-32 w-[420px] h-[420px] rounded-full bg-accent/5 blur-3xl" />
      </div>

      <main className="relative z-10 max-w-5xl mx-auto px-4 py-12">

        {/* 2 · Hero */}
        <motion.header initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-20">
          <span className="inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1 text-xs font-mono font-semibold uppercase tracking-[0.18em] text-success">
            <Sprout className="w-3.5 h-3.5" aria-hidden="true" /> RougeChain Regenerate
          </span>
          <h1 className="mt-5 text-4xl md:text-5xl font-bold text-balance">
            <span className="bg-gradient-to-r from-success via-primary to-accent bg-clip-text text-transparent">
              Fund the future
            </span>{" "}
            where you live.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base md:text-lg text-muted-foreground">
            RougeChain Regenerate connects digital infrastructure with real-world regeneration. We fund transparent,
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

        {/* 3 · Philosophy */}
        <motion.section {...fadeUp} className="mb-20 max-w-3xl mx-auto text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground text-balance">
            Technology should improve the territory it touches.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Global problems are real, but change becomes tangible at the local level. RougeChain Regenerate begins with
            communities, ecosystems, and infrastructure we can actually see, measure, and improve.
          </p>
        </motion.section>

        {/* 4 · Categories */}
        <motion.section {...fadeUp} className="mb-20">
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

        {/* 5 · First Territory: Tulum */}
        <motion.section {...fadeUp} className="mb-20">
          <div className="rounded-3xl border border-border bg-gradient-to-br from-success/8 via-card to-accent/8 p-8 md:p-10">
            <span className="inline-flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-[0.16em] text-success">
              <MapPin className="w-4 h-4" aria-hidden="true" /> First Territory: Tulum
            </span>
            <p className="mt-4 max-w-3xl text-lg text-foreground/90 leading-relaxed">
              Regeneration should begin somewhere real. RougeChain Regenerate will begin by exploring projects in
              <span className="font-semibold text-foreground"> Tulum, Mexico</span>, where technology, ecology, culture
              and rapid development intersect.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">Exploring projects — nothing funded yet.</p>
          </div>
        </motion.section>

        {/* 6 · Treasury dashboard */}
        <motion.section {...fadeUp} className="mb-20">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-xl font-bold text-foreground">Regeneration Treasury</h2>
            <span className="text-xs text-muted-foreground">On-chain values connect here as the treasury goes live</span>
          </div>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <TreasuryStat icon={Wallet} label="Treasury Balance" value={fmt(treasury.balanceXrge, " XRGE")} />
            <TreasuryStat icon={FolderCheck} label="Projects Funded" value={fmt(treasury.projectsFunded)} />
            <TreasuryStat icon={Coins} label="Total Deployed" value={fmt(treasury.totalDeployedXrge, " XRGE")} />
            <TreasuryStat icon={Globe2} label="Active Territories" value={fmt(treasury.activeTerritories)} />
          </div>
        </motion.section>

        {/* 7 · Projects */}
        <motion.section {...fadeUp} id="projects" className="mb-20 scroll-mt-20">
          <h2 className="text-xl font-bold text-foreground mb-1">Projects</h2>
          {!anyFunded && (
            <p className="mb-5 text-sm text-muted-foreground">
              Illustrative candidate proposals — <span className="text-foreground">no projects funded yet</span>. Cards
              will populate from real proposals and on-chain records as the pipeline opens.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
          </div>
        </motion.section>

        {/* 8 · Proof of Impact */}
        <motion.section {...fadeUp} className="mb-8">
          <div className="rounded-3xl border border-border bg-card p-8 md:p-10">
            <span className="inline-flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-[0.16em] text-primary">
              <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Proof of Impact
            </span>
            <p className="mt-4 max-w-3xl text-muted-foreground leading-relaxed">
              Every funded project should eventually have a permanent impact record: where funding went, what was
              promised, what was completed, and evidence of the result.
            </p>
            <ol className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-3">
              {["Project", "Location", "Funding", "Milestones", "Evidence", "Verification"].map((step, i, arr) => (
                <li key={step} className="flex items-center gap-2">
                  <span className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground">
                    {step}
                  </span>
                  {i < arr.length - 1 && <ArrowRight className="w-4 h-4 text-muted-foreground/60" aria-hidden="true" />}
                </li>
              ))}
            </ol>
          </div>
        </motion.section>
      </main>
    </div>
  );
}
