import { Link } from "react-router-dom";
import { EmptyState, Status } from "@rougechain/ui";
import { useChain } from "../explorer/chain";
import { CopyCode, PageFrame, StatTile, TestnetNotice, useRouteSeo } from "./common";
import { node as t, seo } from "./strings";
import { useNodeScan } from "./node-data";

const fmt = (n: number) => n.toLocaleString("en-US");

function Dashboard() {
  const { network } = useChain();
  const { nodes, validatorCount, checking } = useNodeScan(network);
  const maxHeight = nodes.length ? Math.max(...nodes.map((n) => n.stats.network_height)) : null;
  const maxFinal = nodes.length ? Math.max(...nodes.map((n) => n.stats.finalized_height)) : null;
  const chains = [...new Set(nodes.map((n) => n.stats.chain_id).filter(Boolean))];
  return (
    <section className="rc-block" aria-labelledby="live-nodes">
      <div className="panel-head">
        <h2 id="live-nodes">{t.dashboardTitle}</h2>
        <Status state={checking && !nodes.length ? "loading" : nodes.length ? "live" : "unavailable"}>
          {checking && !nodes.length ? t.scanning : nodes.length ? t.online(validatorCount || nodes.length) : t.none}
        </Status>
      </div>
      {nodes.length > 0 && (
        <div className="rc-stats five">
          <StatTile label={t.summary.validators} value={fmt(validatorCount || nodes.length)} />
          <StatTile label={t.summary.peers} value={fmt(nodes.reduce((s, n) => s + n.stats.connected_peers, 0))} />
          <StatTile label={t.summary.tip} value={maxHeight !== null ? fmt(maxHeight) : "—"} />
          <StatTile label={t.summary.finalized} value={maxFinal !== null ? fmt(maxFinal) : "—"} />
          <StatTile label={t.summary.mining} value={fmt(nodes.filter((n) => n.stats.is_mining).length)} />
        </div>
      )}
      {nodes.length === 0 ? (
        checking ? (
          <EmptyState title={t.scanning}>{t.scanningBody}</EmptyState>
        ) : (
          <EmptyState title={t.none}>{t.noneBody}</EmptyState>
        )
      ) : (
        <div className="rc-node-cards">
          {nodes.map((n, i) => (
            <article key={n.stats.node_id || n.baseUrl} className="surface rc-panel">
              <div className="panel-head">
                <h3>
                  {t.card.core(i + 1)} {n.stats.is_mining && <span className="pill">{t.card.mining}</span>}
                </h3>
                <span className="mono muted" title={n.stats.node_id}>
                  {n.stats.node_id.slice(0, 8)}…
                </span>
              </div>
              <div className="rc-mini-stats">
                <StatTile label={t.card.peers} value={fmt(n.stats.connected_peers)} />
                <StatTile label={t.card.tip} value={fmt(n.stats.network_height)} />
                <StatTile label={t.card.mining} value={n.stats.is_mining ? t.card.yes : t.card.no} />
                <StatTile label={t.card.finalized} value={fmt(n.stats.finalized_height)} />
              </div>
              <p className="form-hint mono">
                {t.card.chain}: {n.stats.chain_id || n.health.chain_id || "unknown"}
                {n.port ? ` · ${t.card.port}: ${n.port}` : ""} · {t.card.fees}: {n.stats.total_fees_collected.toFixed(2)} XRGE ·{" "}
                {t.card.lastBlock}: {n.stats.fees_in_last_block.toFixed(2)} XRGE
              </p>
            </article>
          ))}
        </div>
      )}
      {chains.length > 1 && <p className="form-hint">{t.chains(chains.join(", "))}</p>}
    </section>
  );
}

export default function Node() {
  useRouteSeo(seo.node);
  return (
    <PageFrame eyebrow={t.eyebrow} title={t.title} lead={t.lead}>
      <TestnetNotice>{t.testnetHint}</TestnetNotice>
      <Dashboard />

      <section className="rc-block" aria-labelledby="needs">
        <h2 id="needs">{t.needTitle}</h2>
        <ul className="rc-chips">
          {t.needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>

      <section className="rc-block" aria-labelledby="steps">
        <h2 id="steps">{t.stepsTitle}</h2>
        <ol className="rc-steps numbered">
          {t.steps.map((s) => (
            <li key={s.title} className="surface">
              <strong>{s.title}</strong>
              <p>{s.body}</p>
              {s.code.map((c) => (
                <CopyCode key={c} text={c} />
              ))}
            </li>
          ))}
        </ol>
        <h3>{t.optionsTitle}</h3>
        <dl className="surface rc-asks">
          {t.options.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                <code className="mono">{v}</code>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rc-block" aria-labelledby="become">
        <h2 id="become">{t.validatorTitle}</h2>
        <p className="muted">{t.validatorLead}</p>
        <ol className="rc-steps numbered">
          {t.validatorSteps.map(([title, body]) => (
            <li key={title} className="surface">
              <strong>{title}</strong>
              <p>{body}</p>
            </li>
          ))}
        </ol>
        <CopyCode text={t.validatorCommand} />
        <div className="actions">
          <Link className="button" to="/validators">
            {t.validatorsLink}
          </Link>
          <a className="button outline" href="https://docs.rougechain.io/staking/becoming-validator.html" target="_blank" rel="noopener noreferrer">
            {t.guideLink}
          </a>
        </div>
      </section>
    </PageFrame>
  );
}
