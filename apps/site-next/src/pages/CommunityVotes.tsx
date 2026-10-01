import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, ShieldCheck } from "lucide-react";
import { Button, Dialog } from "@rougechain/ui";
import { formatAddress, formatIdentity } from "@rougechain/core/address";
import { getNetworkLabel } from "@rougechain/core/network";
import { txUrl } from "@rougechain/core/regenerate";
import {
  castVote,
  getVoteConfig,
  getVoterWeight,
  listVoteProposals,
  openProposal,
  recordPayout,
  type RegenVoteConfig,
  type VoteChoice,
  type VoteEntry,
} from "@rougechain/core/regen-votes";
import { useChain } from "../explorer/chain";
import { useRougeAddress } from "../wallet/hooks";
import { useWallet } from "../wallet/WalletProvider";
import { toast } from "../wallet/toast";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { fmtDate, fmtNum } from "../i18n/format";
import { useNetworkLabel } from "./common";

/** Vote weights / requested amounts are display figures here (nothing typed back or signed as an amount). */
const fmt = (n: number) => fmtNum(n, 2);

/** core's timeLeft(), in the current language. */
function timeLeftText(t: TFunction, endsAtMs: number, now = Date.now()): string {
  const ms = endsAtMs - now;
  if (ms <= 0) return t("votes.timeLeftClosed");
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return t("votes.timeLeftDays", { count: Math.floor(h / 24) });
  if (h >= 1) return t("votes.timeLeftHours", { count: h });
  return t("votes.timeLeftMinutes", { count: Math.max(1, Math.floor(ms / 60_000)) });
}
const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);
const CHOICES: VoteChoice[] = ["yes", "no", "abstain"];
const STATUS_CLASS: Record<string, string> = { open: "live", passed: "warning", paid: "live", failed: "loading", cancelled: "loading" };

function Tally({ s }: { s: VoteEntry["summaryXrge"] }) {
  const { t } = useTranslation("pages");
  const total = s.yes + s.no + s.abstain;
  return (
    <div className="rc-tally">
      <div className="rc-tally-bar" role="img" aria-label={t("votes.tallyLabel", { yes: fmt(s.yes), no: fmt(s.no), abstain: fmt(s.abstain) })}>
        <span className="yes" style={{ width: `${pct(s.yes, total)}%` }} />
        <span className="no" style={{ width: `${pct(s.no, total)}%` }} />
        <span className="abstain" style={{ width: `${pct(s.abstain, total)}%` }} />
      </div>
      <div className="rc-tally-legend mono">
        <span className="yes">
          {t("votes.choice.yes")} {fmt(s.yes)}
        </span>
        <span className="no">
          {t("votes.choice.no")} {fmt(s.no)}
        </span>
        <span>
          {t("votes.choice.abstain")} {fmt(s.abstain)}
        </span>
        <span className="rc-push">{t("votes.turnout", { have: fmt(s.turnout), need: fmt(s.turnoutNeeded) })}</span>
      </div>
      <div className="rc-bar thin">
        <span style={{ width: `${pct(s.turnout, s.turnoutNeeded)}%` }} />
      </div>
    </div>
  );
}

