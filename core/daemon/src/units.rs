//! XRGE integer base-unit ("quanta") helpers for the native ledger.
//!
//! Phase 1 of the integer-ledger migration (see RFC). The authoritative ledger
//! moves from `f64` XRGE to `u128` **quanta**, where `1 XRGE = 10^9 quanta`.
//!
//! Three representations coexist, deliberately:
//! - **wire / tx payloads:** whole-XRGE amounts as `u64` (unchanged), plus the
//!   legacy `fee: f64`. Converted to quanta at ingest.
//! - **ledger / consensus:** `u128` quanta. All balance math is integer.
//! - **API / display:** `f64` XRGE, produced only at serialization boundaries
//!   via [`quanta_to_display`]. Never fed back into consensus.
//!
//! 10^9 quanta covers today's finest granularity — gas `0.000001 XRGE`
//! (= 1_000 quanta), the `0.001` base-fee floor (= 1_000_000 quanta), and the
//! `0.1` base fee (= 10^8 quanta) — with vast `u128` headroom.

use std::collections::HashMap;

/// Decimal places in one XRGE.
pub const XRGE_DECIMALS: u32 = 9;

/// Quanta per whole XRGE (`10^XRGE_DECIMALS`).
pub const QUANTA_PER_XRGE: u128 = 1_000_000_000;

/// Whole-XRGE amount (as carried in a tx payload's `u64` fields) → quanta.
#[inline]
pub fn xrge_to_quanta(whole_xrge: u64) -> u128 {
    (whole_xrge as u128) * QUANTA_PER_XRGE
}

/// A legacy `f64` XRGE fee → quanta, rounded half-up.
///
/// Fees are the only fractional-XRGE inputs in the system today (`0.1`,
/// `0.001`, gas `0.000001`). Rounding is defined (half-up at the quanta
/// boundary) so replay is deterministic. Non-finite / non-positive → 0.
#[inline]
pub fn fee_to_quanta(fee_xrge: f64) -> u128 {
    if !fee_xrge.is_finite() || fee_xrge <= 0.0 {
        return 0;
    }
    (fee_xrge * QUANTA_PER_XRGE as f64 + 0.5) as u128
}

/// Any `f64`-XRGE value — a whole amount *or* a fractional fee — → quanta,
/// rounded half-up. In the ledger, AMM/transfer XRGE amounts arrive as whole
/// `f64` and fees as fractional `f64`; both convert through here so the scaling
/// is defined in exactly one place.
#[inline]
pub fn xrge_f64_to_quanta(x: f64) -> u128 {
    fee_to_quanta(x)
}

/// Quanta → display XRGE. **Serialization boundary only** — presentation, never
/// consensus. Reintroducing `f64` here is safe because the value is only shown
/// to clients; the ledger itself stays integer.
#[inline]
pub fn quanta_to_display(quanta: u128) -> f64 {
    quanta as f64 / QUANTA_PER_XRGE as f64
}

/// `floor((a * b) / c)` in `u128`, avoiding overflow in the common case and
/// degrading gracefully on the rare wide product. Used for proportional
/// (stake-weighted) splits, where the remainder is handled by the caller.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if c == 0 {
        return 0;
    }
    match a.checked_mul(b) {
        Some(p) => p / c,
        None => {
            // Wide-product fallback: exact split of the quotient and remainder.
            // floor(a/c)*b is exact; the leftover (a%c)*b/c may itself be wide,
            // so reduce it the same way once more (sufficient for our magnitudes).
            let q = (a / c).saturating_mul(b);
            let r = a % c;
            let extra = match r.checked_mul(b) {
                Some(rb) => rb / c,
                None => (r / c).saturating_mul(b) + ((r % c).saturating_mul(b) / c),
            };
            q.saturating_add(extra)
        }
    }
}

