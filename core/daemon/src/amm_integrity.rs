//! AMM_INTEGRITY — from the activation height, the four pool transaction types (`create_pool`,
//! `add_liquidity`, `remove_liquidity`, `swap`) are applied all-or-nothing:
//!
//! * a transaction either takes its full effect, or changes **nothing** — no fee, no balance, no
//!   pool. It can never make the block invalid and never panic the node;
//! * the whole outcome is computed first, on copies ([`plan`]), with checked integer arithmetic,
//!   and only a complete [`Plan`] is written to the ledger and the pool store;
//! * a swap route is validated (2 to [`MAX_PATH_TOKENS`] tokens, starting at the input token and
//!   ending at the output token, no pool used twice, every pool existing);
//! * a pool cannot be created for a pair that already has one (in either order, in any letter case),
//!   for one token with itself, with a zero amount, or when no LP tokens would be minted;
//! * the fee is counted as collected whenever it is charged.
//!
//! Unchanged: the pricing formula (constant product, 0.3% on the input), LP minting and redemption
//! formulas, XRGE pool amounts in whole XRGE, the state root composition. Below the height the
//! previous code runs, so history replays byte-identically.
//!
//! `None` = not scheduled (the per-network height lives in `upgrades.rs`). The height is chosen by
//! the chain owner; this file never sets one.

use crate::amm;
use crate::pool_store::LiquidityPool;
use crate::units::{fee_to_quanta, isqrt, xrge_to_quanta};
use quantum_vault_types::TxV1;

/// Mainnet activation height. `None` = not scheduled.
pub const AMM_INTEGRITY_ACTIVATION_HEIGHT: Option<u64> = None;

