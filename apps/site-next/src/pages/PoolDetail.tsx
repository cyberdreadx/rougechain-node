/**
 * One pool (apps/web /pool/:poolId): reserves, swap stats, price chart, the wallet's position with
 * add / remove / collect fees, and the pool's transaction history.
 */
import { useMemo, useState } from "react";
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
import { S } from "../swap/strings";
import "../swap/swap.css";

function eventLabel(e: PoolEvent, pool: Pool): string {
  switch (e.event_type) {
    case "Swap":
      return S.detail.ev.swap(fmtAmount(e.amount_in || 0, e.token_in), e.token_in ?? "", fmtAmount(e.amount_out || 0, e.token_out), e.token_out ?? "");
    case "AddLiquidity":
      return S.detail.ev.add(fmtAmount(e.amount_a || 0, pool.token_a), pool.token_a, fmtAmount(e.amount_b || 0, pool.token_b), pool.token_b);
    case "RemoveLiquidity":
      return S.detail.ev.remove(fmtLp(e.lp_amount || 0));
    case "CreatePool":
      return S.detail.ev.create;
    default:
      return e.event_type;
  }
}

const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

export default function PoolDetail() {
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
          <EmptyState title={S.common.loading} />
        </div>
      </main>
    );
  if (pool.isError || !p)
    return (
      <main id="main" className="app-main dex-main">
        <div className="container">
          {pool.isError ? (
            <EmptyState title={S.detail.error}>
              <Button variant="outline small" onClick={() => void pool.refetch()}>
                {S.common.retry}
              </Button>
            </EmptyState>
          ) : (
            <NotFoundState title={S.detail.notFoundTitle} back={{ to: "/pools", label: S.detail.back }}>
              {S.detail.notFoundBody(poolId)}
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
          <ArrowLeft size={14} aria-hidden="true" /> {S.detail.back}
        </Link>
        <div className="app-page-heading">
          <div className="heading-copy">
            <div className="eyebrow">{S.detail.eyebrow}</div>
            <h1 className="dex-detail-title">
              <PairIcons a={p.token_a} b={p.token_b} image={image} />
              {p.token_a}/{p.token_b}
            </h1>
            <p>
              {S.detail.poolId(p.pool_id)} · {S.pools.fee(feePct(p))}
            </p>
          </div>
          <div className="dex-heading-aside">
            <NetworkBadge />
            <div className="dex-heading-actions">
              <Link className="button small" to={`/swap?tokenIn=${encodeURIComponent(p.token_a)}&tokenOut=${encodeURIComponent(p.token_b)}`}>
                <ArrowDownUp size={14} aria-hidden="true" /> {S.detail.swapPair}
              </Link>
            </div>
          </div>
        </div>

        <div className="dex-metrics dex-metrics-wide">
          <Metric label={S.pools.reserve(p.token_a)} value={<span className="mono">{fmtAmount(p.reserve_a, p.token_a)}</span>} />
          <Metric label={S.pools.reserve(p.token_b)} value={<span className="mono">{fmtAmount(p.reserve_b, p.token_b)}</span>} />
          <Metric label={S.pools.tvl} value={<span className="mono">{tvlText(p, usd)}</span>} />
          <Metric label={S.detail.totalSwaps} value={<span className="mono">{stats.data?.total_swaps ?? 0}</span>} />
          <Metric label={S.detail.swaps24h} value={<span className="mono">{stats.data?.swap_count_24h ?? 0}</span>} />
        </div>

        <section className="surface dex-panel" aria-labelledby="pool-chart">
          <div className="dex-panel-head">
            <div>
              <h2 id="pool-chart">{S.detail.chart}</h2>
              <p className="dex-price">
                <strong className="mono">{fmtPrice(current)}</strong> <span className="muted">{S.detail.per(quote, base)}</span>
                {change !== 0 && <span className={`pill ${change >= 0 ? "ok" : "warning"}`}>{`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span>}
              </p>
            </div>
            <div className="dex-chart-controls">
              <div className="mode-switch" role="group" aria-label={S.detail.chart}>
                {(["a", "b"] as const).map((s) => (
                  <Button key={s} variant={side === s ? "secondary small" : "ghost small"} aria-pressed={side === s} onClick={() => setSide(s)}>
                    {s === "a" ? `${p.token_a}/${p.token_b}` : `${p.token_b}/${p.token_a}`}
                  </Button>
                ))}
              </div>
              <div className="mode-switch" role="group" aria-label="Chart type">
                {(["line", "candles"] as const).map((t) => (
                  <Button key={t} variant={chart === t ? "secondary small" : "ghost small"} aria-pressed={chart === t} onClick={() => setChart(t)}>
                    {t === "line" ? S.detail.line : S.detail.candles}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          {series.length ? (
            <PriceChart points={series} type={chart} label={`${S.detail.chart} · ${S.detail.per(quote, base)}`} />
          ) : (
            <EmptyState title={prices.isPending ? S.common.loading : S.detail.noPrices} />
          )}
        </section>

        <section className="surface dex-panel" aria-labelledby="pool-position">
          <div className="dex-panel-head">
            <h2 id="pool-position">{S.detail.position}</h2>
            <div className="dex-heading-actions">
              <Button variant="outline small" disabled={!canSign} onClick={() => actions.add(p)}>
                <Plus size={14} aria-hidden="true" /> {S.pools.add}
              </Button>
              <Button variant="outline small" disabled={!canSign || lp <= 0} onClick={() => actions.remove(p)}>
                <Minus size={14} aria-hidden="true" /> {S.pools.remove}
              </Button>
            </div>
          </div>
          {!canSign && <SignGate sign={sign} compact />}
          {balances.data && (
            <div className="dex-metrics">
              <Metric label={S.pools.yourLp} value={<span className="mono">{fmtLp(lp)}</span>} />
              <Metric label={S.pools.share} value={<span className="mono">{(poolShare(lp, p) * 100).toFixed(2)}%</span>} />
            </div>
          )}
          {lp > 0 && (
            <EarningsRow pool={p} earned={earnings.data ? earnings.data[p.pool_id] : undefined} canSign={canSign} onCollect={() => actions.collect(p)} />
          )}
        </section>

        <section className="surface dex-panel" aria-labelledby="pool-history">
          <div className="dex-panel-head">
            <h2 id="pool-history">{S.detail.history}</h2>
          </div>
          {ev.length === 0 ? (
            <EmptyState title={events.isPending ? S.common.loading : S.detail.noEvents} />
          ) : (
            <div className="table-scroll">
              <table className="stack-table">
                <thead>
                  <tr>
                    <th>{S.detail.event}</th>
                    <th>{S.detail.by}</th>
                    <th>{S.detail.block}</th>
                    <th>{S.detail.time}</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.map((e) => (
                    <tr key={e.id}>
                      <td data-label={S.detail.event}>
                        <span className={`dex-ev dex-ev-${e.event_type}`}>{eventLabel(e, p)}</span>
                      </td>
                      <td data-label={S.detail.by}>
                        <AddressLink identity={e.user_pub_key} />
                      </td>
                      <td data-label={S.detail.block}>
                        <BlockLink height={e.block_height} />
                      </td>
                      <td data-label={S.detail.time}>
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
