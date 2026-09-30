import { useState } from "react";
import { Link } from "react-router-dom";
import { Lock, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { Button, EmptyState } from "@rougechain/ui";
import {
  formatStake,
  STAKE_REQUIREMENTS,
  TIER_BENEFITS,
  type Validator,
} from "@rougechain/core/pqc-validators";
import { formatIdentity } from "@rougechain/core/address";
import { useWallet } from "../wallet/WalletProvider";
import { UnlockForm } from "../wallet/parts";
import { Bar, CopyCode, PageFrame, StatTile, TestnetNotice, short, useRouteSeo } from "./common";
import { common, seo, validators as t } from "./strings";
import { findMine, MIN_STAKE, TIERS, useValidatorsData } from "./validators-data";
import { StakeDialog } from "./StakeDialog";

const fmt = (n: number) => n.toLocaleString("en-US");
const STATUS_CLASS: Record<string, string> = {
  active: "live",
  pending: "warning",
  unbonding: "warning",
  jailed: "error",
  inactive: "loading",
};

function StatusPill({ status }: { status: string }) {
  return <span className={`status ${STATUS_CLASS[status] ?? "loading"}`}>{t.status[status] ?? status}</span>;
}

function Leaderboard({ list, me }: { list: Validator[]; me: string | null }) {
  const sorted = [...list].sort((a, b) => b.stakedAmount - a.stakedAmount);
  const total = sorted.reduce((s, v) => s + v.stakedAmount, 0);
  return (
    <section className="surface rc-panel" aria-labelledby="vl-title">
      <div className="panel-head">
        <h2 id="vl-title">{t.list.title}</h2>
        <span className="pill">{t.list.total(sorted.length)}</span>
      </div>
      <ol className="rc-validators">
        {sorted.map((v, i) => {
          const power = total > 0 ? (v.stakedAmount / total) * 100 : 0;
          const mine = v.signingPublicKey === me;
          return (
            <li key={v.id} className={mine ? "mine" : undefined}>
              <span className="rc-rank mono">{i + 1}</span>
              <div className="rc-validator-main">
                <div className="rc-validator-top">
                  <Link className="mono" to={`/address/${v.signingPublicKey}`} title={v.signingPublicKey}>
                    {short(v.signingPublicKey, 12, 8)}
                  </Link>
                  <span className={`rc-tier ${v.tier}`}>{t.tiers[v.tier]}</span>
                  {mine && <span className="pill">{t.list.you}</span>}
                </div>
                <div className="rc-validator-meta">
                  <StatusPill status={v.status} />
                  <span>
                    {(v.voteParticipation ?? 0).toFixed(1)}% {t.list.votes.toLowerCase()}
                  </span>
                  {v.lastSeenHeight ? (
                    <span>
                      {t.list.seen} #{v.lastSeenHeight}
                    </span>
                  ) : null}
                  {(v.slashCount ?? 0) > 0 && <span className="rc-bad">{t.list.slashed(v.slashCount!)}</span>}
                  {v.status === "jailed" && v.jailedUntil ? (
                    <span className="rc-bad">{t.list.jailedUntil(v.jailedUntil)}</span>
                  ) : null}
                </div>
                <Bar value={power} label={`${t.list.power} ${power.toFixed(2)}%`} />
              </div>
              <div className="rc-validator-stake">
                <strong className="mono">{formatStake(v.stakedAmount)} XRGE</strong>
                <small>
                  {power.toFixed(2)}% {t.list.power.toLowerCase()}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function MyStake({
  mine,
  data,
  onStake,
  onUnstake,
}: {
  mine: Validator | null;
  data: ReturnType<typeof useValidatorsData>;
  onStake: () => void;
  onUnstake: () => void;
}) {
  const w = useWallet();
  if (w.status === "locked")
    return (
      <section className="surface rc-panel rc-mine" aria-labelledby="mine-title">
        <h2 id="mine-title">
          <Lock size={16} aria-hidden="true" /> {t.mine.title}
        </h2>
        <p className="muted">{t.mine.locked}</p>
        <UnlockForm />
      </section>
    );
  if (w.status !== "unlocked" || !w.wallet)
    return (
      <section className="surface rc-panel rc-mine" aria-labelledby="mine-title">
        <h2 id="mine-title">{t.mine.title}</h2>
        <p className="muted">{t.mine.notConnected}</p>
        <Link className="button" to="/wallet">
          {common.openWallet}
        </Link>
      </section>
    );
  const available = data.balance.data;
  const staked = mine?.stakedAmount ?? 0;
  return (
    <section className="surface rc-panel rc-mine" aria-labelledby="mine-title">
      <div className="panel-head">
        <h2 id="mine-title">{t.mine.title}</h2>
        <Button
          variant="ghost icon"
          aria-label="Refresh"
          onClick={data.refresh}
          disabled={data.balance.isFetching || data.validators.isFetching}
        >
          <RefreshCw size={15} className={data.balance.isFetching ? "spin" : ""} />
        </Button>
      </div>
      <dl className="review-list">
        <div>
          <dt>{t.mine.available}</dt>
          <dd className="mono">
            {data.balance.isError ? "—" : available === undefined ? common.loading : `${fmt(available)} XRGE`}
          </dd>
        </div>
        <div>
          <dt>{t.mine.staked}</dt>
          <dd className="mono">{fmt(staked)} XRGE</dd>
        </div>
        {mine && (
          <>
            <div>
              <dt>{t.mine.tier}</dt>
              <dd>{t.tiers[mine.tier]}</dd>
            </div>
            <div>
              <dt>{t.mine.status}</dt>
              <dd>
                <StatusPill status={mine.status} />
              </dd>
            </div>
          </>
        )}
      </dl>
      {mine ? (
        <p className="form-hint">{t.mine.youAre(t.tiers[mine.tier].toLowerCase())}</p>
      ) : (
        <p className="form-hint">{t.mine.notValidator}</p>
      )}
      {mine && (mine.slashCount ?? 0) > 0 && (
        <p className="form-hint error">{t.mine.slashInfo(mine.slashCount!, mine.jailedUntil || undefined)}</p>
      )}
      {!mine && available !== undefined && available < MIN_STAKE && (
        <p className="form-hint">{t.mine.needMore(fmt(MIN_STAKE - available))}</p>
      )}
      {w.isExtension && <p className="form-hint">{t.mine.extension}</p>}
      <div className="actions">
        <Button onClick={onStake} disabled={available === undefined}>
          {mine ? t.mine.addStake : t.mine.stake}
        </Button>
        {mine && staked > 0 && (
          <Button variant="outline" onClick={onUnstake} disabled={available === undefined}>
            {t.mine.unstake}
          </Button>
        )}
      </div>
      <p className="form-hint">{t.mine.missed}</p>
    </section>
  );
}

export default function Validators() {
  useRouteSeo(seo.validators);
  const w = useWallet();
  const publicKey = w.status === "unlocked" ? (w.wallet?.signingPublicKey ?? null) : (w.publicKey ?? null);
  const data = useValidatorsData(w.status === "unlocked" ? publicKey : null);
  const [dialog, setDialog] = useState<null | "stake" | "unstake">(null);
  const [pending, setPending] = useState<{ amount: number; target: number } | null>(null);
  const list = data.validators.data;
  const mine = findMine(list, publicKey);
  const total = list?.reduce((s, v) => s + v.stakedAmount, 0) ?? 0;
  const active = list?.filter((v) => v.status === "active").length ?? 0;
  const entropy = list?.reduce((s, v) => s + (v.quantumEntropyContributions || 0), 0) ?? 0;
  const participation = list && list.length ? list.reduce((s, v) => s + (v.voteParticipation ?? 0), 0) / list.length : 0;
  const sel = data.selection.data;
  const fin = data.finality.data;

  return (
    <PageFrame eyebrow={t.eyebrow} title={t.title} lead={t.lead} className="rc-validators-page">
      <TestnetNotice>{common.testnetNotice("Stake and validators shown here are on testnet.")}</TestnetNotice>

      <div className="rc-stats">
        <StatTile label={t.stats.total} value={list ? list.length : "—"} sub={list ? t.stats.active(active) : undefined} />
        <StatTile label={t.stats.staked} value={list ? formatStake(total) : "—"} sub="XRGE" />
        <StatTile label={t.stats.entropy} value={list ? fmt(entropy) : "—"} sub={t.stats.entropySub} />
        <StatTile
          label={t.stats.participation}
          value={list ? `${participation.toFixed(1)}%` : "—"}
          sub={t.stats.height(fin?.votes?.height ?? "—")}
        />
      </div>

      {pending && !(mine && mine.stakedAmount >= pending.target) && (
        <p className="notice rc-pending" role="status">
          <strong>{t.mine.pending}</strong> {t.mine.pendingBody} ({fmt(pending.amount)} XRGE)
        </p>
      )}

      <div className="rc-grid">
        <div className="rc-col">
          <MyStake mine={mine} data={data} onStake={() => setDialog("stake")} onUnstake={() => setDialog("unstake")} />

          <section className="surface rc-panel" aria-labelledby="prop-title">
            <h2 id="prop-title">{t.proposer.title}</h2>
            {data.selection.isError ? (
              <p className="muted">{t.proposer.unavailable}</p>
            ) : (
              <dl className="review-list">
                <div>
                  <dt>{t.proposer.height}</dt>
                  <dd className="mono">{sel ? `#${fmt(sel.height)}` : common.loading}</dd>
                </div>
                <div>
                  <dt>{t.proposer.proposer}</dt>
                  <dd className="mono" title={sel?.proposerPubKey ?? undefined}>
                    {sel?.proposerPubKey ? formatIdentity(sel.proposerPubKey) : "—"}
                  </dd>
                </div>
                <div>
                  <dt>{t.proposer.weight}</dt>
                  <dd className="mono">{sel?.selectionWeight ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t.proposer.totalStake}</dt>
                  <dd className="mono">{sel ? `${formatStake(sel.totalStake)} XRGE` : "—"}</dd>
                </div>
                {sel?.entropyHex ? (
                  <div>
                    <dt>{t.proposer.entropy}</dt>
                    <dd className="mono">
                      {sel.entropySource} · {short(sel.entropyHex, 24)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            )}
            {sel?.proposerPubKey && sel.proposerPubKey === publicKey && <p className="form-hint">{t.proposer.you}</p>}
          </section>

          <section className="surface rc-panel" aria-labelledby="fin-title">
            <h2 id="fin-title">{t.finality.title}</h2>
            {data.finality.isError ? (
              <p className="muted">{t.finality.unavailable}</p>
            ) : (
              <div className="rc-mini-stats">
                <StatTile label={t.finality.finalized} value={fin ? fmt(fin.finalizedHeight) : "—"} />
                <StatTile label={t.finality.tip} value={fin ? fmt(fin.tipHeight) : "—"} />
                <StatTile label={t.finality.lag} value={fin ? fmt(Math.max(0, fin.tipHeight - fin.finalizedHeight)) : "—"} />
                <StatTile label={t.finality.quorum} value={fin ? formatStake(fin.quorumStake) : "—"} sub="XRGE" />
              </div>
            )}
          </section>

          <section className="surface rc-panel" aria-labelledby="tier-title">
            <h2 id="tier-title">{t.tiers.title}</h2>
            <div className="rc-tier-dist">
              {TIERS.map((tier) => {
                const count = list?.filter((v) => v.tier === tier).length ?? 0;
                return (
                  <div key={tier}>
                    <div className="field-row">
                      <span className={`rc-tier ${tier}`}>{t.tiers[tier]}</span>
                      <span className="mono">{count}</span>
                    </div>
                    <Bar value={list && list.length ? (count / list.length) * 100 : 0} label={`${t.tiers[tier]} ${count}`} />
                  </div>
                );
              })}
            </div>
          </section>

          {data.validators.isError && !list ? (
            <EmptyState title={t.list.title}>{common.apiUnavailable(data.network === "mainnet" ? common.mainnet : common.testnet)}</EmptyState>
          ) : !list ? (
            <EmptyState title={t.list.loading}>{common.loading}</EmptyState>
          ) : list.length === 0 ? (
            <EmptyState title={t.list.empty}>{t.list.emptyBody}</EmptyState>
          ) : (
            <Leaderboard list={list} me={publicKey} />
          )}
        </div>

        <aside className="rc-col" aria-label={t.how.title}>
          <section className="surface rc-panel rc-how" aria-labelledby="how-title">
            <h2 id="how-title">
              <ShieldCheck size={18} aria-hidden="true" /> {t.how.title}
            </h2>
            <div className="rc-callout">
              <strong>{t.how.staked.title}</strong>
              <p>{t.how.staked.body}</p>
            </div>
            <ol className="rc-steps">
              {t.how.steps.map(([title, body]) => (
                <li key={title}>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </li>
              ))}
            </ol>
            <a className="text-link" href={t.how.guideUrl} target="_blank" rel="noopener noreferrer">
              {t.how.guide} ↗
            </a>
          </section>

          <section className="surface rc-panel" aria-labelledby="tiers-title">
            <h2 id="tiers-title">{t.tierBenefits}</h2>
            <ul className="rc-tier-list">
              {TIERS.map((tier) => (
                <li key={tier}>
                  <div className="field-row">
                    <span className={`rc-tier ${tier}`}>{t.tiers[tier]}</span>
                    <span className="mono">{formatStake(STAKE_REQUIREMENTS[tier])} XRGE</span>
                  </div>
                  <ul>
                    {TIER_BENEFITS[tier].slice(0, 2).map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="form-hint">{t.security.body}</p>
          </section>

          <section className="surface rc-panel" aria-labelledby="run-title">
            <h2 id="run-title">
              <Server size={18} aria-hidden="true" /> {t.runNode.title}
            </h2>
            <p className="muted">{t.runNode.body}</p>
            <CopyCode text={t.runNode.command} />
            <div className="actions">
              <a className="button outline small" href={t.runNode.guideUrl} target="_blank" rel="noopener noreferrer">
                {t.runNode.guide}
              </a>
              <a className="button outline small" href="https://github.com/cyberdreadx/rougechain-node" target="_blank" rel="noopener noreferrer">
                {t.runNode.github}
              </a>
            </div>
            <Link className="text-link" to="/node">
              {t.runNode.nodePage} →
            </Link>
            <Link className="text-link" to="/genesis-validators">
              {t.runNode.genesis} →
            </Link>
          </section>
        </aside>
      </div>

      {w.status === "unlocked" && w.wallet && dialog && (
        <StakeDialog
          key={dialog}
          mode={dialog}
          open
          wallet={w.wallet}
          available={data.balance.data ?? 0}
          staked={mine?.stakedAmount ?? 0}
          onClose={() => setDialog(null)}
          onDone={(amount) => {
            if (dialog === "stake") setPending({ amount, target: (mine?.stakedAmount ?? 0) + amount });
            setDialog(null);
            data.refresh();
          }}
        />
      )}
    </PageFrame>
  );
}
