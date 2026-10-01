/**
 * The real Swap page lives in src/pages/Swap.tsx (routes in src/features/swap.tsx).
 *
 * What remains here is ONLY the illustrative quote used by the workspace preview card
 * (src/explore/Previews.tsx, owned by the workspace): it never reaches a node and is labelled as a
 * preview there. Swap that preview to real data (or remove it) and delete this file.
 */
export const tokens = ["XRGE", "qETH", "qUSDC"] as const;
type Token = (typeof tokens)[number];
const previewPrices: Record<Token, number> = { XRGE: 0.096, qETH: 3000, qUSDC: 1 };
/** PREVIEW ONLY: illustrative quote for the workspace card; not used by the Swap app. */
export function quote(amount: string, pay: Token, receive: Token) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > 1e12 || pay === receive) return null;
  return (value * previewPrices[pay]) / previewPrices[receive];
}
