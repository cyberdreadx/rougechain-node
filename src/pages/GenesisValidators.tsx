import { Link } from "react-router-dom";
import { Atom, Award, Scale, Coins, Wrench, Vote, Shield, ArrowRight, Terminal } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Genesis Validators — recruitment page for RougeChain's founding independent
 * validator cohort. Honest by design: no yield promises, no fabricated mechanics.
 * Numbers marked EDIT are placeholders to finalize before promoting widely.
 */

const PERKS = [
  {
    icon: Award,
    tag: "Recognition",
    title: "Founding status, on-chain",
    body: "A permanent Genesis Validator badge, your node named on the network map, and a listed spot on the public validator leaderboard.",
  },
  {
    icon: Scale,
    tag: "Real weight",
    title: "A real stake, not a cameo",
    body: "Consensus weight comes from self-staked XRGE — so genesis validators receive a treasury XRGE grant to stake as their own, and the team steps its own stake down over time. Your vote and fee share actually count.",
  },
  {
    icon: Coins,
    tag: "Bootstrap grant",
    title: "Cover your costs",
    body: "A monthly XRGE grant for the first 6 months to cover server + gas while fees are thin. A bridge to real fee volume, not a salary.",
    edit: true,
  },
  {
    icon: Wrench,
    tag: "Support",
    title: "Direct onboarding help",
    body: "Hands-on setup, a private operator channel, and first look at upgrades. You won't be debugging alone.",
  },
  {
    icon: Vote,
    tag: "Voice",
    title: "A say in what's next",
    body: "Genesis validators get first input on the decisions that matter — including whether RougeChain adopts a sustainable staking emission.",
  },
  {
    icon: Atom,
    tag: "The mission",
    title: "Secure something that matters",
    body: "You'll run consensus on the first production L1 that's already post-quantum. That's the pitch. If it doesn't move you, this isn't for you — and that's fine.",
  },
];

const ASKS = [
  ["Stake", "Hold and stake at least 10,000 XRGE from your validator key — trivial to acquire; the barrier is commitment, not capital."],
  ["A real node", "A reachable node (1 vCPU / 1 GB / 5 GB is enough) with a public URL, kept online."],
  ["Uptime", "Target ≥ 95%. Missing 50 blocks auto-slashes, so treat it like infrastructure."],
  ["Key hygiene", "A dedicated validator key (never your treasury), backed up, and never run on two nodes at once — double-signing is slashable."],
  ["Independence", "You are not the founding team. The whole point is that you're someone else."],
  ["Commitment", "A 6-month run so the cohort is stable enough to mean something."],
];

