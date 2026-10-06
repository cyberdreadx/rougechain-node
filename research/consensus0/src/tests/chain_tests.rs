//! Chain rules: rewards, subsidy, unbonding, evidence and slashing, the
//! minimum and its grace, cap, admission, epochs, jailing, heartbeats and the
//! activation boundary.

use super::lab::*;
use crate::chain::*;
use crate::sim::{transfer, Rng};
use crate::types::*;

fn acct(i: usize) -> Account {
    Account::Key(key(i))
}

/// §5.4, every row of the worked example, to the quantum.
#[test]
fn rewards_reproduce_the_worked_example_of_5_4() {
    let mut c = Chain::new(&[40_000, 30_000, 20_000, 10_000], |p| p.subsidy_rate = 0);
    let before: Vec<Quanta> = (0..4).map(|i| c.ledger.balance(acct(i))).collect();
    let fx1 = c.heartbeat();
    assert_eq!(fx1.round0_proposer, Some(key(0)));
    // Block 2 is B's; it carries the certificate for block 1 signed by A, B, C. D is offline.
    let txs: Vec<Tx> = (1..=10).map(|i| transfer(i, 100_000_000)).collect();
    let fx = c.next(60_000, txs, vec![], Some(&[key(0), key(1), key(2)])).unwrap();
    assert_eq!(fx.round0_proposer, Some(key(1)));
    assert_eq!(fx.fees, 1_000_000_000);
    assert_eq!(fx.burn, 5_000_000);
    assert_eq!(fx.subsidy, 0);
    assert_eq!(fx.unearned, 84_575_000);
    let credit = |a: Account| fx.credits.iter().filter(|c| c.0 == a).map(|c| c.1).collect::<Vec<_>>();
    assert_eq!(credit(Account::Treasury), vec![99_500_000]);
    assert_eq!(credit(acct(0)), vec![278_600_000]);
    assert_eq!(credit(acct(1)), vec![49_750_000 + 134_325_000, 208_950_000]);
    assert_eq!(credit(acct(2)), vec![139_300_000]);
    assert!(credit(acct(3)).is_empty(), "the offline validator earns nothing");
    assert_eq!(c.ledger.balance(acct(3)), before[3]);
    let credits: Quanta = fx.credits.iter().map(|c| c.1).sum();
    assert_eq!(credits + fx.burn + fx.unearned, fx.fees + fx.subsidy);
    assert_eq!(credits + fx.unearned, 995_000_000);
}

/// §5.2: omitting a signer never pays the proposer; it costs it `15 % · s_j / T`.
#[test]
fn omitting_a_signature_lowers_the_proposers_own_reward() {
    let run = |signers: Option<&[KeyId]>| {
        let mut c = Chain::new(&[40_000, 30_000, 20_000, 10_000], |p| p.subsidy_rate = 0);
        c.heartbeat();
        let fx = c.next(60_000, (1..=10).map(|i| transfer(i, 100_000_000)).collect(), vec![], signers).unwrap();
        (fx.credits.iter().filter(|x| x.0 == acct(1)).map(|x| x.1).sum::<Quanta>(), fx.credits.iter().filter(|x| x.0 == acct(0)).map(|x| x.1).sum::<Quanta>())
    };
    let (prop_all, a_all) = run(None);
    let (prop_omit, a_omit) = run(Some(&[key(0), key(1), key(2)]));
    assert!(prop_omit < prop_all, "the proposer loses by omitting D");
    assert_eq!(prop_all - prop_omit, 149_250_000 * 10_000 / 100_000);
    assert_eq!(a_all, a_omit, "nobody else's share rises");
}

/// §5.3: the subsidy is per time, capped at one heartbeat interval, limited by the reserve,
/// and splitting an interval into more blocks does not mint more.
#[test]
fn subsidy_is_per_time_capped_and_cannot_be_farmed() {
    let rate = 2 * XRGE; // per second
    let mk = || Chain::new(&[1_000_000; 4], |p| p.subsidy_rate = rate);
    let mut one = mk();
    assert_eq!(one.heartbeat().subsidy, rate * 3_600);
    assert_eq!(one.next(3 * HOUR, vec![], vec![], None).unwrap().subsidy, rate * 3_600, "capped at RATE x T_HB");
    // 30 minutes as one block or as three: the same subsidy in total.
    let mut a = mk();
    a.heartbeat();
    let single = a.next(30 * 60_000, vec![transfer(1, a.fee())], vec![], None).unwrap().subsidy;
    let mut b = mk();
    b.heartbeat();
    let split: Quanta = (0..3).map(|i| b.next(10 * 60_000, vec![transfer(10 + i, b.fee())], vec![], None).unwrap().subsidy).sum();
    assert_eq!(single, split);
    assert_eq!(single, rate * 1_800);
    // The old 0.1 XRGE floor is gone: a minimum-fee block one second later draws one second of subsidy.
    let farm = b.next(1_000, vec![transfer(99, b.fee())], vec![], None).unwrap();
    assert_eq!(farm.subsidy, rate);
    // An empty reserve pays nothing and nothing breaks.
    let mut dry = Chain::new(&[1_000_000; 4], |p| p.subsidy_rate = rate);
    dry.ledger.balances.insert(Account::Reserve, 5);
    assert_eq!(dry.heartbeat().subsidy, 5);
    // What was unearned in that block went back to the reserve and is all the next one can draw.
    let back = dry.effects[0].unearned;
    assert_eq!(dry.heartbeat().subsidy, back);
}

