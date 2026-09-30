/**
 * One pool (apps/web /pool/:poolId): reserves, swap stats, price chart, the wallet's position with
 * add / remove / collect fees, and the pool's transaction history.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link, useParams } from "react-router-dom";
import { ArrowDownUp, ArrowLeft, Minus, Plus } from "lucide-react";
import { Button, EmptyState, Metric } from "@rougechain/ui";
import { AddressLink, Age, BlockLink, NetworkBadge, NotFoundState } from "../explorer/ui";
import { useDexBalances, useEarnings, usePoolDetail, usePools, useRefreshAfterWrite, useSignState, useTokenImages, useUsdPrices } from "../swap/hooks";
import type { Pool, PoolEvent } from "../swap/api";
import { fmtPrice, humanizePrice, poolShare, spotPrice } from "../swap/amm";
import { fmtAmount, fmtLp } from "../swap/amounts";
import { EarningsRow, feePct, tvlText } from "../swap/PoolCard";
import { PriceChart } from "../swap/PriceChart";
import { useLiquidityActions } from "../swap/LiquidityActions";
import { PairIcons, SignGate } from "../swap/parts";
import { fmtInt, fmtNum } from "../i18n/format";
import "../swap/swap.css";

function eventLabel(t: TFunction<"swap">, e: PoolEvent, pool: Pool): string {
  switch (e.event_type) {
    case "Swap":
      return t("detail.ev.swap", {
        amountIn: fmtAmount(e.amount_in || 0, e.token_in),
        tokenIn: e.token_in ?? "",
        amountOut: fmtAmount(e.amount_out || 0, e.token_out),
        tokenOut: e.token_out ?? "",
      });
    case "AddLiquidity":
      return t("detail.ev.add", {
        amountA: fmtAmount(e.amount_a || 0, pool.token_a),
        tokenA: pool.token_a,
        amountB: fmtAmount(e.amount_b || 0, pool.token_b),
        tokenB: pool.token_b,
      });
    case "RemoveLiquidity":
      return t("detail.ev.remove", { lp: fmtLp(e.lp_amount || 0) });
    case "CreatePool":
      return t("detail.ev.create");
    default:
      return e.event_type;
  }
}

const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

export default function PoolDetail() {
  const { t } = useTranslation("swap");
  const { poolId = "" } = useParams<{ poolId: string }>();
  const { pool, prices, events, stats } = usePoolDetail(poolId);
  const pools = usePools();
  const balances = useDexBalances();
  const p = pool.data ?? null;
  const poolList = useMemo(() => (p ? [p] : []), [p]);
  const earnings = useEarnings(poolList, balances.data?.lp);
  const image = useTokenImages();
  const usd = useUsdPrices(pools.data);
  const sign = useSignState();
  const refresh = useRefreshAfterWrite();
  const actions = useLiquidityActions({ sign, balances: balances.data, earnings: earnings.data, pools: pools.data ?? poolList, onDone: refresh });
  const [side, setSide] = useState<"a" | "b">("a");
  const [chart, setChart] = useState<"line" | "candles">("line");

  const series = useMemo(
    () =>
      p
        ? (prices.data ?? []).map((s) => ({
            timestamp: s.timestamp,
            price: humanizePrice(side === "a" ? s.price_a_in_b : s.price_b_in_a, p.token_a, p.token_b, side === "a"),
          }))
        : [],
    [prices.data, p, side],
  );

  if (pool.isPending)
    return (
      <main id="main" className="app-main dex-main">
        <div className="container">
          <EmptyState title={t("common.loading")} />
        </div>
      </main>
    );
  if (pool.isError || !p)
    return (
      <main id="main" className="app-main dex-main">
        <div className="container">
          {pool.isError ? (
            <EmptyState title={t("detail.error")}>
              <Button variant="outline small" onClick={() => void pool.refetch()}>
                {t("common.retry")}
              </Button>
            </EmptyState>
          ) : (
            <NotFoundState title={t("detail.notFoundTitle")} back={{ to: "/pools", label: t("detail.back") }}>
              {t("detail.notFoundBody", { id: poolId })}
            </NotFoundState>
          )}
        </div>
      </main>
    );

  const current = series.length ? series[series.length - 1].price : spotPrice(p, side === "a");
  const change = series.length > 1 && series[0].price ? ((series[series.length - 1].price - series[0].price) / series[0].price) * 100 : 0;
  const [base, quote] = side === "a" ? [p.token_a, p.token_b] : [p.token_b, p.token_a];
  const lp = balances.data?.lp[p.pool_id] || 0;
  const canSign = sign.state === "ready";
  const ev = events.data ?? [];

  return (
    <main id="main" className="app-main dex-main">
      <div className="container">
        <Link className="text-link dex-back" to="/pools">
          <ArrowLeft size={14} aria-hidden="true" /> {t("detail.back")}
        </Link>
        <div className="app-page-heading">
          <div className="heading-copy">
            <div className="eyebrow">{t("detail.eyebrow")}</div>
            <h1 className="dex-detail-title">
              <PairIcons a={p.token_a} b={p.token_b} image={image} />
              {p.token_a}/{p.token_b}
            </h1>
            <p>
              {t("detail.poolId", { id: p.pool_id })} · {t("pools.fee", { pct: feePct(p) })}
            </p>
          </div>
          <div className="dex-heading-aside">
            <NetworkBadge />
            <div className="dex-heading-actions">
              <Link className="button small" to={`/swap?tokenIn=${encodeURIComponent(p.token_a)}&tokenOut=${encodeURIComponent(p.token_b)}`}>
                <ArrowDownUp size={14} aria-hidden="true" /> {t("detail.swapPair")}
              </Link>
            </div>
          </div>
        </div>

        <div className="dex-metrics dex-metrics-wide">
          <Metric label={t("pools.reserve", { symbol: p.token_a })} value={<span className="mono">{fmtAmount(p.reserve_a, p.token_a)}</span>} />
          <Metric label={t("pools.reserve", { symbol: p.token_b })} value={<span className="mono">{fmtAmount(p.reserve_b, p.token_b)}</span>} />
          <Metric label={t("pools.tvl")} value={<span className="mono">{tvlText(p, usd)}</span>} />
          <Metric label={t("detail.totalSwaps")} value={<span className="mono">{fmtInt(stats.data?.total_swaps ?? 0)}</span>} />
          <Metric label={t("detail.swaps24h")} value={<span className="mono">{fmtInt(stats.data?.swap_count_24h ?? 0)}</span>} />
        </div>

        <section className="surface dex-panel" aria-labelledby="pool-chart">
          <div className="dex-panel-head">
            <div>
              <h2 id="pool-chart">{t("detail.chart")}</h2>
              <p className="dex-price">
                <strong className="mono">{fmtPrice(current)}</strong> <span className="muted">{t("detail.per", { quote, base })}</span>
                {change !== 0 && <span className={`pill ${change >= 0 ? "ok" : "warning"}`}>{`${change >= 0 ? "+" : ""}${fmtNum(change, 2, { minimumFractionDigits: 2 })}%`}</span>}
              </p>
            </div>
            <div className="dex-chart-controls">
              <div className="mode-switch" role="group" aria-label={t("detail.chart")}>
                {(["a", "b"] as const).map((s) => (
                  <Button key={s} variant={side === s ? "secondary small" : "ghost small"} aria-pressed={side === s} onClick={() => setSide(s)}>
                    {s === "a" ? `${p.token_a}/${p.token_b}` : `${p.token_b}/${p.token_a}`}
                  </Button>
                ))}
              </div>
              <div className="mode-switch" role="group" aria-label={t("detail.chartType")}>
                {(["line", "candles"] as const).map((kind) => (
                  <Button key={kind} variant={chart === kind ? "secondary small" : "ghost small"} aria-pressed={chart === kind} onClick={() => setChart(kind)}>
                    {kind === "line" ? t("detail.line") : t("detail.candles")}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          {series.length ? (
            <PriceChart points={series} type={chart} label={`${t("detail.chart")} · ${t("detail.per", { quote, base })}`} />
          ) : (
            <EmptyState title={prices.isPending ? t("common.loading") : t("detail.noPrices")} />
          )}
        </section>

        <section className="surface dex-panel" aria-labelledby="pool-position">
          <div className="dex-panel-head">
            <h2 id="pool-position">{t("detail.position")}</h2>
            <div className="dex-heading-actions">
              <Button variant="outline small" disabled={!canSign} onClick={() => actions.add(p)}>
                <Plus size={14} aria-hidden="true" /> {t("pools.add")}
              </Button>
              <Button variant="outline small" disabled={!canSign || lp <= 0} onClick={() => actions.remove(p)}>
                <Minus size={14} aria-hidden="true" /> {t("pools.remove")}
              </Button>
            </div>
          </div>
          {!canSign && <SignGate sign={sign} compact />}
          {balances.data && (
            <div className="dex-metrics">
              <Metric label={t("pools.yourLp")} value={<span className="mono">{fmtLp(lp)}</span>} />
              <Metric label={t("pools.share")} value={<span className="mono">{fmtNum(poolShare(lp, p) * 100, 2, { minimumFractionDigits: 2 })}%</span>} />
            </div>
          )}
          {lp > 0 && (
            <EarningsRow pool={p} earned={earnings.data ? earnings.data[p.pool_id] : undefined} canSign={canSign} onCollect={() => actions.collect(p)} />
          )}
        </section>

        <section className="surface dex-panel" aria-labelledby="pool-history">
          <div className="dex-panel-head">
            <h2 id="pool-history">{t("detail.history")}</h2>
          </div>
          {ev.length === 0 ? (
            <EmptyState title={events.isPending ? t("common.loading") : t("detail.noEvents")} />
          ) : (
            <div className="table-scroll">
              <table className="stack-table">
                <thead>
                  <tr>
                    <th>{t("detail.event")}</th>
                    <th>{t("detail.by")}</th>
                    <th>{t("detail.block")}</th>
                    <th>{t("detail.time")}</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.map((e) => (
                    <tr key={e.id}>
                      <td data-label={t("detail.event")}>
                        <span className={`dex-ev dex-ev-${e.event_type}`}>{eventLabel(t, e, p)}</span>
                      </td>
                      <td data-label={t("detail.by")}>
                        <AddressLink identity={e.user_pub_key} />
                      </td>
                      <td data-label={t("detail.block")}>
                        <BlockLink height={e.block_height} />
                      </td>
                      <td data-label={t("detail.time")}>
                        <Age ts={toMs(e.timestamp)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {actions.dialogs}
    </main>
  );
}
