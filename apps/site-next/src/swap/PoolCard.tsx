import { Link } from "react-router-dom";
import { BarChart3, Coins, Minus, Plus } from "lucide-react";
import { Button, Metric } from "@rougechain/ui";
import { formatUsd } from "@rougechain/core/price-service";
import { canCollect, type LpEarnings, type Pool } from "./api";
import { poolShare } from "./amm";
import { fmtAmount, fmtLp } from "./amounts";
import { PairIcons } from "./parts";
import { S } from "./strings";

export function feePct(pool: Pick<Pool, "fee_rate">): string {
  return `${((pool.fee_rate || 0.003) * 100).toFixed(1)}%`;
}

export function tvlText(pool: Pool, usd: Record<string, number>): string {
  const pa = usd[pool.token_a];
  const pb = usd[pool.token_b];
  if (pa && pb) return formatUsd(pool.reserve_a * pa + pool.reserve_b * pb);
  if (pa) return formatUsd(pool.reserve_a * pa * 2);
  if (pb) return formatUsd(pool.reserve_b * pb * 2);
  return `${fmtAmount(pool.reserve_a, pool.token_a)} ${pool.token_a} + ${fmtAmount(pool.reserve_b, pool.token_b)} ${pool.token_b}`;
}

/** Uncollected fees line + Collect button for a held position (apps/web Pools card). */
export function EarningsRow({
  pool,
  earned,
  canSign,
  onCollect,
}: {
  pool: Pool;
  earned: LpEarnings | null | undefined;
  canSign: boolean;
  onCollect: () => void;
}) {
  return (
    <div className="dex-earnings">
      <div>
        <small>{S.pools.uncollected}</small>
        {earned === undefined ? (
          <span className="muted">{S.pools.calculating}</span>
        ) : earned === null ? (
          <span className="muted">{S.pools.unavailable}</span>
        ) : (
          <strong className="mono">
            {fmtAmount(earned.earnedA, pool.token_a)} {pool.token_a} + {fmtAmount(earned.earnedB, pool.token_b)} {pool.token_b}
          </strong>
        )}
      </div>
      <Button variant="small" disabled={!canSign || !canCollect(earned ?? null)} onClick={onCollect}>
        <Coins size={14} aria-hidden="true" /> {S.pools.collect}
      </Button>
    </div>
  );
}

export function PoolCard({
  pool,
  lp,
  earned,
  usd,
  image,
  canSign,
  onAdd,
  onRemove,
  onCollect,
}: {
  pool: Pool;
  lp: number;
  earned: LpEarnings | null | undefined;
  usd: Record<string, number>;
  image: (s: string) => string | null;
  canSign: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onCollect: () => void;
}) {
  const pair = `${pool.token_a}/${pool.token_b}`;
  return (
    <article className="surface dex-pool" aria-label={pair}>
      <header className="dex-pool-head">
        <PairIcons a={pool.token_a} b={pool.token_b} image={image} />
        <div>
          <h2>
            <Link to={`/pool/${encodeURIComponent(pool.pool_id)}`}>{pair}</Link>
          </h2>
          <span className="pill">{S.pools.fee(feePct(pool))}</span>
        </div>
        <div className="dex-pool-tvl">
          <small>{S.pools.tvl}</small>
          <strong className="mono">{tvlText(pool, usd)}</strong>
        </div>
      </header>
      <div className="dex-metrics">
        <Metric label={S.pools.reserve(pool.token_a)} value={<span className="mono">{fmtAmount(pool.reserve_a, pool.token_a)}</span>} />
        <Metric label={S.pools.reserve(pool.token_b)} value={<span className="mono">{fmtAmount(pool.reserve_b, pool.token_b)}</span>} />
        <Metric label={S.pools.lpSupply} value={<span className="mono">{fmtLp(pool.total_lp_supply)}</span>} />
        <Metric
          label={S.pools.yourLp}
          value={
            <span className="mono">
              {fmtLp(lp)}
              {lp > 0 && <small> · {(poolShare(lp, pool) * 100).toFixed(2)}%</small>}
            </span>
          }
        />
      </div>
      {lp > 0 && <EarningsRow pool={pool} earned={earned} canSign={canSign} onCollect={onCollect} />}
      <div className="dex-pool-actions">
        <Link className="button secondary small" to={`/pool/${encodeURIComponent(pool.pool_id)}`}>
          <BarChart3 size={14} aria-hidden="true" /> {S.pools.details}
        </Link>
        <Button variant="outline small" disabled={!canSign} onClick={onAdd} aria-label={`${S.pools.add} · ${pair}`}>
          <Plus size={14} aria-hidden="true" /> {S.pools.add}
        </Button>
        <Button variant="outline small" disabled={!canSign || lp <= 0} onClick={onRemove} aria-label={`${S.pools.remove} · ${pair}`}>
          <Minus size={14} aria-hidden="true" /> {S.pools.remove}
        </Button>
      </div>
    </article>
  );
}