/// P7 over a long random run: the equation holds per block and total supply never moves.
#[test]
fn conservation_holds_over_a_long_random_run() {
    let mut c = Chain::new(&[3_333_333, 2_222_222, 1_111_111, 777_777, 123_457], |p| p.subsidy_rate = 12_345_678);
    let supply = c.ledger.total_supply();
    let mut rng = Rng::new(42);
    for i in 0..600u64 {
        let set = c.ledger.sets.get(&c.ledger.height).unwrap().clone();
        // A random signer subset that still reaches quorum.
        let mut signers: Vec<KeyId> = set.members().iter().map(|m| m.0).collect();
        while signers.len() > 1 && rng.permille(400) {
            let drop = rng.below(signers.len() as u64) as usize;
            let mut trial = signers.clone();
            trial.remove(drop);
            if trial.iter().map(|k| set.weight(*k)).sum::<Weight>() >= set.quorum() {
                signers = trial;
            }
        }
        let n_tx = rng.below(4);
        let txs: Vec<Tx> = (0..n_tx).map(|k| transfer(i * 10 + k + 1, c.fee() * u128::from(rng.range(1, 977)))).collect();
        let dt = if txs.is_empty() { HOUR + rng.range(0, 5_000) } else { rng.range(1, 2 * HOUR) };
        let fx = c.next(dt, txs, vec![], Some(&signers)).unwrap();
        let credits: Quanta = fx.credits.iter().map(|c| c.1).sum();
        assert_eq!(credits + fx.burn + fx.unearned, fx.fees + fx.subsidy, "block {i}");
        assert_eq!(fx.supply_after, supply, "block {i}");
    }
}

/// §3.4: zero content only when `time ≥ parent.time + T_HB`; T1; the scheduled proposer.
#[test]
fn heartbeat_time_and_proposer_rules() {
    let mut c = Chain::new(&[1_000_000; 4], |_| {});
    assert_eq!(c.next(HOUR - 1, vec![], vec![], None), Err(BlockError::EmptyNotDue));
    assert!(c.next(HOUR, vec![], vec![], None).is_ok(), "exactly T_HB is due");
    let tip_time = c.ledger.tip_time;
    let cert = c.cert(None);
    let stale = Block::new(Header { height: 2, round: 0, builder: c.ledger.next_proposers().get(0).unwrap(), time_ms: tip_time, parent: c.ledger.tip }, cert.clone(), vec![transfer(1, c.fee())], vec![]);
    assert_eq!(c.apply(&stale), Err(BlockError::TimeNotAfterParent));
    let wrong = Block::new(Header { height: 2, round: 0, builder: c.ledger.next_proposers().get(1).unwrap(), time_ms: tip_time + 5, parent: c.ledger.tip }, cert.clone(), vec![transfer(1, c.fee())], vec![]);
    assert_eq!(c.apply(&wrong), Err(BlockError::WrongProposer));
    // header.round = 1 names the round-1 proposer: valid, and the stored priorities still advance one step only.
    let r1 = c.build(5, 1, vec![transfer(1, c.fee())], vec![], None);
    let expected_next = {
        let mut s = c.ledger.schedule.clone();
        s.step().unwrap();
        s
    };
    c.apply(&r1).unwrap();
    assert_eq!(c.ledger.schedule, expected_next);
    // The certificate for a block built in round 1 cannot claim round 0 (§3.6 "round ≥ header.round").
    let mut low = c.cert(None).unwrap();
    assert_eq!(low.round, 1);
    low.round = 0;
    let b = c.ledger.build_block(c.ledger.next_proposers().get(0).unwrap(), 0, c.ledger.tip_time + 9, Some(low), vec![transfer(2, c.fee())], vec![]);
    assert_eq!(c.apply(&b), Err(BlockError::CertRoundBelowHeader));
    // No certificate, a certificate below quorum, a duplicate signer: all invalid.
    let none = c.ledger.build_block(c.ledger.next_proposers().get(0).unwrap(), 0, c.ledger.tip_time + 9, None, vec![transfer(2, c.fee())], vec![]);
    assert_eq!(c.apply(&none), Err(BlockError::CertPresence));
    assert!(matches!(c.next(9, vec![transfer(2, c.fee())], vec![], Some(&[key(0), key(1)])), Err(BlockError::Cert(CertError::BelowQuorum { have: 2_000_000, need: 2_666_667 }))));
    let mut dup = c.cert(None).unwrap();
    dup.sigs[1] = dup.sigs[0];
    let b = c.ledger.build_block(c.ledger.next_proposers().get(0).unwrap(), 0, c.ledger.tip_time + 9, Some(dup), vec![transfer(2, c.fee())], vec![]);
    assert_eq!(c.apply(&b), Err(BlockError::Cert(CertError::SignerOrder)));
}