const STEPS = [
  { t: "Apply", body: <>Tell us who you are and where you'll run.</> },
  { t: "Spin up a node", body: <>Follow the <a className="text-primary underline" href="https://docs.rougechain.io/staking/becoming-validator.html" target="_blank" rel="noopener noreferrer">validator guide</a> — it generates your identity key on first run.</> },
  { t: "Fund & stake it", body: <><code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">rougechain --node-keys &lt;path&gt; stake 10000</code> stakes the exact key your node signs blocks with.</> },
  { t: "Go live & verify", body: <>Run with <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">--mine</code>, then <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">validator-status</code> until every check reads ✓. We fund your stake grant, badge you, and you're in.</> },
];

export default function GenesisValidators() {
  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background text-foreground relative overflow-x-hidden">
      <div className="container mx-auto max-w-5xl px-4 py-10 md:py-14 space-y-14">

        {/* Hero */}
        <header className="space-y-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <span className="inline-block w-2 h-2 rounded-full bg-primary" />
            RougeChain · Validator Program
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-balance">
            Become a <span className="text-cyan-500">Genesis Validator</span> of the first post-quantum L1.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl leading-relaxed">
            RougeChain is live, quantum-resistant, and permissionless — but a network is only as
            decentralized as the people securing it. We're recruiting the founding cohort of
            independent validators. A call for operators, not speculators.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-border">
            {[
              ["Network", "mainnet-1 · live"],
              ["Cohort", "10 operators", true],
              ["Stake to join", "10,000 XRGE"],
              ["Signatures", "ML-DSA-65"],
            ].map(([k, v, edit]) => (
              <div key={k as string} className="flex flex-col gap-1">
                <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">{k}</span>
                <span className={`text-sm font-semibold ${edit ? "text-primary" : ""}`}>{v}</span>
              </div>
            ))}
          </div>
        </header>

        {/* Honest callout */}
        <Card className="border-amber-500/40 bg-gradient-to-b from-amber-500/10 to-transparent">
          <CardContent className="p-6 space-y-2">
            <div className="text-[0.68rem] font-semibold uppercase tracking-widest text-amber-500">Read this first — the honest part</div>
            <p className="text-base leading-relaxed max-w-3xl">
              Right now, validating RougeChain earns <strong>almost nothing</strong>: there's no token
              emission, the reward reserve is empty, and on a young chain fees are near zero.{" "}
              <strong>Don't join for yield.</strong> Join to be a founding operator of a chain built
              for the one thing every other chain is ignoring — the day quantum computers break
              today's cryptography. The economics come later, if the chain earns them. The role,
              recognition, and position are available now.
            </p>
          </CardContent>
        </Card>

        {/* What you get */}
        <section className="space-y-6">
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">What a Genesis Validator gets</h2>
          <p className="text-muted-foreground max-w-2xl -mt-2">
            No inflation was created to fund this — it runs on recognition, existing fee share, and
            treasury XRGE grants, not newly minted tokens.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PERKS.map((p) => (
              <Card key={p.title} className="border-border">
                <CardContent className="p-5 space-y-2">
                  <p.icon className="w-6 h-6 text-primary" />
                  <div className="text-[0.62rem] font-semibold uppercase tracking-widest text-cyan-500">{p.tag}</div>
                  <h3 className="font-bold text-base">{p.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{p.body}</p>
                  {p.edit && <div className="text-[0.65rem] text-primary font-semibold">↑ set grant amount per cohort</div>}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* What we ask */}
        <section className="space-y-6">
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">What we ask of you</h2>
          <Card className="border-border overflow-hidden">
            <CardContent className="p-0 divide-y divide-border">
              {ASKS.map(([k, v]) => (
                <div key={k} className="grid sm:grid-cols-[10rem_1fr] gap-1 sm:gap-4 p-4">
                  <span className="font-bold text-sm">{k}</span>
                  <span className="text-sm text-muted-foreground">{v}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        {/* How to join */}
        <section className="space-y-6">
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">How to join</h2>
          <div className="grid gap-4">
            {STEPS.map((s, i) => (
              <Card key={s.t} className="border-border">
                <CardContent className="p-5 flex gap-4 items-start">
                  <span className="flex-none w-8 h-8 rounded-full bg-primary text-primary-foreground font-extrabold text-sm flex items-center justify-center">{i + 1}</span>
                  <div>
                    <h3 className="font-bold text-base">{s.t}</h3>
                    <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{s.body}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="border-border bg-muted/30">
            <CardContent className="p-4 text-sm text-muted-foreground flex gap-3 items-start">
              <Terminal className="w-4 h-4 mt-0.5 flex-none text-primary" />
              <span>
                <strong className="text-foreground">FYI —</strong> the "no yield yet" reality is by design, not neglect.
                A sustainable staking <strong className="text-foreground">emission</strong> is on the table as a
                deliberate, holder-visible decision — and genesis validators help make that call.
              </span>
            </CardContent>
          </Card>
        </section>

        {/* CTA */}
        <Card className="border-primary/30 bg-gradient-to-b from-primary/10 to-transparent">
          <CardContent className="p-8 text-center space-y-3">
            <Shield className="w-8 h-8 text-primary mx-auto" />
            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">Secure the quantum-safe chain</h2>
            <p className="text-muted-foreground max-w-lg mx-auto">
              Ten operators. Real independence. The founding validator set of the first live
              post-quantum L1. If that's you, step up.
            </p>
            <div className="flex flex-wrap gap-3 justify-center pt-2">
              <Button asChild size="lg">
                <a href="https://docs.rougechain.io/staking/becoming-validator.html" target="_blank" rel="noopener noreferrer">
                  Start the validator guide <ArrowRight className="w-4 h-4 ml-1" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/validators">View validators</Link>
              </Button>
            </div>
            <p className="text-xs text-primary pt-1">↑ swap in your real application link, cohort size, grant amount &amp; dates before promoting</p>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
