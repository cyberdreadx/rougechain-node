/**
 * Pure helpers for token visuals: deterministic gradient monograms for tokens without a logo,
 * brand colours for the known bridged assets, and the pointer-tilt math used by the wallet hero.
 */

/** Gradient stops (HSL triplets, same notation as the CSS tokens) in the brand palette. */
export const MONOGRAM_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["349 100% 59%", "331 75% 51%"], // red -> magenta
  ["331 75% 51%", "262 87% 60%"], // magenta -> violet
  ["262 87% 60%", "166 86% 57%"], // violet -> teal
  ["166 86% 57%", "200 90% 55%"], // teal -> cyan
  ["290 80% 58%", "331 75% 51%"], // orchid -> magenta
  ["200 90% 55%", "262 87% 60%"], // cyan -> violet
  ["42 100% 58%", "349 100% 59%"], // amber -> red
  ["262 87% 60%", "349 100% 59%"], // violet -> red
];

/** FNV-1a 32-bit hash: stable across runs and platforms, cheap, good spread for short strings. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Letters shown in a monogram: up to two characters, skipping a leading bridge "q" prefix
 * (qFOO -> "FO"). Stablecoins with a "USD" root get "$". Empty/blank symbols get "?".
 */
export function monogramLetters(symbol: string): string {
  const s = (symbol ?? "").trim();
  if (!s) return "?";
  const upper = s.toUpperCase();
  if (/^Q?USD/.test(upper)) return "$";
  const core = /^q[A-Z0-9]/.test(s) && s.length > 2 ? s.slice(1) : s;
  const alnum = core.replace(/[^A-Za-z0-9]/g, "");
  if (!alnum) return s.charAt(0).toUpperCase();
  return alnum.slice(0, 2).toUpperCase();
}

export interface Monogram {
  letters: string;
  /** CSS colour for the first gradient stop. */
  from: string;
  /** CSS colour for the second gradient stop. */
  to: string;
  /** Gradient angle in degrees (varies per symbol so neighbouring icons don't look identical). */
  angle: number;
}

/** Deterministic gradient monogram for a symbol. Case-insensitive: "abc" and "ABC" match. */
export function monogramFor(symbol: string): Monogram {
  const key = (symbol ?? "").trim().toUpperCase();
  const h = hashString(key);
  const [a, b] = MONOGRAM_PALETTE[h % MONOGRAM_PALETTE.length];
  const angle = 120 + ((h >>> 8) % 6) * 20; // 120..220 deg
  return { letters: monogramLetters(symbol), from: `hsl(${a})`, to: `hsl(${b})`, angle };
}

/** Accent colour used for glow/rings around a token icon. Known assets keep their own colour. */
const KNOWN_TOKEN_COLORS: Record<string, string> = {
  XRGE: "hsl(331 75% 51%)",
  QETH: "#627EEA",
  QUSDC: "#2EE6A8",
  QBTC: "#F7931A",
};

export function tokenAccent(symbol: string): string {
  const known = KNOWN_TOKEN_COLORS[(symbol ?? "").trim().toUpperCase()];
  return known ?? monogramFor(symbol).from;
}

/**
 * Tilt angles (degrees) for a pointer at (px, py) inside a box of size (w, h). Returns 0/0 for a
 * degenerate box. `max` bounds the rotation; the pointer at an edge gives ±max.
 */
export function tiltFromPointer(
  px: number,
  py: number,
  w: number,
  h: number,
  max = 6,
): { rotateX: number; rotateY: number } {
  if (!(w > 0) || !(h > 0)) return { rotateX: 0, rotateY: 0 };
  const nx = Math.min(1, Math.max(0, px / w)) - 0.5; // -0.5..0.5
  const ny = Math.min(1, Math.max(0, py / h)) - 0.5;
  const round = (v: number) => Math.round(v * 100) / 100 + 0; // +0 normalises -0
  return { rotateX: round(-ny * 2 * max), rotateY: round(nx * 2 * max) };
}