/// §4.5: unbonding is 21 days of header time; weight leaves at once (§6.4 removal).
#[test]
fn unbonding_releases_after_21_days_and_weight_drops_at_the_next_height() {
    let mut c = Chain::new(&[1_000_000; 4], |_| {});
    let bal = c.ledger.balance(acct(0));
    c.heartbeat();
    let tx = c.tx(acct(0), TxKind::Unbond { amount: 250_000 * XRGE });
    let fee = tx.fee;
    c.next(1_000, vec![tx], vec![], None).unwrap();
    assert_eq!(c.weight(key(0)), 750_000, "weight drops for the very next height");
    let release_at = c.ledger.unbonding[0].release_at;
    assert_eq!(release_at, c.ledger.tip_time + 21 * DAY);
    // One millisecond early: still locked. At the release time: paid out.
    let dt = release_at - 1 - c.ledger.tip_time;
    let early = c.next(dt, vec![], vec![], None).unwrap();
    assert!(early.released.is_empty());
    let on_time = c.next(1, vec![transfer(5, c.fee())], vec![], None).unwrap();
    assert_eq!(on_time.released, vec![(key(0), 250_000 * XRGE)]);
    let rewards: Quanta = c.effects.iter().flat_map(|f| f.credits.iter()).filter(|x| x.0 == acct(0)).map(|x| x.1).sum();
    assert_eq!(c.ledger.balance(acct(0)), bal - fee + 250_000 * XRGE + rewards);
}

/// §4.3 / §4.5: unbonding stake is slashed for an offence at or before the
/// entry's creation, inside the 21-day window — and not after it.
#[test]
fn unbonding_stake_is_slashable_inside_the_window_and_not_after() {
    let mut c = Chain::new(&[1_000_000; 5], |_| {});
    let supply = c.ledger.total_supply();
    c.heartbeat(); // 1
    c.heartbeat(); // 2  <- validator 1 double-signs here
    // Validator 2 unbonds at height 3, validator 1 at height 4.
    let u2 = c.tx(acct(2), TxKind::Unbond { amount: 200_000 * XRGE });
    c.next(1_000, vec![u2], vec![], None).unwrap(); // 3
    let u1 = c.tx(acct(1), TxKind::Unbond { amount: 300_000 * XRGE });
    c.next(1_000, vec![u1], vec![], None).unwrap(); // 4
    c.heartbeat(); // 5  <- validator 2 double-signs here, AFTER its unbond at 3
    let ev1 = c.double_sign(key(1), 2);
    let ev2 = c.double_sign(key(2), 5);
    let fx = c.next(1_000, vec![], vec![ev1, ev2], None).unwrap(); // 6
    // Validator 1: bond and the unbonding entry created after the offence are both cut, 100 %.
    assert_eq!(fx.slashes[0], SlashEvent { key: key(1), offence_height: 2, bond_before: 700_000 * XRGE, cut_bond: 700_000 * XRGE, cut_unbonding: 300_000 * XRGE });
    // Validator 2: its entry was created at height 3, before the offence at 5: not at stake then, not cut.
    assert_eq!(fx.slashes[1], SlashEvent { key: key(2), offence_height: 5, bond_before: 800_000 * XRGE, cut_bond: 800_000 * XRGE, cut_unbonding: 0 });
    assert_eq!(c.ledger.burned_slash, 1_800_000 * XRGE);
    assert_eq!(c.ledger.total_supply(), supply, "bonded + unbonding + burned is conserved");
    assert!(!c.ledger.active_set.contains(key(1)) && !c.ledger.active_set.contains(key(2)), "removed at once");
    assert!(c.ledger.validators[&key(1)].tombstoned);
    // Tombstone is permanent: the key can neither stake again nor be slashed again for that height.
    let again = c.tx(acct(1), TxKind::Stake { amount: 500_000 * XRGE });
    assert_eq!(c.next(1_000, vec![again], vec![], None), Err(BlockError::Tx(0, TxError::Tombstoned)));
    assert_eq!(c.next(1_000, vec![], vec![ev1], None), Err(BlockError::Evidence(0, EvidenceError::AlreadyPenalised)));
    // After the window: evidence for height 5 by validator 3 is refused, so its stake that left is safe.
    let u3 = c.tx(acct(3), TxKind::Unbond { amount: 100_000 * XRGE });
    c.next(1_000, vec![u3], vec![], None).unwrap();
    let off_time = c.ledger.times[&5];
    let ev3 = c.double_sign(key(3), 5);
    let dt = off_time + 21 * DAY - c.ledger.tip_time;
    let last_chance = c.build(dt, 0, vec![], vec![ev3], None);
    let too_late = c.build(dt + 1, 0, vec![], vec![ev3], None);
    assert_eq!(c.ledger.apply_block(&too_late).map(|_| ()), Err(BlockError::Evidence(0, EvidenceError::TooOld)));
    assert!(c.ledger.apply_block(&last_chance).is_ok(), "the last millisecond of the window is still inside it");
}

