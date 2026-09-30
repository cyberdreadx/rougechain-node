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
import { useTranslation } from "react-i18next";
import { fmtInt, fmtNum } from "../i18n/format";
import { findMine, MIN_STAKE, TIERS, useValidatorsData } from "./validators-data";
import { StakeDialog } from "./StakeDialog";

/** XRGE balances / stakes: exact en-US grouping (token amounts are not localised). */
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, digits: number) => fmtNum(n, digits, { minimumFractionDigits: digits });
const STATUS_CLASS: Record<string, string> = {
  active: "live",
  pending: "warning",
  unbonding: "warning",
  jailed: "error",
  inactive: "loading",
};

const HOW_STEPS = ["stake", "run", "propose", "reliable"] as const;
const GUIDE_URL = "https://docs.rougechain.io/staking/becoming-validator.html";
const RUN_NODE_GUIDE_URL = "https://docs.rougechain.io/running-a-node/";
const RUN_NODE_COMMAND =
  "git clone https://github.com/cyberdreadx/rougechain-node && cd rougechain-node && docker compose up -d";

function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation("pages");
  return (
    <span className={`status ${STATUS_CLASS[status] ?? "loading"}`}>{t(`validators.status.${status}`, { defaultValue: status })}</span>
  );
}

function Leaderboard({ list, me }: { list: Validator[]; me: string | null }) {
  const { t } = useTranslation("pages");
  const sorted = [...list].sort((a, b) => b.stakedAmount - a.stakedAmount);
  const total = sorted.reduce((s, v) => s + v.stakedAmount, 0);
  return (
    <section className="surface rc-panel" aria-labelledby="vl-title">
      <div className="panel-head">
        <h2 id="vl-title">{t("validators.list.title")}</h2>
        <span className="pill">{t("validators.list.total", { count: sorted.length, n: fmtInt(sorted.length) })}</span>
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
                  <span className={`rc-tier ${v.tier}`}>{t(`validators.tiers.${v.tier}`)}</span>
                  {mine && <span className="pill">{t("validators.list.you")}</span>}
                </div>
                <div className="rc-validator-meta">
                  <StatusPill status={v.status} />
                  <span>{t("validators.list.votes", { pct: pct(v.voteParticipation ?? 0, 1) })}</span>
                  {v.lastSeenHeight ? (
                    <span>{t("validators.list.seen", { height: v.lastSeenHeight })}</span>
                  ) : null}
                  {(v.slashCount ?? 0) > 0 && <span className="rc-bad">{t("validators.list.slashed", { count: v.slashCount! })}</span>}
                  {v.status === "jailed" && v.jailedUntil ? (
                    <span className="rc-bad">{t("validators.list.jailedUntil", { height: v.jailedUntil })}</span>
                  ) : null}
                </div>
                <Bar value={power} label={t("validators.list.powerLabel", { pct: pct(power, 2) })} />
              </div>
              <div className="rc-validator-stake">
                <strong className="mono">{formatStake(v.stakedAmount)} XRGE</strong>
                <small>{t("validators.list.power", { pct: pct(power, 2) })}</small>
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
  const { t } = useTranslation("pages");
  const w = useWallet();
  if (w.status === "locked")
    return (
      <section className="surface rc-panel rc-mine" aria-labelledby="mine-title">
        <h2 id="mine-title">
          <Lock size={16} aria-hidden="true" /> {t("validators.mine.title")}
        </h2>
        <p className="muted">{t("validators.mine.locked")}</p>
        <UnlockForm />
      </section>
    );
  if (w.status !== "unlocked" || !w.wallet)
    return (
      <section className="surface rc-panel rc-mine" aria-labelledby="mine-title">
        <h2 id="mine-title">{t("validators.mine.title")}</h2>
        <p className="muted">{t("validators.mine.notConnected")}</p>
        <Link className="button" to="/wallet">
          {t("common.openWallet")}
        </Link>
      </section>
    );
  const available = data.balance.data;
  const staked = mine?.stakedAmount ?? 0;
  return (
    <section className="surface rc-panel rc-mine" aria-labelledby="mine-title">
      <div className="panel-head">
        <h2 id="mine-title">{t("validators.mine.title")}</h2>
        <Button
          variant="ghost icon"
          aria-label={t("common.refresh")}
          onClick={data.refresh}
          disabled={data.balance.isFetching || data.validators.isFetching}
        >
          <RefreshCw size={15} className={data.balance.isFetching ? "spin" : ""} />
        </Button>
      </div>
      <dl className="review-list">
        <div>
          <dt>{t("validators.mine.available")}</dt>
          <dd className="mono">
            {data.balance.isError ? "—" : available === undefined ? t("common.loading") : `${fmt(available)} XRGE`}
          </dd>
        </div>
        <div>
          <dt>{t("validators.mine.staked")}</dt>
          <dd className="mono">{fmt(staked)} XRGE</dd>
        </div>
        {mine && (
          <>
            <div>
              <dt>{t("validators.mine.tier")}</dt>
              <dd>{t(`validators.tiers.${mine.tier}`)}</dd>
            </div>
            <div>
              <dt>{t("validators.mine.status")}</dt>
              <dd>
                <StatusPill status={mine.status} />
              </dd>
            </div>
          </>
        )}
      </dl>
      {mine ? (
        <p className="form-hint">{t("validators.mine.youAre", { tier: t(`validators.tiers.${mine.tier}`).toLowerCase() })}</p>
      ) : (
        <p className="form-hint">{t("validators.mine.notValidator")}</p>
      )}
      {mine && (mine.slashCount ?? 0) > 0 && (
        <p className="form-hint error">{mine.jailedUntil
            ? t("validators.mine.slashedJailed", { count: mine.slashCount!, height: mine.jailedUntil })
            : t("validators.mine.slashed", { count: mine.slashCount! })}</p>
      )}
      {!mine && available !== undefined && available < MIN_STAKE && (
        <p className="form-hint">{t("validators.mine.needMore", { amount: fmt(MIN_STAKE - available) })}</p>
      )}
      {w.isExtension && <p className="form-hint">{t("validators.mine.extension")}</p>}
      <div className="actions">
        <Button onClick={onStake} disabled={available === undefined}>
          {mine ? t("validators.mine.addStake") : t("validators.mine.stake")}
        </Button>
        {mine && staked > 0 && (
          <Button variant="outline" onClick={onUnstake} disabled={available === undefined}>
            {t("validators.mine.unstake")}
          </Button>
        )}
      </div>
      <p className="form-hint">{t("validators.mine.missed")}</p>
    </section>
  );
}

export default function Validators() {
  const { t } = useTranslation("pages");
  useRouteSeo({ title: t("seo.validators.title"), description: t("seo.validators.description") });
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
    <PageFrame eyebrow={t("validators.eyebrow")} title={t("validators.title")} lead={t("validators.lead")} className="rc-validators-page">
      <TestnetNotice>{t("validators.testnetNotice")}</TestnetNotice>

      <div className="rc-stats">
        <StatTile
          label={t("validators.stats.total")}
          value={list ? fmtInt(list.length) : "—"}
          sub={list ? t("validators.stats.active", { count: active, n: fmtInt(active) }) : undefined}
        />
        <StatTile label={t("validators.stats.staked")} value={list ? formatStake(total) : "—"} sub="XRGE" />
        <StatTile label={t("validators.stats.entropy")} value={list ? fmtInt(entropy) : "—"} sub={t("validators.stats.entropySub")} />
        <StatTile
          label={t("validators.stats.participation")}
          value={list ? `${pct(participation, 1)}%` : "—"}
          sub={t("validators.stats.height", { height: fin?.votes?.height != null ? fmtInt(fin.votes.height) : "—" })}
        />
      </div>

      {pending && !(mine && mine.stakedAmount >= pending.target) && (
        <p className="notice rc-pending" role="status">
          <strong>{t("validators.mine.pending")}</strong> {t("validators.mine.pendingBody")} ({fmt(pending.amount)} XRGE)
        </p>
      )}

      <div className="rc-grid">
        <div className="rc-col">
          <MyStake mine={mine} data={data} onStake={() => setDialog("stake")} onUnstake={() => setDialog("unstake")} />

          <section className="surface rc-panel" aria-labelledby="prop-title">
            <h2 id="prop-title">{t("validators.proposer.title")}</h2>
            {data.selection.isError ? (
              <p className="muted">{t("validators.proposer.unavailable")}</p>
            ) : (
              <dl className="review-list">
                <div>
                  <dt>{t("validators.proposer.height")}</dt>
                  <dd className="mono">{sel ? `#${fmtInt(sel.height)}` : t("common.loading")}</dd>
                </div>
                <div>
                  <dt>{t("validators.proposer.proposer")}</dt>
                  <dd className="mono" title={sel?.proposerPubKey ?? undefined}>
                    {sel?.proposerPubKey ? formatIdentity(sel.proposerPubKey) : "—"}
                  </dd>
                </div>
                <div>
                  <dt>{t("validators.proposer.weight")}</dt>
                  <dd className="mono">{sel?.selectionWeight ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("validators.proposer.totalStake")}</dt>
                  <dd className="mono">{sel ? `${formatStake(sel.totalStake)} XRGE` : "—"}</dd>
                </div>
                {sel?.entropyHex ? (
                  <div>
                    <dt>{t("validators.proposer.entropy")}</dt>
                    <dd className="mono">
                      {sel.entropySource} · {short(sel.entropyHex, 24)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            )}
            {sel?.proposerPubKey && sel.proposerPubKey === publicKey && <p className="form-hint">{t("validators.proposer.you")}</p>}
          </section>

          <section className="surface rc-panel" aria-labelledby="fin-title">
            <h2 id="fin-title">{t("validators.finality.title")}</h2>
            {data.finality.isError ? (
              <p className="muted">{t("validators.finality.unavailable")}</p>
            ) : (
              <div className="rc-mini-stats">
                <StatTile label={t("validators.finality.finalized")} value={fin ? fmtInt(fin.finalizedHeight) : "—"} />
                <StatTile label={t("validators.finality.tip")} value={fin ? fmtInt(fin.tipHeight) : "—"} />
                <StatTile label={t("validators.finality.lag")} value={fin ? fmtInt(Math.max(0, fin.tipHeight - fin.finalizedHeight)) : "—"} />
                <StatTile label={t("validators.finality.quorum")} value={fin ? formatStake(fin.quorumStake) : "—"} sub="XRGE" />
              </div>
            )}
          </section>

          <section className="surface rc-panel" aria-labelledby="tier-title">
            <h2 id="tier-title">{t("validators.tiers.title")}</h2>
            <div className="rc-tier-dist">
              {TIERS.map((tier) => {
                const count = list?.filter((v) => v.tier === tier).length ?? 0;
                return (
                  <div key={tier}>
                    <div className="field-row">
                      <span className={`rc-tier ${tier}`}>{t(`validators.tiers.${tier}`)}</span>
                      <span className="mono">{fmtInt(count)}</span>
                    </div>
                    <Bar value={list && list.length ? (count / list.length) * 100 : 0} label={`${t(`validators.tiers.${tier}`)} ${fmtInt(count)}`} />
                  </div>
                );
              })}
            </div>
          </section>

          {data.validators.isError && !list ? (
            <EmptyState title={t("validators.list.title")}>{t("common.apiUnavailable", { network: t(data.network === "mainnet" ? "common.mainnet" : "common.testnet") })}</EmptyState>
          ) : !list ? (
            <EmptyState title={t("validators.list.loading")}>{t("common.loading")}</EmptyState>
          ) : list.length === 0 ? (
            <EmptyState title={t("validators.list.empty")}>{t("validators.list.emptyBody")}</EmptyState>
          ) : (
            <Leaderboard list={list} me={publicKey} />
          )}
        </div>

        <aside className="rc-col" aria-label={t("validators.how.title")}>
          <section className="surface rc-panel rc-how" aria-labelledby="how-title">
            <h2 id="how-title">
              <ShieldCheck size={18} aria-hidden="true" /> {t("validators.how.title")}
            </h2>
            <div className="rc-callout">
              <strong>{t("validators.how.stakedTitle")}</strong>
              <p>{t("validators.how.stakedBody")}</p>
            </div>
            <ol className="rc-steps">
              {HOW_STEPS.map((k) => (
                <li key={k}>
                  <strong>{t(`validators.how.steps.${k}.title`)}</strong>
                  <p>{t(`validators.how.steps.${k}.body`)}</p>
                </li>
              ))}
            </ol>
            <a className="text-link" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
              {t("validators.how.guide")} ↗
            </a>
          </section>

          <section className="surface rc-panel" aria-labelledby="tiers-title">
            <h2 id="tiers-title">{t("validators.tierBenefitsTitle")}</h2>
            <ul className="rc-tier-list">
              {TIERS.map((tier) => (
                <li key={tier}>
                  <div className="field-row">
                    <span className={`rc-tier ${tier}`}>{t(`validators.tiers.${tier}`)}</span>
                    <span className="mono">{formatStake(STAKE_REQUIREMENTS[tier])} XRGE</span>
                  </div>
                  <ul>
                    {TIER_BENEFITS[tier].slice(0, 2).map((b, i) => (
                      <li key={b}>{t(`validators.tierBenefits.${tier}.b${i}`, { defaultValue: b })}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="form-hint">{t("validators.securityBody")}</p>
          </section>

          <section className="surface rc-panel" aria-labelledby="run-title">
            <h2 id="run-title">
              <Server size={18} aria-hidden="true" /> {t("validators.runNode.title")}
            </h2>
            <p className="muted">{t("validators.runNode.body")}</p>
            <CopyCode text={RUN_NODE_COMMAND} />
            <div className="actions">
              <a className="button outline small" href={RUN_NODE_GUIDE_URL} target="_blank" rel="noopener noreferrer">
                {t("validators.runNode.guide")}
              </a>
              <a className="button outline small" href="https://github.com/cyberdreadx/rougechain-node" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </div>
            <Link className="text-link" to="/node">
              {t("validators.runNode.nodePage")} →
            </Link>
            <Link className="text-link" to="/genesis-validators">
              {t("validators.runNode.genesis")} →
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
