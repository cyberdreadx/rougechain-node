import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCircle2, Circle, Copy, ExternalLink } from "lucide-react";
import { Button } from "@rougechain/ui";
import {
  getProjects,
  getTreasuryLedger,
  getTreasuryStats,
  hasFundedProjects,
  REGEN_CATEGORIES,
  REGEN_STATUS_LABEL,
  REGEN_TREASURY_ADDRESS,
  txUrl,
  verifiedFunding,
  type RegenProject,
  type TreasuryLedger,
} from "@rougechain/core/regenerate";
import { useChain } from "../explorer/chain";
import { TestnetNotice, useRouteSeo } from "./common";
import CommunityVotes from "./CommunityVotes";
import { proposalForm as pf, regen as t, seo } from "./strings";
import "./pages.css";

const fmt = (n: number | null, suffix = "") =>
  n == null ? null : `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}${suffix}`;
const CATEGORY_LABEL = Object.fromEntries(REGEN_CATEGORIES.map((c) => [c.key, c.title]));

/** Must match the hidden form in index.html (Netlify Forms detection) — same name as apps/web. */
export const PROPOSAL_FORM_NAME = "regenerate-proposal";
const DISCORD_URL = "https://discord.gg/wZKsHfhXxm";
const FIELDS = ["name", "contact", "project", "location", "category", "requested_xrge", "payout_address", "description", "milestones", "links"] as const;
type Field = (typeof FIELDS)[number];
const EMPTY = Object.fromEntries(FIELDS.map((f) => [f, ""])) as Record<Field, string>;

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rc-stat">
      <div className="metric-label">{label}</div>
      {value !== null ? <div className="rc-stat-value">{value}</div> : <div className="rc-stat-sub">{t.stat.notLive}</div>}
    </div>
  );
}