/// Rule R14: an entry that matures in the very block that carries the evidence is still cut.
#[test]
fn evidence_is_applied_before_unbonding_release_in_the_same_block() {
    let mut c = Chain::new(&[1_000_000; 5], |_| {});
    c.heartbeat();
    // Height 2: validator 1 unbonds; it also double-signs at height 2.
    let u = c.tx(acct(1), TxKind::Unbond { amount: 400_000 * XRGE });
    c.next(1_000, vec![u], vec![], None).unwrap();
    let t2 = c.ledger.tip_time;
    let ev = c.double_sign(key(1), 2);
    // A block exactly 21 days after height 2: the window's last instant and the entry's release instant.
    c.run_for(20 * DAY);
    let dt = t2 + 21 * DAY - c.ledger.tip_time;
    let fx = c.next(dt, vec![], vec![ev], None).unwrap();
    assert_eq!(fx.slashes[0].cut_unbonding, 400_000 * XRGE);
    assert!(fx.released.is_empty(), "nothing is released to the offender");
}

/// §4.2 rules 1–4 one by one; invalid evidence invalidates the block.
#[test]
fn evidence_rules() {
    let mut c = Chain::new(&[1_000_000; 4], |_| {});
    for _ in 0..3 {
        c.heartbeat();
    }
    let chain = c.ledger.params.chain_id.clone();
    let bad = |c: &Chain, ev: Evidence| c.ledger.apply_block(&c.build(1_000, 0, vec![], vec![ev], None)).map(|_| ()).unwrap_err();
    let s = sk(1);
    let v = |kind, h, r, b: Option<u8>| Vote::sign(&s, &chain, kind, h, r, b.map(|x| BlockId([x; 32])));
    // Not a conflict: same value; different rounds; different types.
    let pair = |a: Vote, b: Vote| if a <= b { Evidence { a, b } } else { Evidence { a: b, b: a } };
    assert_eq!(bad(&c, pair(v(VoteType::Prevote, 2, 0, Some(1)), v(VoteType::Prevote, 2, 0, Some(1)))), BlockError::Evidence(0, EvidenceError::NotConflicting));
    assert_eq!(bad(&c, pair(v(VoteType::Prevote, 2, 0, Some(1)), v(VoteType::Prevote, 2, 1, Some(2)))), BlockError::Evidence(0, EvidenceError::NotConflicting));
    assert_eq!(bad(&c, pair(v(VoteType::Prevote, 2, 0, Some(1)), v(VoteType::Precommit, 2, 0, Some(2)))), BlockError::Evidence(0, EvidenceError::NotConflicting));
    // Height must be below the block.
    assert_eq!(bad(&c, pair(v(VoteType::Prevote, 4, 0, Some(1)), v(VoteType::Prevote, 4, 0, None))), BlockError::Evidence(0, EvidenceError::HeightOutOfRange));
    // Forged signature.
    let mut forged = v(VoteType::Prevote, 2, 0, None);
    forged.sig.tag ^= 1;
    assert_eq!(bad(&c, pair(v(VoteType::Prevote, 2, 0, Some(1)), forged)), BlockError::Evidence(0, EvidenceError::BadSignature));
    // Signed in the wrong domain (V2 bytes for a post-fork height).
    let v2 = |b| Vote::sign_in(Domain::V2, &s, &chain, VoteType::Precommit, 2, 0, b);
    assert_eq!(bad(&c, pair(v2(Some(BlockId([1; 32]))), v2(None))), BlockError::Evidence(0, EvidenceError::BadSignature));
    // A key that was not in E(height).
    let outsider = SigningKey::model(KeyId(77));
    let o = |b| Vote::sign(&outsider, &chain, VoteType::Prevote, 2, 0, b);
    assert_eq!(bad(&c, pair(o(Some(BlockId([1; 32]))), o(None))), BlockError::Evidence(0, EvidenceError::NotEligible));
    // Valid: block against nil, and block against block; a prevote pair is as good as a precommit pair.
    let good = pair(v(VoteType::Prevote, 2, 3, Some(1)), v(VoteType::Prevote, 2, 3, None));
    let fx = c.next(1_000, vec![], vec![good], None).unwrap();
    assert_eq!(fx.slashes.len(), 1);
    // The same item twice in one block.
    let e2 = c.double_sign(key(2), 2);
    let twice = c.build(1_000, 0, vec![], vec![e2, e2], None);
    assert_eq!(c.ledger.apply_block(&twice).map(|_| ()), Err(BlockError::Evidence(1, EvidenceError::Repeated)));
}

