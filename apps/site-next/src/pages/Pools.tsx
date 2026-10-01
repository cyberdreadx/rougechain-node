/**
 * Pools and positions (apps/web /pools; Anders' /swap/pools and /swap/positions are views of the
 * same data): the node's pools, the wallet's LP positions with uncollected fees (the node's LP
 * fee ledger), and add / remove / collect / create through core's secure-api.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowDownUp, Plus, Search, TrendingUp } from "lucide-react";
import { Button, EmptyState } from "@rougechain/ui";
import { NetworkBadge } from "../explorer/ui";
import { useWallet } from "../wallet/WalletProvider";
import { useDexBalances, useEarnings, usePools, useRefreshAfterWrite, useSignState, useTokenImages, useUsdPrices } from "../swap/hooks";
import { sortPools } from "../swap/amm";
import { PoolCard } from "../swap/PoolCard";
import { useLiquidityActions } from "../swap/LiquidityActions";
import { SignGate } from "../swap/parts";
import "../swap/swap.css";

const DISPLAY_LIMIT = 20;

export default function Pools({ view = "pools" }: { view?: "pools" | "positions" }) {
  const { t } = useTranslation("swap");
  const { status } = useWallet();
  const pools = usePools();
  const balances = useDexBalances();
  const earnings = useEarnings(pools.data, balances.data?.lp);
  const image = useTokenImages();
  const usd = useUsdPrices(pools.data);
  const sign = useSignState();
  const refresh = useRefreshAfterWrite();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const actions = useLiquidityActions({
    sign,
    balances: balances.data,
    earnings: earnings.data,
    pools: pools.data ?? [],
    onDone: refresh,
  });

  const lp = balances.data?.lp ?? {};
  const all = pools.data ?? [];
  const base = view === "positions" ? all.filter((p) => (lp[p.pool_id] || 0) > 0) : all;
  const sorted = sortPools(base, query);
  const shown = query || showAll || view === "positions" ? sorted : sorted.slice(0, DISPLAY_LIMIT);
  const canSign = sign.state === "ready";

  let body;
  if (pools.isPending) body = <EmptyState title={t("pools.loading")} />;
  else if (pools.isError)
    body = (
      <EmptyState title={t("pools.error")}>
        <Button variant="outline small" onClick={() => void pools.refetch()}>
          {t("common.retry")}
        </Button>
      </EmptyState>
    );
  else if (view === "positions" && status === "none") body = <EmptyState title={t("gate.noneTitle")}>{t("pools.positionsNeedWallet")}</EmptyState>;
  else if (view === "positions" && balances.isPending) body = <EmptyState title={t("common.loading")} />;
  else if (base.length === 0)
    body =
      view === "positions" ? (
        <EmptyState title={t("pools.noPositionsTitle")}>{t("pools.noPositionsBody")}</EmptyState>
      ) : (
        <EmptyState title={t("pools.emptyTitle")}>{t("pools.emptyBody")}</EmptyState>
      );
  else if (sorted.length === 0) body = <EmptyState title={t("pools.noMatch", { query })} />;
  else
    body = (
      <>
        <div className="dex-pool-list">
          {shown.map((p) => (
            <PoolCard
              key={p.pool_id}
              pool={p}
              lp={lp[p.pool_id] || 0}
              earned={earnings.data ? earnings.data[p.pool_id] : undefined}
              usd={usd}
              image={image}
              canSign={canSign}
              onAdd={() => actions.add(p)}
              onRemove={() => actions.remove(p)}
              onCollect={() => actions.collect(p)}
            />
          ))}
        </div>
        {shown.length < sorted.length && (
          <div className="dex-center">
            <Button variant="ghost small" onClick={() => setShowAll(true)}>
              {t("pools.showAll", { count: sorted.length })}
            </Button>
          </div>
        )}
      </>
    );

  return (
    <main id="main" className="app-main dex-main">
      <div className="container">
        <div className="app-page-heading">
          <div className="heading-copy">
            <div className="eyebrow">{t("pools.eyebrow")}</div>
            <h1>{view === "positions" ? t("pools.positionsTitle") : t("pools.title")}</h1>
            <p>{t("pools.intro")}</p>
          </div>
          <div className="dex-heading-aside">
            <NetworkBadge />
            <div className="dex-heading-actions">
              <Link className="button secondary small" to="/swap">
                <ArrowDownUp size={14} aria-hidden="true" /> {t("pools.swap")}
              </Link>
              <Button variant="outline small" disabled={!canSign} onClick={actions.create}>
                <Plus size={14} aria-hidden="true" /> {t("pools.newPool")}
              </Button>
            </div>
          </div>
        </div>
        <nav className="mode-switch tabs dex-tabs" aria-label={t("pools.title")}>
          <Link className={`button small ${view === "pools" ? "secondary" : "ghost"}`} aria-current={view === "pools" ? "page" : undefined} to="/pools">
            {t("pools.tabs.pools")}
          </Link>
          <Link
            className={`button small ${view === "positions" ? "secondary" : "ghost"}`}
            aria-current={view === "positions" ? "page" : undefined}
            to="/swap/positions"
          >
            {t("pools.tabs.positions")}
          </Link>
        </nav>
        {!canSign && status !== "none" && <SignGate sign={sign} compact />}
        {all.length > 0 && (
          <label className="field dex-search-field">
            <span className="sr-only">{t("pools.search")}</span>
            <span className="dex-search">
              <Search size={15} aria-hidden="true" />
              <input className="input" value={query} placeholder={t("pools.search")} onChange={(e) => setQuery(e.target.value)} />
            </span>
          </label>
        )}
        {body}
        <aside className="surface dex-info">
          <TrendingUp size={18} aria-hidden="true" />
          <div>
            <strong>{t("pools.earnInfoTitle")}</strong>
            <p>{t("pools.earnInfo")}</p>
          </div>
        </aside>
      </div>
      {actions.dialogs}
    </main>
  );
}