function ProjectCard({ project, ledger }: { project: RegenProject; ledger: TreasuryLedger | null }) {
  const funding = verifiedFunding(project, ledger);
  // Funding is only what the chain shows leaving the treasury for this project (apps/web rule).
  const status: RegenProject["status"] =
    project.status === "proposed" || project.status === "reviewing"
      ? funding.txs.length > 0
        ? "funded"
        : project.status
      : funding.txs.length > 0
        ? project.status
        : "reviewing";
  return (
    <article className="surface rc-card rc-project">
      <div className="panel-head">
        <div>
          <h3>{project.name}</h3>
          <p className="form-hint">{project.location}</p>
        </div>
        <span className={`status ${funding.txs.length ? "live" : "loading"}`}>{REGEN_STATUS_LABEL[status]}</span>
      </div>
      <p className="rc-tags">
        <span className="pill">{CATEGORY_LABEL[project.category] ?? project.category}</span>
        <span className="pill">{project.requestedXrge != null ? t.requested(project.requestedXrge.toLocaleString("en-US")) : t.fundingTbd}</span>
      </p>
      <p>{project.description}</p>
      {project.milestones.length > 0 && (
        <>
          <div className="metric-label">{t.milestones}</div>
          <ul className="rc-milestones">
            {project.milestones.map((m) => (
              <li key={m.title} className={m.done ? "done" : undefined}>
                {m.done ? <CheckCircle2 size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />} {m.title}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="rc-meta rc-card-foot">
        {project.evidenceUrl ? (
          <a className="text-link inline" href={project.evidenceUrl} target="_blank" rel="noopener noreferrer">
            {t.evidence} <ExternalLink size={11} />
          </a>
        ) : (
          <span>{t.evidencePending}</span>
        )}
        {funding.txs.length > 0 ? (
          <>
            <span>{t.fundedOnChain(funding.xrge.toLocaleString("en-US"))}</span>
            {funding.txs.map((x) => (
              <Link key={x.txId} className="mono" to={txUrl(x.txId)}>
                #{x.txId.slice(0, 10)}…
              </Link>
            ))}
          </>
        ) : (
          <span>{t.fundingNone}</span>
        )}
      </p>
    </article>
  );
}

/** Project proposal form → Netlify Forms (POST / urlencoded, same fields and name as apps/web). */
export function ProposalForm() {
  const [v, setV] = useState(EMPTY);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const set = (k: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("sending");
    try {
      const body = new URLSearchParams({ "form-name": PROPOSAL_FORM_NAME, "bot-field": "", ...v });
      const res = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("sent");
      setV(EMPTY);
    } catch {
      setState("error");
    }
  };
  if (state === "sent")
    return (
      <div className="rc-sent" role="status">
        <CheckCircle2 size={32} aria-hidden="true" />
        <h3>{pf.sentTitle}</h3>
        <p>{pf.sentBody}</p>
        <Button variant="outline" onClick={() => setState("idle")}>
          {pf.another}
        </Button>
      </div>
    );
  return (
    <form name={PROPOSAL_FORM_NAME} onSubmit={submit} className="wallet-form rc-proposal-form">
      <input type="hidden" name="form-name" value={PROPOSAL_FORM_NAME} />
      <p hidden>
        <label>
          Leave empty <input name="bot-field" tabIndex={-1} autoComplete="off" />
        </label>
      </p>
      <div className="two-fields">
        <label className="field">
          {pf.name}
          <input className="input" required maxLength={120} value={v.name} onChange={set("name")} />
        </label>
        <label className="field">
          {pf.contact}
          <input className="input" required maxLength={160} value={v.contact} onChange={set("contact")} placeholder={pf.contactPh} />
        </label>
        <label className="field">
          {pf.project}
          <input className="input" required maxLength={120} value={v.project} onChange={set("project")} />
        </label>
        <label className="field">
          {pf.location}
          <input className="input" required maxLength={120} value={v.location} onChange={set("location")} placeholder={pf.locationPh} />
        </label>
        <label className="field">
          {pf.category}
          <select required value={v.category} onChange={set("category")}>
            <option value="" disabled>
              {pf.choose}
            </option>
            {REGEN_CATEGORIES.map((c) => (
              <option key={c.key} value={c.title}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {pf.amount}
          <input
            className="input mono"
            inputMode="decimal"
            maxLength={24}
            value={v.requested_xrge}
            onChange={(e) => setV((s) => ({ ...s, requested_xrge: e.target.value.replace(/[^0-9.]/g, "") }))}
            placeholder={pf.amountPh}
          />
        </label>
      </div>
      <label className="field">
        {pf.payout}
        <input className="input mono" maxLength={120} value={v.payout_address} onChange={set("payout_address")} placeholder="rouge1…" />
      </label>
      <label className="field">
        {pf.description}
        <textarea className="input" required minLength={40} maxLength={4000} rows={5} value={v.description} onChange={set("description")} />
      </label>
      <label className="field">
        {pf.milestones}
        <textarea className="input" maxLength={2000} rows={3} value={v.milestones} onChange={set("milestones")} placeholder={pf.milestonesPh} />
      </label>
      <label className="field">
        {pf.links}
        <input className="input" maxLength={500} value={v.links} onChange={set("links")} placeholder={pf.linksPh} />
      </label>
      <div className="actions">
        <Button type="submit" disabled={state === "sending"}>
          {state === "sending" ? pf.sending : pf.submit}
        </Button>
        <a className="text-link" href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
          {pf.discord}
        </a>
      </div>
      {state === "error" && (
        <p className="form-error" role="alert">
          {pf.error}
        </p>
      )}
    </form>
  );
}

export default function Regenerate() {
  useRouteSeo(seo.regenerate);
  const { network } = useChain();
  const mainnet = network === "mainnet";
  const [copied, setCopied] = useState(false);
  const ledgerQ = useQuery({
    queryKey: ["pages", "regen-ledger", network],
    queryFn: getTreasuryLedger,
    // The treasury is a mainnet wallet: reading it from a testnet node would be meaningless.
    enabled: mainnet,
    refetchInterval: 120_000,
    retry: 1,
  });
  const ledger = mainnet ? (ledgerQ.data ?? null) : null;
  const projects = getProjects();
  const treasury = getTreasuryStats(ledger, projects);
  const anyFunded = hasFundedProjects(projects, ledger);
  const copy = () => {
    navigator.clipboard
      ?.writeText(REGEN_TREASURY_ADDRESS)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <main id="main" className="app-main rc-page rc-regen">
      <div className="container rc-narrow">
        <header className="rc-hero center">
          <div className="eyebrow">{t.kicker}</div>
          <p className="mono muted">{t.sub}</p>
          <h1>
            <span className="gradient-text">{t.titleEm}</span>
            {t.titleRest}
          </h1>
          <p className="rc-lead">{t.lead}</p>
          <div className="actions">
            <a className="button" href="#projects">
              {t.viewProjects}
            </a>
            <a className="button outline" href="#propose">
              {t.propose}
            </a>
          </div>
        </header>

        <TestnetNotice>{t.testnet}</TestnetNotice>

        <section className="rc-statement">
          <h2>
            {t.statementA}
            <span className="gradient-text">{t.statementEm}</span>
          </h2>
          <p>{t.statementBody}</p>
          <p className="form-hint">{t.solarpunk}</p>
        </section>

        <section className="rc-cards four" aria-label="Categories">
          {REGEN_CATEGORIES.map((c) => (
            <article key={c.key} className="surface rc-card">
              <h3>{c.title}</h3>
              <p>{c.blurb}</p>
            </article>
          ))}
        </section>

        <section className="surface rc-territory" aria-labelledby="territory">
          <div className="eyebrow">{t.territoryKicker}</div>
          <h2 id="territory">
            {t.territoryName} <span className="mono muted">{t.territoryCoords}</span>
          </h2>
          <p>{t.territoryBody}</p>
          <p className="form-hint">{anyFunded ? t.funded : t.notFunded}</p>
        </section>

        <section className="rc-block" aria-labelledby="treasury">
          <div className="panel-head">
            <h2 id="treasury">{t.treasuryTitle}</h2>
            <span className="form-hint">{ledger ? t.treasuryLive : t.treasuryPending}</span>
          </div>
          <div className="rc-stats four">
            <Stat label={t.stat.balance} value={fmt(treasury.balanceXrge, " XRGE")} />
            <Stat label={t.stat.funded} value={fmt(treasury.projectsFunded)} />
            <Stat label={t.stat.deployed} value={fmt(treasury.totalDeployedXrge, " XRGE")} />
            <Stat label={t.stat.territories} value={fmt(treasury.activeTerritories)} />
          </div>
          {REGEN_TREASURY_ADDRESS && mainnet && (
            <div className="rc-grid even">
              <div className="surface rc-panel">
                <div className="metric-label">{t.wallet}</div>
                <button type="button" className="rc-address" onClick={copy} aria-label={t.copyAddress}>
                  <code className="mono">{REGEN_TREASURY_ADDRESS}</code>
                  <span className="form-hint">
                    {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied ? "Copied" : t.copyAddress}
                  </span>
                </button>
                <p className="form-hint">{t.donate}</p>
                {ledger && (
                  <p className="form-hint">
                    {t.donations}: <span className="mono">{fmt(ledger.receivedXrge, " XRGE")}</span>
                  </p>
                )}
                <Link className="text-link" to={`/address/${REGEN_TREASURY_ADDRESS}`}>
                  {t.viewExplorer} <ArrowRight size={14} />
                </Link>
              </div>
              <div className="surface rc-panel">
                <div className="metric-label">{t.recent}</div>
                {ledger && ledger.txs.length > 0 ? (
                  <ul className="rc-rows">
                    {ledger.txs.slice(0, 8).map((x) => (
                      <li key={x.txId}>
                        <span className={x.direction === "in" ? "rc-in" : "rc-out"}>
                          {x.direction === "in" ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{" "}
                          {x.direction === "in" ? t.donation : t.grant}
                        </span>
                        <span className="mono">{fmt(x.amountXrge, " XRGE")}</span>
                        <Link className="mono" to={txUrl(x.txId)}>
                          {x.txId.slice(0, 10)}…
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{ledgerQ.isPending ? "…" : ledger ? t.noTxs : t.treasuryUnreachable}</p>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="surface rc-panel" aria-labelledby="proof">
          <div id="proof" className="eyebrow">
            {t.proofKicker}
          </div>
          <p>{t.proofBody}</p>
          <ol className="rc-protocol">
            {t.protocol.map((s, i) => (
              <li key={s}>
                <span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
                <strong>{s}</strong>
              </li>
            ))}
          </ol>
        </section>

        <CommunityVotes />

        <section id="projects" className="rc-block" aria-labelledby="projects-title">
          <h2 id="projects-title">{t.projectsTitle}</h2>
          {!anyFunded && <p className="muted">{t.illustrative}</p>}
          <div className="rc-cards three">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} ledger={ledger} />
            ))}
          </div>
        </section>

        <section id="propose" className="surface rc-panel rc-propose" aria-labelledby="propose-title">
          <h2 id="propose-title">{t.proposeTitle}</h2>
          <p>{t.proposeLead}</p>
          <ProposalForm />
        </section>
      </div>
    </main>
  );
}