/// Decision 6: 100,000 XRGE in consensus; validators already in the set have 30 days,
/// then leave at the next epoch boundary. Decision 8 and §6.4: a newcomer needs approval
/// by ≥ q of current stake and waits for the first epoch boundary ≥ 24 h later.
#[test]
fn minimum_grace_admission_and_delayed_additions() {
    // Validator 3 is a legacy validator below the minimum; node 4 is a newcomer with funds.
    let mut c = Chain::new(&[1_000_000, 1_000_000, 1_000_000, 50_000, 0], |_| {});
    let start = c.ledger.tip_time;
    assert!(c.ledger.active_set.contains(key(3)), "grace: still in the set");
    assert!(!c.ledger.active_set.contains(key(4)));

    // Hour 1: the newcomer stakes exactly the minimum; two of four approve (2,000,000 < q = 2,033,334).
    let stake = c.tx(acct(4), TxKind::Stake { amount: 100_000 * XRGE });
    let a0 = c.tx(acct(0), TxKind::Approve { candidate: key(4) });
    let a1 = c.tx(acct(1), TxKind::Approve { candidate: key(4) });
    c.next(HOUR, vec![stake, a0, a1], vec![], None).unwrap();
    assert_eq!(c.ledger.validators[&key(4)].approved_at, None);
    // An outsider cannot approve; nobody approves twice.
    let self_approve = c.tx(acct(4), TxKind::Approve { candidate: key(4) });
    assert_eq!(c.next(1_000, vec![self_approve], vec![], None), Err(BlockError::Tx(0, TxError::ApproveNotAllowed)));
    let again = c.tx(acct(0), TxKind::Approve { candidate: key(4) });
    assert_eq!(c.next(1_000, vec![again], vec![], None), Err(BlockError::Tx(0, TxError::ApproveNotAllowed)));
    // Hour 2: a third approval reaches quorum.
    let a2 = c.tx(acct(2), TxKind::Approve { candidate: key(4) });
    c.next(HOUR, vec![a2], vec![], None).unwrap();
    let approved_at = c.ledger.validators[&key(4)].approved_at.unwrap();
    assert_eq!(approved_at, start + 2 * HOUR);

    // The first epoch boundary (day 1) is only 22 h after approval: not yet.
    c.run_for(DAY - 2 * HOUR);
    assert!(c.effects.last().unwrap().epoch_boundary);
    assert!(!c.ledger.active_set.contains(key(4)), "23 h after staking, 22 h after approval: too early");
    assert_eq!(c.ledger.validators[&key(4)].bond, 0, "stake still pending");
    // No block between boundaries changes that.
    c.run_for(DAY - HOUR);
    assert!(!c.ledger.active_set.contains(key(4)));
    // Day 2 boundary: in, with its weight, and it starts with the entry penalty so it does not propose at once.
    let fx = c.heartbeat();
    assert!(fx.epoch_boundary && fx.activated == vec![key(4)]);
    assert_eq!(c.weight(key(4)), 100_000);
    let entry = c.ledger.schedule.entries().iter().find(|e| e.key == key(4)).unwrap().priority;
    assert!(entry < 0);
    assert_ne!(c.ledger.next_proposers().get(0), Some(key(4)));

    // More stake for an existing validator is an addition too: delayed to an epoch boundary.
    let more = c.tx(acct(0), TxKind::Stake { amount: 5_000 * XRGE });
    c.next(HOUR, vec![more], vec![], None).unwrap();
    assert_eq!(c.weight(key(0)), 1_000_000);
    c.run_for(2 * DAY);
    assert_eq!(c.weight(key(0)), 1_005_000);

    // The newcomer falls below the minimum by unbonding one XRGE: out at the next height (no grace for it).
    let dip = c.tx(acct(4), TxKind::Unbond { amount: XRGE });
    let fx = c.next(HOUR, vec![dip], vec![], None).unwrap();
    assert!(fx.removed.contains(&key(4)) && !c.ledger.active_set.contains(key(4)));

    // The legacy validator stays for 30 days of header time, then leaves at the next epoch boundary.
    while c.ledger.tip_time + 12 * HOUR < start + 30 * DAY {
        c.next(12 * HOUR, vec![], vec![], None).unwrap();
        assert!(c.ledger.active_set.contains(key(3)), "inside the grace period");
    }
    c.next(12 * HOUR, vec![], vec![], None).unwrap();
    let fx = c.effects.last().unwrap();
    assert!(fx.epoch_boundary && fx.removed.contains(&key(3)));
    assert!(!c.ledger.active_set.contains(key(3)));
    assert_eq!(c.ledger.active_set.len(), 3);
}