function ProposalRow({ e, isCurator, onChanged }: { e: VoteEntry; isCurator: boolean; onChanged: () => void }) {
  const { t } = useTranslation("pages");
  const networkLabel = useNetworkLabel();
  const p = e.proposal;
  const { network } = useChain();
  const w = useWallet();
  const voterKey = w.status === "unlocked" ? (w.wallet?.signingPublicKey ?? null) : null;
  const weight = useQuery({
    queryKey: ["pages", "regen-weight", network, p.id, voterKey],
    queryFn: () => getVoterWeight(p.id, voterKey!),
    enabled: !!voterKey && e.status === "open",
    retry: 1,
  });
  const [review, setReview] = useState<VoteChoice | null>(null);
  const [busy, setBusy] = useState<VoteChoice | "payout" | null>(null);
  const [payoutTx, setPayoutTx] = useState("");
  const qc = useQueryClient();

  const vote = async (c: VoteChoice) => {
    setBusy(c);
    try {
      await castVote(p.id, c);
      toast.success(t("votes.recorded", { choice: t(`votes.choiceLower.${c}`) }));
      setReview(null);
      void qc.invalidateQueries({ queryKey: ["pages", "regen-weight", network, p.id] });
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
      toast.success(t("votes.payoutRecorded"));
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const wt = weight.data;

  return (
    <article className="surface rc-proposal">
      <div className="panel-head">
        <div>
          <p className="mono muted">
            {p.id}
            {p.territory ? ` · ${p.territory}` : ""}
          </p>
          <h3>{p.title}</h3>
        </div>
        <span className={`status ${STATUS_CLASS[e.status] ?? "loading"}`}>{t(`votes.status.${e.status}`, { defaultValue: e.status })}</span>
      </div>
      <p className="rc-pre">{p.summary}</p>
      <p className="rc-meta">
        {p.requestedXrge ? (
          <span>
            {t("votes.requests")} <strong>{fmt(p.requestedXrge)} XRGE</strong>
          </span>
        ) : null}
        {p.recipient ? (
          <span>
            {t("votes.to")} <span className="mono">{formatAddress(p.recipient)}</span>
          </span>
        ) : null}
        <span>{e.status === "open" ? timeLeftText(t, p.endsAtMs) : t("votes.closed", { date: fmtDate(p.endsAtMs) })}</span>
        <span>{t("votes.voters", { count: e.tally.voters, height: p.snapshotHeight })}</span>
        {p.link && /^https:\/\//.test(p.link) ? (
          <a className="text-link inline" href={p.link} target="_blank" rel="noopener noreferrer">
            {t("votes.details")} <ExternalLink size={11} />
          </a>
        ) : null}
      </p>
      <Tally s={e.summaryXrge} />

      {e.status === "open" && (
        <div className="actions rc-vote-actions">
          {w.status === "locked" ? (
            <p className="form-hint">{t("votes.locked")}</p>
          ) : !voterKey ? (
            <p className="form-hint">{t("votes.connect")}</p>
          ) : wt && !wt.eligible ? (
            <p className="form-hint">{wt.excluded ? t("votes.excluded") : t("votes.noWeight")}</p>
          ) : (
            <>
              {CHOICES.map((c) => (
                <Button key={c} variant={wt?.vote === c ? "small" : "outline small"} disabled={!!busy} onClick={() => setReview(c)} aria-pressed={wt?.vote === c}>
                  {t(`votes.choice.${c}`)}
                </Button>
              ))}
              {wt && (
                <span className="form-hint">
                  {wt.vote
                    ? t("votes.weightVoted", { weight: fmt(wt.weightXrge), vote: t(`votes.choiceLower.${wt.vote}`) })
                    : t("votes.weight", { weight: fmt(wt.weightXrge) })}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {e.status === "paid" && p.payoutTxId && (
        <p className="form-hint">
          {t("votes.paidFrom", { amount: p.payoutXrge != null ? `${fmt(p.payoutXrge)} XRGE` : "" })}{" "}
          <Link className="mono" to={txUrl(p.payoutTxId)}>
            #{p.payoutTxId.slice(0, 10)}…
          </Link>
        </p>
      )}

      {e.status === "passed" && isCurator && (
        <div className="field-row">
          <input className="input mono" value={payoutTx} onChange={(ev) => setPayoutTx(ev.target.value)} placeholder={t("votes.payoutPh")} aria-label={t("votes.payoutPh")} />
          <Button variant="small" disabled={!payoutTx.trim() || busy === "payout"} onClick={payout}>
            {t("votes.recordPayout")}
          </Button>
        </div>
      )}

      {review && voterKey && (
        <Dialog open onClose={() => busy === null && setReview(null)} title={t("votes.reviewTitle")}>
          <div className="wallet-form">
            <dl className="review-list">
              <div>
                <dt>{t("votes.reviewRows.proposal")}</dt>
                <dd>{p.title}</dd>
              </div>
              <div>
                <dt>{t("votes.reviewRows.choice")}</dt>
                <dd>{t(`votes.choice.${review}`)}</dd>
              </div>
              <div>
                <dt>{t("votes.reviewRows.weight")}</dt>
                <dd className="mono">{wt ? `${fmt(wt.weightXrge)} XRGE` : "—"}</dd>
              </div>
              <div>
                <dt>{t("votes.reviewRows.voter")}</dt>
                <dd className="mono">{formatIdentity(voterKey)}</dd>
              </div>
              <div>
                <dt>{t("votes.reviewRows.network")}</dt>
                <dd>{networkLabel(getNetworkLabel())}</dd>
              </div>
            </dl>
            <p className="form-hint">{t("votes.reviewNote")}</p>
            <div className="actions">
              <Button variant="outline" onClick={() => setReview(null)} disabled={busy !== null}>
                {t("votes.cancel")}
              </Button>
              <Button onClick={() => void vote(review)} disabled={busy !== null}>
                {busy ? "…" : t("votes.sign")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </article>
  );
}

function OpenProposalForm({ config, onCreated }: { config: RegenVoteConfig; onCreated: () => void }) {
  const { t } = useTranslation("pages");
  const empty = { title: "", summary: "", territory: "Tulum", recipient: "", requested: "", link: "" };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await openProposal({
        title: f.title.trim(),
        summary: f.summary.trim(),
        territory: f.territory.trim() || undefined,
        recipient: f.recipient.trim() || undefined,
        link: f.link.trim() || undefined,
        requestedXrge: f.requested ? Number(f.requested) : undefined,
      });
      toast.success(t("votes.form.opened"));
      setF(empty);
      onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="surface wallet-form rc-open-form">
      <p className="form-hint">{t("votes.form.intro", { days: config.defaultDays, min: fmt(config.minCreatorXrge) })}</p>
      <label className="field">
        {t("votes.form.title")}
        <input className="input" required maxLength={120} value={f.title} onChange={set("title")} />
      </label>
      <label className="field">
        {t("votes.form.summary")}
        <textarea className="input" required maxLength={4000} rows={4} value={f.summary} onChange={set("summary")} />
      </label>
      <div className="two-fields">
        <label className="field">
          {t("votes.form.territory")}
          <input className="input" maxLength={80} value={f.territory} onChange={set("territory")} />
        </label>
        <label className="field">
          {t("votes.form.requested")}
          <input
            className="input mono"
            inputMode="decimal"
            value={f.requested}
            onChange={(e) => setF((s) => ({ ...s, requested: e.target.value.replace(/[^0-9.]/g, "") }))}
          />
        </label>
      </div>
      <label className="field">
        {t("votes.form.recipient")}
        <input className="input mono" maxLength={120} value={f.recipient} onChange={set("recipient")} />
      </label>
      <label className="field">
        {t("votes.form.link")}
        <input className="input" maxLength={500} value={f.link} onChange={set("link")} />
      </label>
      <Button type="submit" disabled={busy}>
        <Plus size={15} /> {t("votes.form.submit")}
      </Button>
    </form>
  );
}

/**
 * Community votes on Regenerate proposals (core regen-votes: GET /regen/config, /regen/proposals,
 * /regen/proposals/:id/weight/:who; signed POST /v2/regen/votes, /v2/regen/proposals,
 * /v2/regen/proposals/payout). Unlike apps/web (which hides the section when the node doesn't
 * serve votes), this says so, so the state is never ambiguous.
 */
export default function CommunityVotes() {
  const { t } = useTranslation("pages");
  const { network } = useChain();
  const w = useWallet();
  const qc = useQueryClient();
  const [showOpen, setShowOpen] = useState(false);
  const data = useQuery({
    queryKey: ["pages", "regen-votes", network],
    queryFn: async () => {
      const [config, entries] = await Promise.all([getVoteConfig(), listVoteProposals()]);
      return { config, entries };
    },
    refetchInterval: 60_000,
    retry: 1,
  });
  const { full: voterAddress } = useRougeAddress(w.status === "unlocked" ? (w.wallet?.signingPublicKey ?? null) : null);
  const config = data.data?.config ?? null;
  const entries = data.data?.entries ?? null;
  const isCurator = !!(voterAddress && config?.curators.includes(voterAddress));
  const reload = () => void qc.invalidateQueries({ queryKey: ["pages", "regen-votes", network] });

  return (
    <section id="votes" className="rc-block" aria-labelledby="votes-title">
      <div className="panel-head">
        <h2 id="votes-title">{t("votes.title")}</h2>
        {config && w.status === "unlocked" && (
          <Button variant="outline small" onClick={() => setShowOpen((v) => !v)}>
            <Plus size={15} /> {t("votes.open")}
          </Button>
        )}
      </div>
      {data.isPending ? (
        <p className="muted">{t("votes.loading")}</p>
      ) : !config || !entries ? (
        <p className="notice">{t("votes.unavailable")}</p>
      ) : (
        <>
          <p className="muted">{t("votes.lead", { cap: fmtNum(config.capBps / 100), turnout: fmtNum(config.turnoutBps / 100) })}</p>
          <p className="form-hint rc-signed">
            <ShieldCheck size={14} aria-hidden="true" /> {t("votes.signed")}
          </p>
          {showOpen && (
            <OpenProposalForm
              config={config}
              onCreated={() => {
                setShowOpen(false);
                reload();
              }}
            />
          )}
          {entries.length === 0 ? (
            <p className="notice">{t("votes.empty")}</p>
          ) : (
            <div className="rc-proposals">
              {entries.map((e) => (
                <ProposalRow key={e.proposal.id} e={e} isCurator={isCurator} onChanged={reload} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