#[cfg(test)]
thread_local! {
    static TEST_AMM_INTEGRITY_OVERRIDE: std::cell::Cell<Option<Option<u64>>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn set_test_amm_integrity(h: Option<u64>) {
    TEST_AMM_INTEGRITY_OVERRIDE.with(|c| c.set(Some(h)));
}
#[inline]
pub fn amm_integrity_active(height: u64) -> bool {
    #[cfg(test)]
    {
        if let Some(h) = TEST_AMM_INTEGRITY_OVERRIDE.with(|c| c.get()) {
            return matches!(h, Some(a) if height >= a);
        }
    }
    matches!(crate::upgrades::current().amm_integrity, Some(a) if height >= a)
}

/// The native token's symbol in pool transactions (exact match selects the native ledger).
pub const XRGE: &str = "XRGE";
/// Most tokens a swap route may name (so at most `MAX_PATH_TOKENS - 1` pools).
pub const MAX_PATH_TOKENS: usize = 4;

/// What the planner may read. Balances are the sender's, at this transaction's position in the block.
pub trait AmmView {
    /// Native balance in quanta.
    fn xrge_quanta(&self) -> u128;
    /// Balance of a custom token, in its base units.
    fn token(&self, symbol: &str) -> u128;
    /// LP tokens held in a pool.
    fn lp(&self, pool_id: &str) -> u128;
    fn pool(&self, pool_id: &str) -> Result<Option<LiquidityPool>, String>;
    fn pools(&self) -> Result<Vec<LiquidityPool>, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LpChange { Mint(u64), Burn(u64) }

/// What happened, for the (non-consensus) pool event log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Create { amount_a: u64, amount_b: u64, lp: u64 },
    Add { amount_a: u64, amount_b: u64, lp: u64 },
    Remove { amount_a: u64, amount_b: u64, lp: u64 },
    Swap { token_in: String, token_out: String, amount_in: u64, amount_out: u64 },
}

/// The complete effect of one pool transaction. Every amount in it has been checked against the
/// sender's balances and the pools, so applying it cannot fail or overflow.
#[derive(Debug, Clone)]
pub struct Plan {
    /// Fee charged to the sender, in quanta.
    pub fee_quanta: u128,
    /// Taken from the sender: (token symbol, amount in pool units — whole XRGE for `XRGE`).
    pub debits: Vec<(String, u64)>,
    /// Given to the sender, same units.
    pub credits: Vec<(String, u64)>,
    /// LP tokens minted to / burned from the sender: (pool id, change).
    pub lp: Option<(String, LpChange)>,
    /// New state of every pool the transaction touches, in order.
    pub pools: Vec<LiquidityPool>,
    pub effect: Effect,
}

fn no(reason: &str) -> Result<Plan, String> { Err(reason.to_string()) }

/// A symbol as a pool transaction must carry it: not empty, no surrounding white space.
fn well_formed(sym: &str) -> bool { !sym.is_empty() && sym.trim() == sym }

/// Check the sender can pay the fee plus every debit, and receive every credit; on success the
/// plan is final.
fn affordable(view: &dyn AmmView, plan: Plan) -> Result<Plan, String> {
    let mut xrge_needed = plan.fee_quanta;
    for (sym, amount) in &plan.debits {
        if sym == XRGE {
            xrge_needed = xrge_needed.checked_add(xrge_to_quanta(*amount)).ok_or("amount out of range")?;
        } else if view.token(sym) < *amount as u128 {
            return Err(format!("insufficient {} balance", sym));
        }
    }
    if view.xrge_quanta() < xrge_needed { return no("insufficient XRGE balance"); }
    for (sym, amount) in &plan.credits {
        let have = if sym == XRGE { view.xrge_quanta() } else { view.token(sym) };
        let add = if sym == XRGE { xrge_to_quanta(*amount) } else { *amount as u128 };
        have.checked_add(add).ok_or("balance out of range")?;
    }
    match &plan.lp {
        Some((pool_id, LpChange::Burn(n))) if view.lp(pool_id) < *n as u128 => return no("insufficient LP tokens"),
        Some((pool_id, LpChange::Mint(n))) => { view.lp(pool_id).checked_add(*n as u128).ok_or("LP balance out of range")?; }
        _ => {}
    }
    Ok(plan)
}

/// Decide a pool transaction. `Ok(plan)` = it takes effect exactly as planned; `Err(reason)` = it
/// takes no effect at all (the reason is for logs and the producer; it is not consensus data).
/// A store read failure is also an `Err` here — the caller distinguishes it via [`AmmView`]
/// returning the failure from its own state (see `L1Node::apply_amm_tx_integrity`).
pub fn plan(view: &dyn AmmView, tx: &TxV1, block_time: u64) -> Result<Plan, String> {
    let p = &tx.payload;
    let fee_quanta = fee_to_quanta(tx.fee);
    match tx.tx_type.as_str() {
        "create_pool" => {
            let (Some(a), Some(b)) = (p.token_a_symbol.as_deref(), p.token_b_symbol.as_deref()) else { return no("both token symbols are required") };
            let (Some(x), Some(y)) = (p.amount_a, p.amount_b) else { return no("both amounts are required") };
            if !well_formed(a) || !well_formed(b) { return no("malformed token symbol") }
            if a.eq_ignore_ascii_case(b) { return no("a pool needs two different tokens") }
            if x == 0 || y == 0 { return no("amounts must be greater than zero") }
            if isqrt(x as u128 * y as u128) <= amm::MINIMUM_LIQUIDITY as u128 { return no("no LP tokens would be minted") }
            let same_pair = |q: &LiquidityPool| {
                (q.token_a.eq_ignore_ascii_case(a) && q.token_b.eq_ignore_ascii_case(b))
                    || (q.token_a.eq_ignore_ascii_case(b) && q.token_b.eq_ignore_ascii_case(a))
            };
            let pool = LiquidityPool::new(a.to_string(), b.to_string(), x, y, tx.from_pub_key.clone(), block_time);
            if view.pool(&pool.pool_id)?.is_some() || view.pools()?.iter().any(same_pair) {
                return no("a pool for this pair already exists");
            }
            let lp = pool.total_lp_supply;
            if lp == 0 { return no("no LP tokens would be minted") }
            affordable(view, Plan {
                fee_quanta,
                debits: vec![(a.to_string(), x), (b.to_string(), y)],
                credits: vec![],
                lp: Some((pool.pool_id.clone(), LpChange::Mint(lp))),
                pools: vec![pool],
                effect: Effect::Create { amount_a: x, amount_b: y, lp },
            })
        }
        "add_liquidity" => {
            let Some(pool_id) = p.pool_id.as_deref() else { return no("pool_id is required") };
            let (Some(x), Some(y)) = (p.amount_a, p.amount_b) else { return no("both amounts are required") };
            if x == 0 || y == 0 { return no("amounts must be greater than zero") }
            let Some(mut pool) = view.pool(pool_id)? else { return no("pool not found") };
            let lp = if pool.total_lp_supply == 0 {
                isqrt(x as u128 * y as u128).saturating_sub(amm::MINIMUM_LIQUIDITY as u128)
            } else {
                if pool.reserve_a == 0 || pool.reserve_b == 0 { return no("pool has an empty side") }
                let lp_a = x as u128 * pool.total_lp_supply as u128 / pool.reserve_a as u128;
                let lp_b = y as u128 * pool.total_lp_supply as u128 / pool.reserve_b as u128;
                lp_a.min(lp_b)
            };
            let lp = u64::try_from(lp).map_err(|_| "amount out of range")?;
            if lp == 0 { return no("no LP tokens would be minted") }
            pool.reserve_a = pool.reserve_a.checked_add(x).ok_or("amount out of range")?;
            pool.reserve_b = pool.reserve_b.checked_add(y).ok_or("amount out of range")?;
            pool.total_lp_supply = pool.total_lp_supply.checked_add(lp).ok_or("amount out of range")?;
            affordable(view, Plan {
                fee_quanta,
                debits: vec![(pool.token_a.clone(), x), (pool.token_b.clone(), y)],
                credits: vec![],
                lp: Some((pool.pool_id.clone(), LpChange::Mint(lp))),
                pools: vec![pool],
                effect: Effect::Add { amount_a: x, amount_b: y, lp },
            })
        }
        "remove_liquidity" => {
            let Some(pool_id) = p.pool_id.as_deref() else { return no("pool_id is required") };
            let Some(lp) = p.lp_amount else { return no("lp_amount is required") };
            if lp == 0 { return no("lp_amount must be greater than zero") }
            let Some(mut pool) = view.pool(pool_id)? else { return no("pool not found") };
            if lp > pool.total_lp_supply { return no("more LP tokens than the pool has issued") }
            let out_a = u64::try_from(lp as u128 * pool.reserve_a as u128 / pool.total_lp_supply as u128).map_err(|_| "amount out of range")?;
            let out_b = u64::try_from(lp as u128 * pool.reserve_b as u128 / pool.total_lp_supply as u128).map_err(|_| "amount out of range")?;
            if out_a == 0 || out_b == 0 { return no("nothing would be returned on one side of the pool") }
            pool.reserve_a = pool.reserve_a.checked_sub(out_a).ok_or("amount out of range")?;
            pool.reserve_b = pool.reserve_b.checked_sub(out_b).ok_or("amount out of range")?;
            pool.total_lp_supply -= lp;
            affordable(view, Plan {
                fee_quanta,
                debits: vec![],
                credits: vec![(pool.token_a.clone(), out_a), (pool.token_b.clone(), out_b)],
                lp: Some((pool.pool_id.clone(), LpChange::Burn(lp))),
                pools: vec![pool],
                effect: Effect::Remove { amount_a: out_a, amount_b: out_b, lp },
            })
        }
        "swap" => {
            let (Some(token_in), Some(token_out)) = (p.token_a_symbol.as_deref(), p.token_b_symbol.as_deref()) else { return no("both tokens are required") };
            let Some(amount_in) = p.amount_a else { return no("amount_in is required") };
            if amount_in == 0 { return no("amount_in must be greater than zero") }
            if token_in == token_out { return no("a swap needs two different tokens") }
            let direct = [token_in.to_string(), token_out.to_string()];
            let path: &[String] = p.swap_path.as_deref().unwrap_or(&direct);
            if path.len() < 2 || path.len() > MAX_PATH_TOKENS { return no("a route names 2 to 4 tokens") }
            if path[0] != token_in || path[path.len() - 1] != token_out { return no("the route must start at the input token and end at the output token") }
            let mut pools: Vec<LiquidityPool> = Vec::with_capacity(path.len() - 1);
            let mut amount = amount_in;
            for hop in path.windows(2) {
                let (t_in, t_out) = (hop[0].as_str(), hop[1].as_str());
                if t_in == t_out { return no("a route step needs two different tokens") }
                let id = LiquidityPool::make_pool_id(t_in, t_out);
                if pools.iter().any(|q| q.pool_id == id) { return no("a route may use each pool once") }
                let Some(mut pool) = view.pool(&id)? else { return no("pool not found") };
                let in_is_a = pool.token_a == t_in && pool.token_b == t_out;
                if !in_is_a && !(pool.token_b == t_in && pool.token_a == t_out) { return no("the pool does not trade this pair") }
                let (r_in, r_out) = if in_is_a { (pool.reserve_a, pool.reserve_b) } else { (pool.reserve_b, pool.reserve_a) };
                let out = match amm::get_amount_out(amount, r_in, r_out) {
                    Some(o) if o > 0 && o < r_out => o,
                    _ => return no("no output from the pool"),
                };
                let new_in = r_in.checked_add(amount).ok_or("amount out of range")?;
                let new_out = r_out - out;
                if in_is_a { pool.reserve_a = new_in; pool.reserve_b = new_out } else { pool.reserve_b = new_in; pool.reserve_a = new_out }
                pools.push(pool);
                amount = out;
            }
            if amount < p.min_amount_out.unwrap_or(0) { return no("output below the minimum the sender signed") }
            affordable(view, Plan {
                fee_quanta,
                debits: vec![(token_in.to_string(), amount_in)],
                credits: vec![(token_out.to_string(), amount)],
                lp: None,
                pools,
                effect: Effect::Swap { token_in: token_in.to_string(), token_out: token_out.to_string(), amount_in, amount_out: amount },
            })
        }
        _ => no("not a pool transaction"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quantum_vault_types::TxPayload;
    use std::collections::HashMap;

    #[derive(Default)]
    struct V { xrge: u128, tok: HashMap<String, u128>, lp: HashMap<String, u128>, pools: Vec<LiquidityPool> }
    impl AmmView for V {
        fn xrge_quanta(&self) -> u128 { self.xrge }
        fn token(&self, s: &str) -> u128 { *self.tok.get(s).unwrap_or(&0) }
        fn lp(&self, id: &str) -> u128 { *self.lp.get(id).unwrap_or(&0) }
        fn pool(&self, id: &str) -> Result<Option<LiquidityPool>, String> { Ok(self.pools.iter().find(|p| p.pool_id == id).cloned()) }
        fn pools(&self) -> Result<Vec<LiquidityPool>, String> { Ok(self.pools.clone()) }
    }
    fn tx(ty: &str, payload: TxPayload) -> TxV1 {
        TxV1 { version: 1, tx_type: ty.into(), from_pub_key: "aa".into(), nonce: 1, payload, fee: 1.0, sig: String::new(), signed_payload: None }
    }
    fn pool(a: &str, b: &str, ra: u64, rb: u64) -> LiquidityPool { LiquidityPool::new(a.into(), b.into(), ra, rb, "cc".into(), 0) }
    fn rich() -> V {
        let mut v = V { xrge: xrge_to_quanta(1_000_000), ..Default::default() };
        for t in ["QTOK", "BTOK", "CTOK"] { v.tok.insert(t.into(), 1_000_000_000); }
        v
    }
    fn swap(i: &str, o: &str, amount: u64, min: u64, path: Option<Vec<&str>>) -> TxV1 {
        tx("swap", TxPayload { token_a_symbol: Some(i.into()), token_b_symbol: Some(o.into()), amount_a: Some(amount), min_amount_out: Some(min),
            swap_path: path.map(|p| p.into_iter().map(String::from).collect()), ..Default::default() })
    }
    fn create(a: &str, b: &str, x: u64, y: u64) -> TxV1 {
        tx("create_pool", TxPayload { token_a_symbol: Some(a.into()), token_b_symbol: Some(b.into()), amount_a: Some(x), amount_b: Some(y), ..Default::default() })
    }

    #[test]
    fn unscheduled_on_mainnet() {
        // The mainnet constant; testnet's height lives in `upgrades::TESTNET`.
        assert_eq!(AMM_INTEGRITY_ACTIVATION_HEIGHT, None);
        assert!(!amm_integrity_active(0) && !amm_integrity_active(u64::MAX));
    }

    #[test]
    fn route_shapes_that_are_refused() {
        let mut v = rich();
        v.pools = vec![pool("QTOK", "XRGE", 1_000_000, 1_000), pool("BTOK", "QTOK", 1_000_000, 1_000_000)];
        for (what, t) in [
            ("empty route", swap("XRGE", "QTOK", 10, 0, Some(vec![]))),
            ("one token", swap("XRGE", "QTOK", 10, 0, Some(vec!["XRGE"]))),
            ("does not start at the input", swap("XRGE", "QTOK", 10, 0, Some(vec!["BTOK", "QTOK"]))),
            ("does not end at the output", swap("XRGE", "QTOK", 10, 0, Some(vec!["XRGE", "QTOK", "BTOK"]))),
            ("too long", swap("XRGE", "QTOK", 10, 0, Some(vec!["XRGE", "QTOK", "BTOK", "QTOK", "XRGE", "QTOK"]))),
            ("a pool twice", swap("XRGE", "QTOK", 10, 0, Some(vec!["XRGE", "QTOK", "XRGE", "QTOK"]))),
            ("a step with one token", swap("XRGE", "QTOK", 10, 0, Some(vec!["XRGE", "XRGE", "QTOK"]))),
            ("a missing pool", swap("XRGE", "BTOK", 10, 0, Some(vec!["XRGE", "CTOK", "BTOK"]))),
            ("same token", swap("XRGE", "XRGE", 10, 0, None)),
            ("zero input", swap("XRGE", "QTOK", 0, 0, None)),
        ] {
            assert!(plan(&v, &t, 0).is_err(), "{what}");
        }
    }

    #[test]
    fn a_direct_swap_and_a_two_pool_route() {
        let mut v = rich();
        v.pools = vec![pool("QTOK", "XRGE", 1_000_000, 1_000), pool("BTOK", "QTOK", 1_000_000, 1_000_000)];
        let hop1 = amm::get_amount_out(10, 1_000, 1_000_000).unwrap();
        let d = plan(&v, &swap("XRGE", "QTOK", 10, hop1, None), 0).unwrap();
        assert_eq!((d.debits.clone(), d.credits.clone()), (vec![("XRGE".to_string(), 10)], vec![("QTOK".to_string(), hop1)]));
        assert_eq!((d.pools[0].reserve_a, d.pools[0].reserve_b), (1_000_000 - hop1, 1_010));
        assert_eq!(d.fee_quanta, fee_to_quanta(1.0));
        let hop2 = amm::get_amount_out(hop1, 1_000_000, 1_000_000).unwrap();
        let r = plan(&v, &swap("XRGE", "BTOK", 10, hop2, Some(vec!["XRGE", "QTOK", "BTOK"])), 0).unwrap();
        assert_eq!(r.credits, vec![("BTOK".to_string(), hop2)]);
        assert_eq!(r.pools.len(), 2);
        // one unit more than the route yields: nothing happens
        assert!(plan(&v, &swap("XRGE", "BTOK", 10, hop2 + 1, Some(vec!["XRGE", "QTOK", "BTOK"])), 0).is_err());
        assert!(plan(&v, &swap("XRGE", "QTOK", 10, hop1 + 1, None), 0).is_err());
    }

    #[test]
    fn the_sender_must_afford_the_fee_and_the_input_together() {
        let mut v = rich();
        v.pools = vec![pool("QTOK", "XRGE", 1_000_000, 1_000)];
        v.xrge = xrge_to_quanta(10) + fee_to_quanta(1.0) - 1;
        assert!(plan(&v, &swap("XRGE", "QTOK", 10, 0, None), 0).is_err());
        v.xrge += 1;
        assert!(plan(&v, &swap("XRGE", "QTOK", 10, 0, None), 0).is_ok());
        // token input: the fee alone must be covered in XRGE
        v.xrge = fee_to_quanta(1.0) - 1;
        assert!(plan(&v, &swap("QTOK", "XRGE", 10_000, 0, None), 0).is_err());
        v.xrge += 1;
        assert!(plan(&v, &swap("QTOK", "XRGE", 10_000, 0, None), 0).is_ok());
        v.tok.insert("QTOK".into(), 9_999);
        assert!(plan(&v, &swap("QTOK", "XRGE", 10_000, 0, None), 0).is_err());
    }

    #[test]
    fn pool_creation_rules() {
        let mut v = rich();
        v.pools = vec![pool("QTOK", "XRGE", 1_000_000, 1_000)];
        for (what, t) in [
            ("existing pair", create("XRGE", "QTOK", 5_000, 5_000)),
            ("existing pair, other order", create("QTOK", "XRGE", 5_000, 5_000)),
            ("existing pair, other case", create("xrge", "qtok", 5_000, 5_000)),
            ("one token with itself", create("BTOK", "btok", 5_000, 5_000)),
            ("zero amount", create("BTOK", "XRGE", 0, 5_000)),
            ("no LP tokens", create("BTOK", "XRGE", 1_000, 1_000)),
            ("white space", create("BTOK ", "XRGE", 5_000, 5_000)),
            ("empty symbol", create("", "XRGE", 5_000, 5_000)),
            ("more than the sender holds", create("BTOK", "XRGE", 2_000_000_000, 5_000)),
        ] {
            assert!(plan(&v, &t, 0).is_err(), "{what}");
        }
        let ok = plan(&v, &create("XRGE", "BTOK", 4_000, 9_000), 7).unwrap();
        assert_eq!(ok.pools[0].pool_id, "BTOK-XRGE");
        assert_eq!((ok.pools[0].reserve_a, ok.pools[0].reserve_b), (9_000, 4_000));
        assert_eq!(ok.lp, Some(("BTOK-XRGE".to_string(), LpChange::Mint(5_000))));
    }

    #[test]
    fn liquidity_rules() {
        let mut v = rich();
        v.pools = vec![pool("QTOK", "XRGE", 1_000_000, 1_000)];
        let supply = v.pools[0].total_lp_supply;
        let id = "QTOK-XRGE".to_string();
        let add = |x: u64, y: u64| tx("add_liquidity", TxPayload { pool_id: Some("QTOK-XRGE".into()), amount_a: Some(x), amount_b: Some(y), ..Default::default() });
        let rem = |lp: u64| tx("remove_liquidity", TxPayload { pool_id: Some("QTOK-XRGE".into()), lp_amount: Some(lp), ..Default::default() });
        assert!(plan(&v, &add(1, 1), 0).is_err(), "no LP tokens");
        assert!(plan(&v, &add(0, 1), 0).is_err());
        let a = plan(&v, &add(1_000, 1), 0).unwrap();
        assert_eq!(a.lp, Some((id.clone(), LpChange::Mint(amm::calculate_lp_mint(1_000, 1, 1_000_000, 1_000, supply).unwrap()))));
        // removal: nothing on one side → no effect; not held → no effect; held → both sides returned
        v.lp.insert(id.clone(), supply as u128);
        assert!(plan(&v, &rem(1), 0).is_err(), "1 LP returns 0 XRGE");
        assert!(plan(&v, &rem(supply + 1), 0).is_err());
        let r = plan(&v, &rem(supply), 0).unwrap();
        assert_eq!(r.credits, vec![("QTOK".to_string(), 1_000_000), ("XRGE".to_string(), 1_000)]);
        assert_eq!((r.pools[0].reserve_a, r.pools[0].reserve_b, r.pools[0].total_lp_supply), (0, 0, 0));
        v.lp.insert(id, 10);
        assert!(plan(&v, &rem(1_000), 0).is_err(), "more than the sender holds");
    }

    #[test]
    fn extreme_amounts_have_no_effect_instead_of_wrapping() {
        let mut v = rich();
        v.xrge = u128::MAX / 2;
        v.tok.insert("QTOK".into(), u128::MAX / 2);
        v.pools = vec![pool("QTOK", "XRGE", u64::MAX - 5, 1_000)];
        let add = tx("add_liquidity", TxPayload { pool_id: Some("QTOK-XRGE".into()), amount_a: Some(10), amount_b: Some(10), ..Default::default() });
        assert!(plan(&v, &add, 0).is_err(), "reserve would pass u64");
        assert!(plan(&v, &swap("QTOK", "XRGE", 10, 0, None), 0).is_err());
        // supply growth past u64
        let mut q = pool("QTOK", "XRGE", 1_000_000, 1_000_000);
        q.total_lp_supply = u64::MAX - 1;
        v.pools = vec![q];
        let add = tx("add_liquidity", TxPayload { pool_id: Some("QTOK-XRGE".into()), amount_a: Some(1_000_000), amount_b: Some(1_000_000), ..Default::default() });
        assert!(plan(&v, &add, 0).is_err());
    }
}