/// A legacy validator that reaches the minimum inside the grace keeps its place.
#[test]
fn topping_up_inside_the_grace_keeps_the_seat() {
    let mut c = Chain::new(&[1_000_000, 1_000_000, 1_000_000, 50_000], |_| {});
    let top_up = c.tx(acct(3), TxKind::Stake { amount: 50_000 * XRGE });
    c.next(HOUR, vec![top_up], vec![], None).unwrap();
    while c.ledger.tip_time < c.ledger.activation_time + 32 * DAY {
        c.next(12 * HOUR, vec![], vec![], None).unwrap();
    }
    assert_eq!(c.weight(key(3)), 100_000);
}

/// Decision 6: cap 32 by weight, ties to the lowest key; the rest are candidates.
#[test]
fn active_set_cap() {
    let mut stakes = vec![1_000_000u128; 33];
    stakes[5] = 999_999; // the lightest
    let mut c = Chain::new(&stakes, |_| {});
    assert_eq!(c.ledger.active_set.len(), 33, "the cap is applied at epoch boundaries");
    c.run_for(DAY);
    assert_eq!(c.ledger.active_set.len(), 32);
    assert!(!c.ledger.active_set.contains(key(5)));
    // Ties: with equal weights the highest key is the one left out.
    let mut d = Chain::new(&[1_000_000; 5], |p| p.max_active = 4);
    d.run_for(DAY);
    assert_eq!(d.ledger.active_set.members().iter().map(|m| m.0).collect::<Vec<_>>(), vec![key(0), key(1), key(2), key(3)]);
    // A candidate is not paid: it signed the boundary block (it was in that block's set), and nothing after.
    d.heartbeat();
    let fx = d.heartbeat();
    assert!(fx.credits.iter().all(|c| c.0 != acct(4)));
}

/// Decision 4 / §4.4: jail after missing MORE than 100 of the last 200 certificates
/// assembled by at least 3 proposers; 1 h; no slash; return by `unjail` after the delay.
#[test]
fn downtime_jailing_threshold_unjail_and_no_slash() {
    let mut c = Chain::new(&[1_000_000; 5], |_| {});
    let online = [key(0), key(1), key(2), key(3)];
    c.heartbeat(); // block 1 carries no certificate
    for i in 0..100 {
        let fx = c.next(HOUR, vec![], vec![], Some(&online)).unwrap();
        assert!(fx.jailed.is_empty(), "absent from {} certificates: not more than 100", i + 1);
    }
    let bond = c.ledger.validators[&key(4)].bond;
    let fx = c.next(HOUR, vec![], vec![], Some(&online)).unwrap();
    assert_eq!(fx.jailed.len(), 1);
    assert_eq!(fx.jailed[0].0, key(4));
    assert_eq!(fx.jailed[0].1.len(), 5, "omitted by five distinct proposers");
    assert!(!c.ledger.active_set.contains(key(4)));
    assert_eq!(c.ledger.validators[&key(4)].bond, bond, "no slash");
    assert_eq!(c.ledger.burned_slash, 0);
    let jailed_at = c.ledger.tip_time;
    // Unjail before one hour of header time: refused. After: accepted, effective at an epoch boundary ≥ 24 h later.
    let early = c.tx(acct(4), TxKind::Unjail);
    assert_eq!(c.next(HOUR - 1, vec![early.clone()], vec![], None), Err(BlockError::Tx(0, TxError::UnjailNotAllowed)));
    c.next(HOUR, vec![early], vec![], None).unwrap();
    assert_eq!(c.ledger.tip_time, jailed_at + HOUR);
    let requested = c.ledger.tip_time;
    while !c.ledger.active_set.contains(key(4)) {
        c.heartbeat();
    }
    let back = c.ledger.tip_time;
    assert!(back - requested >= DAY && back % DAY < HOUR, "returns at the first epoch boundary at least 24 h after the request");
    assert!(c.ledger.validators[&key(4)].window.is_empty(), "the bitmap restarts");
    // It was never paid for a block it neither signed nor built.
    let paid: Quanta = c.effects.iter().filter(|f| !f.signers.contains(&key(4)) && f.round0_proposer != Some(key(4))).flat_map(|f| f.credits.iter()).filter(|x| x.0 == acct(4)).map(|x| x.1).sum();
    assert_eq!(paid, 0);
}

