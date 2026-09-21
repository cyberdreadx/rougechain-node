import { useMemo } from "react";
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

/** One price observation (already decimals-adjusted to a human price). */
export interface PricePoint {
  timestamp: number;
  price: number;
}

interface Candle {
  t: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** [low, high] range the recharts Bar spans; the custom shape draws the candle inside it. */
  range: [number, number];
}

const UP = "#22c55e";
const DOWN = "#ef4444";

// Candle bucket sizes, smallest → largest (ms). We pick the smallest that keeps the
// candle count reasonable for the data's time span.
const INTERVALS = [
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000,
  24 * 60 * 60_000, 7 * 24 * 60 * 60_000,
];

function pickInterval(spanMs: number, target: number): number {
  const raw = spanMs / target;
  for (const i of INTERVALS) if (i >= raw) return i;
  return INTERVALS[INTERVALS.length - 1];
}

function fmtTime(ts: number, intervalMs: number): string {
  const d = new Date(ts);
  // Show a date for day+ candles, a time for intraday.
  if (intervalMs >= 24 * 60 * 60_000) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Aggregate raw price points into OHLC candles. Zero/invalid prices are dropped. */
function buildCandles(points: PricePoint[], target = 40): Candle[] {
  const pts = points
    .filter((p) => p.price > 0 && Number.isFinite(p.price))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (pts.length === 0) return [];

  const span = pts[pts.length - 1].timestamp - pts[0].timestamp || 1;
  const interval = pickInterval(span, target);

  const buckets = new Map<number, Candle>();
  for (const p of pts) {
    const key = Math.floor(p.timestamp / interval) * interval;
    const c = buckets.get(key);
    if (!c) {
      buckets.set(key, {
        t: key, time: fmtTime(key, interval),
        open: p.price, high: p.price, low: p.price, close: p.price,
        range: [p.price, p.price],
      });
    } else {
      c.high = Math.max(c.high, p.price);
      c.low = Math.min(c.low, p.price);
      c.close = p.price;
    }
  }

  const arr = [...buckets.values()].sort((a, b) => a.t - b.t);
  // Chain candles: each open = the previous candle's close, so direction is visible even
  // when a bucket holds a single observation (otherwise every candle is a flat doji).
  let prevClose: number | null = null;
  for (const c of arr) {
    if (prevClose !== null) {
      c.open = prevClose;
      c.high = Math.max(c.high, c.open);
      c.low = Math.min(c.low, c.open);
    }
    prevClose = c.close;
    c.range = [c.low, c.high];
  }
  return arr;
}

/** Custom recharts shape: draws a wick (high→low) + body (open↔close) for one candle. */
function CandleShape(props: any) {
  const { x, width, y, height, payload } = props;
  const { open, high, low, close } = payload as Candle;
  const up = close >= open;
  const color = up ? UP : DOWN;
  // The Bar spans [low, high]: y is the pixel of `high`, y+height the pixel of `low`.
  const span = high - low;
  const yOf = (v: number) => (span > 0 ? y + ((high - v) / span) * height : y);
  const openY = yOf(open);
  const closeY = yOf(close);
  const bodyTop = Math.min(openY, closeY);
  const bodyH = Math.max(Math.abs(closeY - openY), 1);
  const cx = x + width / 2;
  const bodyW = Math.max(width * 0.6, 2);
  const bodyX = cx - bodyW / 2;
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={bodyX} y={bodyTop} width={bodyW} height={bodyH} fill={color} rx={1} />
    </g>
  );
}

function CandleTooltip({ active, payload, fmt }: any) {
  if (!active || !payload?.length) return null;
  const c = payload[0].payload as Candle;
  const up = c.close >= c.open;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 text-muted-foreground">{c.time}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
        <span className="text-muted-foreground">O</span><span>{fmt(c.open)}</span>
        <span className="text-muted-foreground">H</span><span>{fmt(c.high)}</span>
        <span className="text-muted-foreground">L</span><span>{fmt(c.low)}</span>
        <span className="text-muted-foreground">C</span>
        <span style={{ color: up ? UP : DOWN }}>{fmt(c.close)}</span>
      </div>
    </div>
  );
}

interface Props {
  points: PricePoint[];
  fmtPrice: (v: number) => string;
  height?: number;
}

export function CandleChart({ points, fmtPrice, height = 300 }: Props) {
  const candles = useMemo(() => buildCandles(points), [points]);

  if (candles.length === 0) {
    return (
      <div className="flex items-center justify-center text-muted-foreground" style={{ height }}>
        No price history yet. Make some swaps to see the chart!
      </div>
    );
  }

  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const pad = (max - min) * 0.08 || max * 0.08 || 1;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={candles} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="time"
          stroke="hsl(var(--muted-foreground))"
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
          minTickGap={24}
        />
        <YAxis
          type="number"
          domain={[min - pad, max + pad]}
          stroke="hsl(var(--muted-foreground))"
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
          tickFormatter={(v) => fmtPrice(v)}
          width={72}
        />
        <Tooltip content={<CandleTooltip fmt={fmtPrice} />} />
        <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
