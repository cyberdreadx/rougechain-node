/**
 * Pool price chart (line or candles) as plain SVG — apps/web uses recharts; site-next has no
 * chart library, so this draws the same series: the node's price snapshots, humanized.
 */
import { useMemo } from "react";
import { fmtPrice } from "./amm";
import { fmtDateTime } from "../i18n/format";

export interface PricePoint {
  timestamp: number;
  price: number;
}

interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const INTERVALS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 43_200_000, 86_400_000, 604_800_000];
const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

/** OHLC buckets (apps/web CandleChart `buildCandles`): the smallest interval giving ≤ ~target candles. */
export function buildCandles(points: PricePoint[], target = 40): Candle[] {
  const pts = points.filter((p) => p.price > 0 && Number.isFinite(p.price)).sort((a, b) => a.timestamp - b.timestamp);
  if (!pts.length) return [];
  const span = toMs(pts[pts.length - 1].timestamp) - toMs(pts[0].timestamp) || 1;
  const interval = INTERVALS.find((i) => i >= span / target) ?? INTERVALS[INTERVALS.length - 1];
  const buckets = new Map<number, Candle>();
  for (const p of pts) {
    const key = Math.floor(toMs(p.timestamp) / interval) * interval;
    const c = buckets.get(key);
    if (!c) buckets.set(key, { t: key, open: p.price, high: p.price, low: p.price, close: p.price });
    else {
      c.high = Math.max(c.high, p.price);
      c.low = Math.min(c.low, p.price);
      c.close = p.price;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

const W = 720;
const H = 260;
const PAD = { l: 8, r: 70, t: 12, b: 24 };

export function PriceChart({ points, type, label }: { points: PricePoint[]; type: "line" | "candles"; label: string }) {
  const data = useMemo(() => points.filter((p) => p.price > 0 && Number.isFinite(p.price)), [points]);
  const candles = useMemo(() => (type === "candles" ? buildCandles(data) : []), [data, type]);
  if (!data.length) return null;
  const lo = type === "candles" ? Math.min(...candles.map((c) => c.low)) : Math.min(...data.map((p) => p.price));
  const hi = type === "candles" ? Math.max(...candles.map((c) => c.high)) : Math.max(...data.map((p) => p.price));
  const range = hi - lo || hi * 0.01 || 1;
  const y = (v: number) => PAD.t + (1 - (v - lo) / range) * (H - PAD.t - PAD.b);
  const iw = W - PAD.l - PAD.r;
  const ticks = [hi, lo + range / 2, lo];
  const first = toMs(data[0].timestamp);
  const last = toMs(data[data.length - 1].timestamp);
  const fmtT = (ms: number) => fmtDateTime(ms, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <svg className="dex-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="dex-chart-grid" />
          <text x={W - PAD.r + 6} y={y(v) + 4} className="dex-chart-axis">
            {fmtPrice(v)}
          </text>
        </g>
      ))}
      {type === "line" ? (
        <polyline
          className="dex-chart-line"
          fill="none"
          points={data.map((p, i) => `${PAD.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw)},${y(p.price)}`).join(" ")}
        />
      ) : (
        candles.map((c, i) => {
          const step = iw / candles.length;
          const x = PAD.l + step * i + step / 2;
          const up = c.close >= c.open;
          const bw = Math.max(2, Math.min(14, step * 0.6));
          return (
            <g key={c.t} className={up ? "dex-up" : "dex-down"}>
              <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} />
              <rect x={x - bw / 2} width={bw} y={Math.min(y(c.open), y(c.close))} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
            </g>
          );
        })
      )}
      <text x={PAD.l} y={H - 6} className="dex-chart-axis">
        {fmtT(first)}
      </text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end" className="dex-chart-axis">
        {fmtT(last)}
      </text>
    </svg>
  );
}
