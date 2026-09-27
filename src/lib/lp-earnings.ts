/**
 * Liquidity-provider fee earnings for the native AMM.
 *
 * Swap fees (0.3%) stay in the pool reserves, so every LP share slowly grows in value.
 * We measure that growth as √(reserveA·reserveB) per share: a swap raises it by exactly the
 * fee it leaves behind, while adding or removing liquidity leaves it unchanged. Replaying the
 * pool's events gives, for a wallet, the share-growth it has paid in ("basis"). Whatever the
 * position is worth above that basis is fee income, and removing exactly that many LP tokens
 * collects it while leaving the original deposit in the pool.
 */

export interface LpPoolEvent {
  id: string;
  event_type: string;
  user_pub_key: string;
  timestamp: number;
  block_height: number;
  lp_amount?: number | null;
  reserve_a_after: number;
  reserve_b_after: number;
}

export interface LpPoolState {
  reserve_a: number;
  reserve_b: number;
  total_lp_supply: number;
}

export interface LpEarnings {
  /** LP tokens to remove to take only the fees. */
  lpToCollect: number;
  /** What that removal pays out, in raw token units (same rounding as the chain). */
  earnedA: number;
  earnedB: number;
  /** Fee growth of the position since deposit, e.g. 0.004 = +0.4%. */
  growth: number;
}

const sqrtK = (a: number, b: number) => Math.sqrt(Math.max(a, 0) * Math.max(b, 0));

/**
 * Returns the wallet's uncollected fees, or null when the event history doesn't fully
 * explain its LP balance (history truncated, or the node doesn't have the events).
 */
export function computeLpEarnings(
  events: LpPoolEvent[],
  pool: LpPoolState,
  userKeys: string[],
  userLp: number,
): LpEarnings | null {
  if (!userLp || userLp <= 0 || !pool.total_lp_supply) return null;
  const mine = new Set(userKeys.filter(Boolean));

  const ordered = [...events].sort(
    (x, y) => x.block_height - y.block_height || x.timestamp - y.timestamp || x.id.localeCompare(y.id),
  );

  let growth = 1; // share value relative to the first event we can see
  let prevK = 0;
  let lp = 0;
  let basis = 0; // deposit, in share-growth units (Σ lp × growth-at-entry)

  for (const e of ordered) {
    const k = sqrtK(e.reserve_a_after, e.reserve_b_after);
    const amount = e.lp_amount ?? 0;
    switch (e.event_type) {
      case "Swap":
        if (prevK > 0 && k > 0) growth *= k / prevK;
        break;
      case "CreatePool":
      case "AddLiquidity":
        if (mine.has(e.user_pub_key) && amount > 0) {
          lp += amount;
          basis += amount * growth;
        }
        break;
      case "RemoveLiquidity":
        if (mine.has(e.user_pub_key) && amount > 0) {
          if (lp <= 0) return null; // removal of liquidity added before the visible history
          // Withdrawals come out of earnings first, then the deposit: collecting fees
          // leaves the basis alone, so the remaining position shows no earnings.
          const earned = Math.max(0, lp * growth - basis);
          basis = Math.max(0, basis - Math.max(0, amount * growth - earned));
          lp -= amount;
        }
        break;
    }
    prevK = k;
  }

  // The history must account for the whole balance, and end at the pool's current state.
  if (Math.abs(lp - userLp) > 0.5) return null;
  if (prevK <= 0) return null;
  const nowK = sqrtK(pool.reserve_a, pool.reserve_b);
  if (Math.abs(nowK - prevK) / prevK > 1e-9) return null;

  const deposit = basis / growth; // LP tokens that are worth the original deposit today
  const lpToCollect = Math.max(0, Math.floor(userLp - deposit));
  const earnedA = Math.floor((lpToCollect * pool.reserve_a) / pool.total_lp_supply);
  const earnedB = Math.floor((lpToCollect * pool.reserve_b) / pool.total_lp_supply);
  return { lpToCollect, earnedA, earnedB, growth: userLp > 0 ? userLp / deposit - 1 : 0 };
}

/** The chain refuses a removal that pays out zero of either token. */
export function canCollect(e: LpEarnings | null): e is LpEarnings {
  return !!e && e.lpToCollect > 0 && e.earnedA > 0 && e.earnedB > 0;
}
