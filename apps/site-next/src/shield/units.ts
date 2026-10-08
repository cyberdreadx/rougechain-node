/** XRGE ⇄ quanta (1 XRGE = 10^9 quanta), as decimal strings: a JavaScript number cannot hold a u64. */
export const QUANTA_PER_XRGE = 1_000_000_000n;

/** "1.5" → "1500000000"; null when it is not a positive amount with at most 9 decimals. */
export function toQuanta(xrge: string): string | null {
  const m = /^\s*(\d+)(?:\.(\d{0,9}))?\s*$/.exec(xrge);
  if (!m) return null;
  const q = BigInt(m[1]) * QUANTA_PER_XRGE + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  return q > 0n && q < 1n << 64n ? q.toString() : null;
}

/** "1500000000" → "1.5". */
export function fromQuanta(quanta: string | bigint): string {
  const q = BigInt(quanta);
  const whole = q / QUANTA_PER_XRGE;
  const frac = (q % QUANTA_PER_XRGE).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