/// Integer floor square root of a `u128` (Newton's method). Replaces the `f64`
/// `sqrt` used for first-provider LP-mint, which is a replay-fork hazard.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Apply a set of contract-emitted balance deltas (signed **quanta**) to the
/// native ledger, atomically, under the two custody invariants of Phase 3:
///
/// - **conservation** — the deltas must net to exactly zero. A contract can
///   never mint or burn XRGE; it can only *move* it. This is the invariant that
///   makes contract custody safe.
/// - **no overdraft** — no account may end below zero. A contract can only move
///   quanta it actually holds.
///
/// All-or-nothing: the full set is validated first, so on ANY violation
/// `balances` is left completely unchanged and an `Err` is returned. Deltas for
/// the same address are aggregated before the checks, so order within the slice
/// is irrelevant. Arithmetic is overflow-safe throughout (no `u128`↔`i128` cast
/// that could wrap on an astronomically large balance).
///
/// This is a pure function over the map — the correctness core for contract
/// XRGE custody, deliberately wired into no consensus path here.
#[allow(dead_code)] // wired into the block apply path in P3-4
pub fn apply_balance_deltas(
    balances: &mut HashMap<String, u128>,
    deltas: &[(String, i128)],
) -> Result<(), String> {
    if deltas.is_empty() {
        return Ok(());
    }

    // (1) Conservation: the deltas must net to exactly zero (checked sum).
    let mut net: i128 = 0;
    for (_, d) in deltas {
        net = net
            .checked_add(*d)
            .ok_or("balance deltas overflow i128 while summing")?;
    }
    if net != 0 {
        return Err(format!("balance deltas do not conserve (net = {net} quanta)"));
    }

    // (2) Aggregate per address, so multiple deltas touching one account are
    //     validated and applied as a single net change.
    let mut aggregated: HashMap<&str, i128> = HashMap::new();
    for (addr, d) in deltas {
        let slot = aggregated.entry(addr.as_str()).or_insert(0);
        *slot = slot
            .checked_add(*d)
            .ok_or("per-address balance delta overflows i128")?;
    }

    // (3) Validate EVERYTHING before mutating anything (all-or-nothing). Compute
    //     each account's resulting balance without an unchecked u128<->i128 cast.
    for (addr, net_delta) in &aggregated {
        let current = *balances.get(*addr).unwrap_or(&0);
        if *net_delta < 0 {
            let debit = net_delta.unsigned_abs(); // i128 -> u128 magnitude
            if current < debit {
                return Err(format!(
                    "overdraft: {addr} holds {current} quanta, delta needs {debit}"
                ));
            }
        } else if current.checked_add(*net_delta as u128).is_none() {
            return Err(format!("balance overflow crediting {addr}"));
        }
    }

    // (4) Apply — every change is now known-safe.
    for (addr, net_delta) in aggregated {
        if net_delta == 0 {
            continue;
        }
        let entry = balances.entry(addr.to_string()).or_insert(0);
        if net_delta < 0 {
            *entry -= net_delta.unsigned_abs();
        } else {
            *entry += net_delta as u128;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xrge_scales_by_a_billion() {
        assert_eq!(xrge_to_quanta(0), 0);
        assert_eq!(xrge_to_quanta(1), 1_000_000_000);
        assert_eq!(xrge_to_quanta(5), 5_000_000_000);
    }

    #[test]
    fn fees_convert_with_defined_rounding() {
        assert_eq!(fee_to_quanta(0.1), 100_000_000);
        assert_eq!(fee_to_quanta(0.001), 1_000_000);
        assert_eq!(fee_to_quanta(0.000001), 1_000); // gas granularity preserved
        assert_eq!(fee_to_quanta(1.0), 1_000_000_000);
        assert_eq!(fee_to_quanta(0.0), 0);
        assert_eq!(fee_to_quanta(-1.0), 0);
        assert_eq!(fee_to_quanta(f64::NAN), 0);
        // half-up at the quanta boundary
        assert_eq!(fee_to_quanta(1.5e-9), 2);
    }

    #[test]
    fn display_roundtrips_whole_and_fractional() {
        assert_eq!(quanta_to_display(1_000_000_000), 1.0);
        assert_eq!(quanta_to_display(100_000_000), 0.1);
        assert_eq!(quanta_to_display(0), 0.0);
    }

    #[test]
    fn mul_div_splits_proportionally() {
        assert_eq!(mul_div(100, 70, 100), 70);
        // 70-quanta validator pool, stake 100 of total 400 → 17 (floor of 17.5)
        assert_eq!(mul_div(70, 100, 400), 17);
        assert_eq!(mul_div(70, 300, 400), 52);
        assert_eq!(mul_div(0, 5, 3), 0);
        assert_eq!(mul_div(5, 5, 0), 0);
    }

    #[test]
    fn mul_div_handles_wide_products() {
        // a*b overflows u128 (both near 2^96) — fallback must still be exact-ish.
        let a = 1u128 << 96;
        let b = 1u128 << 96;
        let c = 1u128 << 64;
        // (2^96 * 2^96) / 2^64 = 2^128 — saturates, but must not panic.
        let _ = mul_div(a, b, c);
        // exact wide case: (2^80 * 2^40) / 2^40 == 2^80
        assert_eq!(mul_div(1u128 << 80, 1u128 << 40, 1u128 << 40), 1u128 << 80);
    }

    #[test]
    fn isqrt_is_floor_correct() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(8), 2); // floor(2.82)
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(1_000_000), 1_000);
        assert_eq!(isqrt(1_000_000_000_000), 1_000_000);
        // perfect square of a large u128
        let big = 1_234_567_890u128;
        assert_eq!(isqrt(big * big), big);
        assert_eq!(isqrt(big * big + 1), big);
        assert_eq!(isqrt(big * big - 1), big - 1);
    }

    // ── P3-1 contract balance-delta custody core ──────────────────────────

    const Q: u128 = QUANTA_PER_XRGE;

    fn bals(pairs: &[(&str, u128)]) -> HashMap<String, u128> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn conserving_transfer_applies() {
        let mut b = bals(&[("contract", 100 * Q)]);
        let deltas = vec![
            ("contract".to_string(), -(40 * Q as i128)),
            ("bob".to_string(), 40 * Q as i128),
        ];
        apply_balance_deltas(&mut b, &deltas).unwrap();
        assert_eq!(b["contract"], 60 * Q);
        assert_eq!(b["bob"], 40 * Q);
    }

    #[test]
    fn non_conserving_deltas_are_rejected_and_leave_state_untouched() {
        let mut b = bals(&[("contract", 100 * Q)]);
        let before = b.clone();
        // Nets to +10 quanta — a mint. Must be refused.
        let deltas = vec![
            ("contract".to_string(), -(40 * Q as i128)),
            ("bob".to_string(), 40 * Q as i128 + 10),
        ];
        let err = apply_balance_deltas(&mut b, &deltas).unwrap_err();
        assert!(err.contains("conserve"), "{err}");
        assert_eq!(b, before, "all-or-nothing: nothing changed");
    }

    #[test]
    fn overdraft_is_rejected_and_leaves_state_untouched() {
        let mut b = bals(&[("contract", 30 * Q)]);
        let before = b.clone();
        // Conserves (net 0) but the contract can't cover the debit.
        let deltas = vec![
            ("contract".to_string(), -(40 * Q as i128)),
            ("bob".to_string(), 40 * Q as i128),
        ];
        let err = apply_balance_deltas(&mut b, &deltas).unwrap_err();
        assert!(err.contains("overdraft"), "{err}");
        assert_eq!(b, before, "all-or-nothing: nothing changed");
    }

    #[test]
    fn three_way_split_conserves_to_the_quantum() {
        // The headline use case: split 1 XRGE three ways. 1e9 / 3 = 333_333_333
        // each, 1 quanta remainder stays with the contract. Conserves exactly —
        // this is why contracts must speak quanta, not whole XRGE.
        let mut b = bals(&[("splitter", 1 * Q)]);
        let third = 333_333_333i128;
        let deltas = vec![
            ("splitter".to_string(), -(3 * third)),
            ("a".to_string(), third),
            ("b".to_string(), third),
            ("c".to_string(), third),
        ];
        apply_balance_deltas(&mut b, &deltas).unwrap();
        assert_eq!(b["splitter"], 1, "1-quanta remainder retained");
        assert_eq!(b["a"], 333_333_333);
        assert_eq!(b["b"], 333_333_333);
        assert_eq!(b["c"], 333_333_333);
        let total: u128 = b.values().sum();
        assert_eq!(total, Q, "not a single quantum created or destroyed");
    }

    #[test]
    fn deltas_for_the_same_address_aggregate() {
        let mut b = bals(&[("contract", 100 * Q)]);
        // Two debits from the contract, one credit — nets to zero overall.
        let deltas = vec![
            ("contract".to_string(), -(40 * Q as i128)),
            ("contract".to_string(), -(10 * Q as i128)),
            ("bob".to_string(), 50 * Q as i128),
        ];
        apply_balance_deltas(&mut b, &deltas).unwrap();
        assert_eq!(b["contract"], 50 * Q);
        assert_eq!(b["bob"], 50 * Q);
    }

    #[test]
    fn empty_deltas_are_a_noop() {
        let mut b = bals(&[("alice", 5 * Q)]);
        let before = b.clone();
        apply_balance_deltas(&mut b, &[]).unwrap();
        assert_eq!(b, before);
    }
}
