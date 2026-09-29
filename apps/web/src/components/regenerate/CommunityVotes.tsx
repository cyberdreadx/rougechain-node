import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Vote, Loader2, CheckCircle2, XCircle, MinusCircle, ExternalLink, Hash, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useRougeAddress } from "@/hooks/useRougeAddress";
import { txUrl } from "@/lib/regenerate";
import { formatAddress } from "@/lib/address";
import {
  castVote, currentVoter, getVoteConfig, getVoterWeight, listVoteProposals, openProposal, recordPayout, timeLeft,
  type RegenVoteConfig, type VoteChoice, type VoteEntry, type VoterWeight,
} from "@/lib/regen-votes";

const STATUS: Record<VoteEntry["status"], { label: string; cls: string }> = {
  open: { label: "Voting open", cls: "text-success border-success/30 bg-success/10" },
  passed: { label: "Passed · awaiting payout", cls: "text-primary border-primary/30 bg-primary/10" },
  paid: { label: "Passed · paid", cls: "text-success border-success/40 bg-success/15" },
  failed: { label: "Did not pass", cls: "text-muted-foreground border-border bg-muted/40" },
  cancelled: { label: "Cancelled", cls: "text-muted-foreground border-border bg-muted/40" },
};

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

function Bar({ s }: { s: VoteEntry["summaryXrge"] }) {
  const total = s.yes + s.no + s.abstain;
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-foreground/[0.06]" role="img"
        aria-label={`Yes ${fmt(s.yes)}, no ${fmt(s.no)}, abstain ${fmt(s.abstain)} XRGE`}>
        <div className="bg-success" style={{ width: `${pct(s.yes, total)}%` }} />
        <div className="bg-destructive" style={{ width: `${pct(s.no, total)}%` }} />
        <div className="bg-muted-foreground/50" style={{ width: `${pct(s.abstain, total)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span><span className="text-success">Yes</span> {fmt(s.yes)}</span>
        <span><span className="text-destructive">No</span> {fmt(s.no)}</span>
        <span>Abstain {fmt(s.abstain)}</span>
        <span className="ml-auto">
          Turnout {fmt(s.turnout)} / {fmt(s.turnoutNeeded)} needed
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
        <div className="h-full bg-primary/70" style={{ width: `${pct(s.turnout, s.turnoutNeeded)}%` }} />
      </div>
    </div>
  );
}

function ProposalRow({ e, isCurator, onChanged }: { e: VoteEntry; isCurator: boolean; onChanged: () => void }) {
  const p = e.proposal;
  const voter = currentVoter();
  const [weight, setWeight] = useState<VoterWeight | null>(null);
  const [busy, setBusy] = useState<VoteChoice | "payout" | null>(null);
  const [payoutTx, setPayoutTx] = useState("");
  // Recipients are already rouge1 addresses: format, don't re-derive.
  const recipientShort = p.recipient ? formatAddress(p.recipient) : "";

  useEffect(() => {
    if (!voter || e.status !== "open") return;
    let on = true;
    getVoterWeight(p.id, voter.publicKey).then((w) => { if (on) setWeight(w); });
    return () => { on = false; };
  }, [p.id, e.status, voter?.publicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const vote = async (c: VoteChoice) => {
    setBusy(c);
    try {
      await castVote(p.id, c);
      toast.success(`Vote recorded: ${c}`);
      setWeight((w) => (w ? { ...w, vote: c } : w));
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const payout = async () => {
    setBusy("payout");
    try {
      await recordPayout(p.id, payoutTx.trim());
      toast.success("Payout recorded");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{p.id}{p.territory ? ` · ${p.territory}` : ""}</p>
          <h3 className="mt-1 text-lg font-semibold text-foreground">{p.title}</h3>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS[e.status].cls}`}>
          {STATUS[e.status].label}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed whitespace-pre-line">{p.summary}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {p.requestedXrge ? <span>Requests <span className="text-foreground">{fmt(p.requestedXrge)} XRGE</span></span> : null}
        {p.recipient ? <span>To <span className="font-mono text-foreground">{recipientShort}</span></span> : null}
        <span>{e.status === "open" ? timeLeft(p.endsAtMs) : `Closed ${new Date(p.endsAtMs).toLocaleDateString()}`}</span>
        <span>{e.tally.voters} voter{e.tally.voters === 1 ? "" : "s"} · snapshot at block {p.snapshotHeight}</span>
        {p.link ? (
          <a href={p.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            Details <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <div className="mt-4"><Bar s={e.summaryXrge} /></div>

      {e.status === "open" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!voter ? (
            <p className="text-sm text-muted-foreground">Connect a wallet to vote.</p>
          ) : weight && !weight.eligible ? (
            <p className="text-sm text-muted-foreground">
              {weight.excluded
                ? "This wallet is a team, treasury or exchange wallet, so it can't vote."
                : "This wallet held no XRGE when the vote opened, so it has no vote on this proposal."}
            </p>
          ) : (
            <>
              {(["yes", "no", "abstain"] as VoteChoice[]).map((c) => {
                const Icon = c === "yes" ? CheckCircle2 : c === "no" ? XCircle : MinusCircle;
                const mine = weight?.vote === c;
                return (
                  <Button key={c} size="sm" variant={mine ? "default" : "outline"} disabled={!!busy} onClick={() => vote(c)} className="gap-1.5 capitalize">
                    {busy === c ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Icon className="w-4 h-4" aria-hidden="true" />}
                    {c}
                  </Button>
                );
              })}
              {weight && (
                <span className="text-xs text-muted-foreground ml-1">
                  Your weight {fmt(weight.weightXrge)} XRGE{weight.vote ? ` · you voted ${weight.vote} (you can change it)` : ""}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {e.status === "paid" && p.payoutTxId && (
        <p className="mt-4 flex items-center gap-2 text-sm text-success">
          Paid {p.payoutXrge != null ? `${fmt(p.payoutXrge)} XRGE` : ""} from the treasury
          <Link to={txUrl(p.payoutTxId)} className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
            <Hash className="w-3 h-3" aria-hidden="true" />{p.payoutTxId.slice(0, 10)}…
          </Link>
        </p>
      )}

      {e.status === "passed" && isCurator && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Input value={payoutTx} onChange={(ev) => setPayoutTx(ev.target.value)} placeholder="Treasury payment tx id" className="max-w-md font-mono text-xs" />
          <Button size="sm" disabled={!payoutTx.trim() || busy === "payout"} onClick={payout}>
            {busy === "payout" ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Record payout
          </Button>
        </div>
      )}
    </article>
  );
}

function OpenProposalForm({ config, onCreated }: { config: RegenVoteConfig; onCreated: () => void }) {
  const [f, setF] = useState({ title: "", summary: "", territory: "Tulum", recipient: "", requested: "", link: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await openProposal({
        title: f.title.trim(), summary: f.summary.trim(), territory: f.territory.trim() || undefined,
        recipient: f.recipient.trim() || undefined, link: f.link.trim() || undefined,
        requestedXrge: f.requested ? Number(f.requested) : undefined,
      });
      toast.success("Proposal opened for voting");
      setF({ title: "", summary: "", territory: "Tulum", recipient: "", requested: "", link: "" });
      onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 rounded-2xl border border-border bg-card p-5">
      <p className="sm:col-span-2 text-sm text-muted-foreground">
        Opening a proposal snapshots every eligible balance now; voting runs {config.defaultDays} days. Needs curator
        rights or {fmt(config.minCreatorXrge)} XRGE.
      </p>
      <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="op-title">Title</Label><Input id="op-title" required maxLength={120} value={f.title} onChange={set("title")} /></div>
      <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="op-sum">Summary</Label><Textarea id="op-sum" required maxLength={4000} rows={4} value={f.summary} onChange={set("summary")} /></div>
      <div className="space-y-1.5"><Label htmlFor="op-terr">Territory</Label><Input id="op-terr" maxLength={80} value={f.territory} onChange={set("territory")} /></div>
      <div className="space-y-1.5"><Label htmlFor="op-req">Requested XRGE</Label><Input id="op-req" inputMode="decimal" value={f.requested} onChange={(e) => setF((s) => ({ ...s, requested: e.target.value.replace(/[^0-9.]/g, "") }))} /></div>
      <div className="space-y-1.5"><Label htmlFor="op-rec">Recipient (rouge1…)</Label><Input id="op-rec" className="font-mono" maxLength={120} value={f.recipient} onChange={set("recipient")} /></div>
      <div className="space-y-1.5"><Label htmlFor="op-link">Details link (https://)</Label><Input id="op-link" maxLength={500} value={f.link} onChange={set("link")} /></div>
      <div className="sm:col-span-2"><Button type="submit" disabled={busy} className="gap-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} Open for voting</Button></div>
    </form>
  );
}

/**
 * Community votes on Regenerate proposals. Renders nothing when the node doesn't
 * serve votes yet, so the page never shows a broken section.
 */
export default function CommunityVotes() {
  const [config, setConfig] = useState<RegenVoteConfig | null>(null);
  const [entries, setEntries] = useState<VoteEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const voter = currentVoter();
  const { full: voterAddress } = useRougeAddress(voter?.publicKey ?? null);

  const load = useCallback(async () => {
    const [c, e] = await Promise.all([getVoteConfig(), listVoteProposals()]);
    setConfig(c);
    setEntries(e);
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  const isCurator = useMemo(() => !!(voterAddress && config?.curators.includes(voterAddress)), [voterAddress, config]);

  if (!loaded || !config || !entries) return null;

  return (
    <section id="votes" className="mb-24 scroll-mt-20">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-2">
        <div>
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2"><Vote className="w-5 h-5 text-success" aria-hidden="true" /> Community votes</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            XRGE holders decide which projects the treasury funds. Weight is your balance when a vote opens, capped at{" "}
            {config.capBps / 100}% of eligible supply; team, treasury and exchange wallets don't vote. A proposal passes with{" "}
            {config.turnoutBps / 100}% turnout and more yes than no.
          </p>
        </div>
        {voter && (
          <Button variant="outline" size="sm" onClick={() => setShowOpen((v) => !v)} className="gap-1.5">
            <Plus className="w-4 h-4" aria-hidden="true" /> Open a proposal
          </Button>
        )}
      </div>
      <p className="mb-5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="w-3.5 h-3.5 text-success" aria-hidden="true" />
        Every vote is signed by the voter's wallet and published with its signature, so anyone can recount.
      </p>

      {showOpen && <div className="mb-4"><OpenProposalForm config={config} onCreated={() => { setShowOpen(false); load(); }} /></div>}

      {entries.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
          No proposals yet. Accepted project submissions are opened for a community vote here.
        </p>
      ) : (
        <div className="grid gap-4">
          {entries.map((e) => <ProposalRow key={e.proposal.id} e={e} isCurator={isCurator} onChanged={load} />)}
        </div>
      )}
    </section>
  );
}