/// §4.4 rule 3: no jailing that would leave a key at one third or more, or that
/// would take the stake jailed inside the window above one third of T.
#[test]
fn jailing_never_concentrates_stake() {
    let small = |p: &mut Params| {
        p.jail_window = 10;
        p.jail_missed = 3;
    };
    // Four equal validators, one offline: jailing it would leave three keys at exactly one third each.
    let mut c = Chain::new(&[1_000_000; 4], small);
    c.heartbeat();
    for _ in 0..40 {
        assert!(c.next(HOUR, vec![], vec![], Some(&[key(0), key(1), key(2)])).unwrap().jailed.is_empty());
    }
    // Today's shape: one key above one third already. Nobody is ever jailed, however absent.
    let mut t = Chain::new(&[100_090_000, 10_000, 9_000], small);
    t.heartbeat();
    for _ in 0..40 {
        assert!(t.next(HOUR, vec![], vec![], Some(&[key(0)])).unwrap().jailed.is_empty());
    }
    // Ten equal validators, three offline. Two are jailed at once; the third would take the stake
    // jailed inside the window above one third of the (shrunken) total, so it waits until the
    // window has moved on. Nobody ever ends at or above one third.
    let mut d = Chain::new(&[1_000_000; 10], small);
    let online: Vec<KeyId> = (0..7).map(key).collect();
    d.heartbeat();
    let mut jailed = Vec::new();
    for _ in 0..40 {
        jailed.extend(d.next(HOUR, vec![], vec![], Some(&online)).unwrap().jailed.into_iter().map(|j| j.0));
    }
    assert_eq!(jailed, vec![key(7), key(8), key(9)]);
    assert_eq!(d.effects.iter().filter(|f| !f.jailed.is_empty()).map(|f| f.jailed.len()).collect::<Vec<_>>(), vec![2, 1], "the cap delays the third");
    let total = d.ledger.active_set.total();
    assert!(d.ledger.active_set.members().iter().all(|(_, w)| w * 3 < total));
}

/// §4.4 rule 2 as made explicit (rule R19): omissions by fewer than m proposers never jail.
#[test]
fn omissions_by_one_proposer_do_not_jail() {
    let mut c = Chain::new(&[2_500_000, 1_500_000, 1_500_000, 1_500_000, 1_500_000, 1_500_000], |p| {
        p.jail_window = 20;
        p.jail_missed = 4;
    });
    c.heartbeat();
    let all: Vec<KeyId> = (0..6).map(key).collect();
    let without_5: Vec<KeyId> = (0..5).map(key).collect();
    let mut omissions = 0;
    for _ in 0..200 {
        // Validator 0 leaves validator 5 out of every certificate it assembles; everyone else is honest.
        let greedy = c.ledger.next_proposers().get(0) == Some(key(0));
        omissions += u32::from(greedy);
        let fx = c.next(HOUR, vec![], vec![], Some(if greedy { &without_5 } else { &all })).unwrap();
        assert!(fx.jailed.is_empty(), "one proposer's omissions must not jail an online validator");
    }
    assert!(omissions >= 45, "validator 0 holds 25 % of the slots ({omissions})");
}

