import { Link } from "react-router-dom";
import { EmptyState, Status } from "@rougechain/ui";
import { useChain } from "../explorer/chain";
import { CopyCode, PageFrame, StatTile, TestnetNotice, useRouteSeo } from "./common";
import { useTranslation } from "react-i18next";
import { fmtInt } from "../i18n/format";
import { useNodeScan } from "./node-data";

const fmt = fmtInt;
const NEEDS = ["computer", "tooling", "internet"] as const;
const STEPS: { key: string; code: string[] }[] = [
  {
    key: "docker",
    code: ["docker run -d --name rougechain-node -p 5100:5100 -v qv-data:/data rougechain/node --mine --peers https://api.rougechain.io/api"],
  },
  { key: "rust", code: ["curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"] },
  {
    key: "build",
    code: [
      "git clone https://github.com/cyberdreadx/rougechain-node.git",
      "cd rougechain-node/core && cargo build --release -p quantum-vault-daemon",
    ],
  },
  {
    key: "start",
    code: [
      './target/release/quantum-vault-daemon --genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1 --api-port 5100 --peers "https://api.rougechain.io/api"',
    ],
  },
  {
    key: "name",
    code: [
      './target/release/quantum-vault-daemon --genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1 --api-port 5100 --node-name "MyAwesomeNode" --peers "https://api.rougechain.io/api"',
    ],
  },
];
const OPTIONS: [string, string][] = [
  ["mine", "--mine"],
  ["dataDir", "--data-dir ./my-data"],
  ["apiKeys", '--api-keys "key1,key2"'],
  ["publicUrl", '--public-url "https://yournode.com"'],
];
const VALIDATOR_STEPS = ["find", "fund", "stake", "mine"] as const;
const VALIDATOR_COMMAND =
  './target/release/quantum-vault-daemon --genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1 --api-port 5100 --mine --node-name "MyValidator" --peers "https://api.rougechain.io/api"';

function Dashboard() {
  const { t } = useTranslation("pages");
  const { network } = useChain();
  const { nodes, validatorCount, checking } = useNodeScan(network);
  const maxHeight = nodes.length ? Math.max(...nodes.map((n) => n.stats.network_height)) : null;
  const maxFinal = nodes.length ? Math.max(...nodes.map((n) => n.stats.finalized_height)) : null;
  const chains = [...new Set(nodes.map((n) => n.stats.chain_id).filter(Boolean))];
  return (
    <section className="rc-block" aria-labelledby="live-nodes">
      <div className="panel-head">
        <h2 id="live-nodes">{t("node.dashboardTitle")}</h2>
        <Status state={checking && !nodes.length ? "loading" : nodes.length ? "live" : "unavailable"}>
          {checking && !nodes.length
            ? t("node.scanning")
            : nodes.length
              ? t("node.online", { count: validatorCount || nodes.length })
              : t("node.none")}
        </Status>
      </div>
      {nodes.length > 0 && (
        <div className="rc-stats five">
          <StatTile label={t("node.summary.validators")} value={fmt(validatorCount || nodes.length)} />
          <StatTile label={t("node.summary.peers")} value={fmt(nodes.reduce((s, n) => s + n.stats.connected_peers, 0))} />
          <StatTile label={t("node.summary.tip")} value={maxHeight !== null ? fmt(maxHeight) : "—"} />
          <StatTile label={t("node.summary.finalized")} value={maxFinal !== null ? fmt(maxFinal) : "—"} />
          <StatTile label={t("node.summary.mining")} value={fmt(nodes.filter((n) => n.stats.is_mining).length)} />
        </div>
      )}
      {nodes.length === 0 ? (
        checking ? (
          <EmptyState title={t("node.scanning")}>{t("node.scanningBody")}</EmptyState>
        ) : (
          <EmptyState title={t("node.none")}>{t("node.noneBody")}</EmptyState>
        )
      ) : (
        <div className="rc-node-cards">
          {nodes.map((n, i) => (
            <article key={n.stats.node_id || n.baseUrl} className="surface rc-panel">
              <div className="panel-head">
                <h3>
                  {t("node.card.core", { n: i + 1 })} {n.stats.is_mining && <span className="pill">{t("node.card.mining")}</span>}
                </h3>
                <span className="mono muted" title={n.stats.node_id}>
                  {n.stats.node_id.slice(0, 8)}…
                </span>
              </div>
              <div className="rc-mini-stats">
                <StatTile label={t("node.card.peers")} value={fmt(n.stats.connected_peers)} />
                <StatTile label={t("node.card.tip")} value={fmt(n.stats.network_height)} />
                <StatTile label={t("node.card.mining")} value={n.stats.is_mining ? t("node.card.yes") : t("node.card.no")} />
                <StatTile label={t("node.card.finalized")} value={fmt(n.stats.finalized_height)} />
              </div>
              <p className="form-hint mono">
                {t("node.card.chain")}: {n.stats.chain_id || n.health.chain_id || t("common.unknown")}
                {n.port ? ` · ${t("node.card.port")}: ${n.port}` : ""} · {t("node.card.fees")}: {n.stats.total_fees_collected.toFixed(2)} XRGE ·{" "}
                {t("node.card.lastBlock")}: {n.stats.fees_in_last_block.toFixed(2)} XRGE
              </p>
            </article>
          ))}
        </div>
      )}
      {chains.length > 1 && <p className="form-hint">{t("node.chains", { ids: chains.join(", ") })}</p>}
    </section>
  );
}

export default function Node() {
  const { t } = useTranslation("pages");
  useRouteSeo({ title: t("seo.node.title"), description: t("seo.node.description") });
  return (
    <PageFrame eyebrow={t("node.eyebrow")} title={t("node.title")} lead={t("node.lead")}>
      <TestnetNotice>{t("node.testnetHint")}</TestnetNotice>
      <Dashboard />

      <section className="rc-block" aria-labelledby="needs">
        <h2 id="needs">{t("node.needTitle")}</h2>
        <ul className="rc-chips">
          {NEEDS.map((n) => (
            <li key={n}>{t(`node.needs.${n}`)}</li>
          ))}
        </ul>
      </section>

      <section className="rc-block" aria-labelledby="steps">
        <h2 id="steps">{t("node.stepsTitle")}</h2>
        <ol className="rc-steps numbered">
          {STEPS.map((s) => (
            <li key={s.key} className="surface">
              <strong>{t(`node.steps.${s.key}.title`)}</strong>
              <p>{t(`node.steps.${s.key}.body`)}</p>
              {s.code.map((c) => (
                <CopyCode key={c} text={c} />
              ))}
            </li>
          ))}
        </ol>
        <h3>{t("node.optionsTitle")}</h3>
        <dl className="surface rc-asks">
          {OPTIONS.map(([k, v]) => (
            <div key={k}>
              <dt>{t(`node.options.${k}`)}</dt>
              <dd>
                <code className="mono">{v}</code>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rc-block" aria-labelledby="become">
        <h2 id="become">{t("node.validatorTitle")}</h2>
        <p className="muted">{t("node.validatorLead")}</p>
        <ol className="rc-steps numbered">
          {VALIDATOR_STEPS.map((k) => (
            <li key={k} className="surface">
              <strong>{t(`node.validatorSteps.${k}.title`)}</strong>
              <p>{t(`node.validatorSteps.${k}.body`)}</p>
            </li>
          ))}
        </ol>
        <CopyCode text={VALIDATOR_COMMAND} />
        <div className="actions">
          <Link className="button" to="/validators">
            {t("node.validatorsLink")}
          </Link>
          <a className="button outline" href="https://docs.rougechain.io/staking/becoming-validator.html" target="_blank" rel="noopener noreferrer">
            {t("node.guideLink")}
          </a>
        </div>
      </section>
    </PageFrame>
  );
}