/// §8.2: the last block under the old rules and the first under the new.
#[test]
fn activation_boundary() {
    // Today's stakes; the tip is block 99, produced and certified under today's rules.
    let g = Genesis {
        tip_height: 99,
        tip: BlockId([9; 32]),
        tip_time: 20_000 * DAY,
        validators: vec![(key(0), 10_000 * XRGE), (key(1), 100_090_000 * XRGE), (key(2), 9_000 * XRGE)],
        balances: vec![(Account::User(0), 1_000 * XRGE), (Account::User(1), 0)],
    };
    let ledger = Ledger::genesis(Params::decided("rouge-test"), &g).unwrap();
    assert_eq!(ledger.params.activation_height, 100);
    assert_eq!(ledger.domain_of(99), Domain::V2);
    assert_eq!(ledger.domain_of(100), Domain::V3);
    // Priorities start at zero, so the first proposer is today's designated one: the greatest stake.
    assert_eq!(ledger.next_proposers().get(0), Some(key(1)));
    let chain = "rouge-test";
    let precommit = |domain, k: usize, height, round, block| (key(k), Vote::sign_in(domain, &sk(k), chain, VoteType::Precommit, height, round, Some(block)).sig);
    // Today's certificate: the votes that reached quorum first — here the large key alone — round 0, V2 bytes.
    let legacy = CommitCert { domain: Domain::V2, height: 99, round: 0, block: g.tip, n_set: 3, sigs: vec![precommit(Domain::V2, 1, 99, 0, g.tip)] };
    let tx_ok = |id| Tx { id, from: Account::User(0), fee: 1_000_000, kind: TxKind::Transfer { to: Account::User(1), amount: 1 } };
    let build = |l: &Ledger, cert: CommitCert, id: u64| l.build_block(key(1), 0, l.tip_time + 1_000, Some(cert), vec![tx_ok(id)], vec![]);

    // Block 100 — the first under the new rules — carries the V2 certificate, verified under V2 rules.
    let b100 = build(&ledger, legacy.clone(), 1);
    let (l100, fx) = ledger.apply_block(&b100).unwrap();
    assert_eq!(fx.signers, vec![key(1)]);
    // The same signatures presented as a V3 certificate, or V3 signatures for the old height: refused.
    let relabelled = CommitCert { domain: Domain::V3, ..legacy.clone() };
    assert_eq!(ledger.apply_block(&build(&ledger, relabelled, 1)).map(|_| ()), Err(BlockError::Cert(CertError::WrongDomain)));
    let v3_sig = CommitCert { sigs: vec![precommit(Domain::V3, 1, 99, 0, g.tip)], ..legacy.clone() };
    assert_eq!(ledger.apply_block(&build(&ledger, v3_sig, 1)).map(|_| ()), Err(BlockError::Cert(CertError::BadSignature(key(1)))));
    // The old verifier accepts round 0 only.
    let r1 = CommitCert { round: 1, sigs: vec![precommit(Domain::V2, 1, 99, 1, g.tip)], ..legacy.clone() };
    assert_eq!(ledger.apply_block(&build(&ledger, r1, 1)).map(|_| ()), Err(BlockError::Cert(CertError::LegacyRoundNotZero)));

    // Block 101 must carry a V3 certificate for block 100; a V2-signed one is refused.
    let v3 = CommitCert { domain: Domain::V3, height: 100, round: 0, block: b100.id(), n_set: 3, sigs: vec![precommit(Domain::V3, 1, 100, 0, b100.id())] };
    assert!(l100.apply_block(&build(&l100, v3.clone(), 2)).is_ok());
    let old_style = CommitCert { domain: Domain::V2, sigs: vec![precommit(Domain::V2, 1, 100, 0, b100.id())], ..v3.clone() };
    assert_eq!(l100.apply_block(&build(&l100, old_style, 2)).map(|_| ()), Err(BlockError::Cert(CertError::WrongDomain)));
    let v2_bytes = CommitCert { sigs: vec![precommit(Domain::V2, 1, 100, 0, b100.id())], ..v3.clone() };
    assert_eq!(l100.apply_block(&build(&l100, v2_bytes, 2)).map(|_| ()), Err(BlockError::Cert(CertError::BadSignature(key(1)))));

    // Nothing signed before the fork can conflict with anything after: a V2 vote is not a V3 vote.
    let v2_vote = Vote::sign_in(Domain::V2, &sk(2), chain, VoteType::Precommit, 100, 0, Some(b100.id()));
    assert!(v2_vote.verify(Domain::V2, chain) && !v2_vote.verify(Domain::V3, chain));
    // Pre-fork double-signing stays punishable after the fork, under the bytes it was signed with (§4.2 rule 3).
    let old = |b| Vote::sign_in(Domain::V2, &sk(2), chain, VoteType::Precommit, 99, 0, b);
    let ev = Evidence::from_votes(&old(Some(g.tip)), &old(None)).unwrap();
    let with_ev = l100.build_block(key(1), 0, l100.tip_time + 1_000, Some(v3), vec![], vec![ev]);
    let (l101, fx) = l100.apply_block(&with_ev).unwrap();
    assert_eq!(fx.slashes[0].cut_bond, 9_000 * XRGE);
    assert!(!l101.active_set.contains(key(2)));
    // Downtime is not counted from a V2 certificate: it never listed every signer (rule R21).
    assert!(l100.validators.values().all(|v| v.window.is_empty()));
}
