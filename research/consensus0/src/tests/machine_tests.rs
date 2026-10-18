//! Scripted consensus scenarios: the deviations D1–D7, the stuck-lock case
//! (P5), on-demand heights and heartbeats, restarts, equivocation, catching up,
//! and today's stake distribution.

use std::sync::Arc;

use super::lab::*;
use crate::chain::{Account, Tx, TxKind};
use crate::machine::*;
use crate::node::NodeInput;
use crate::sim::transfer;
use crate::types::*;

const ALL4: [usize; 4] = [0, 1, 2, 3];
const EQUAL4: [Weight; 4] = [1_000_000; 4];

fn vote_msg(i: usize, chain: &str, kind: VoteType, height: Height, round: Round, block: Option<BlockId>) -> NodeInput {
    NodeInput::Message(Message::Vote(Vote::sign(&sk(i), chain, kind, height, round, block)))
}

// ---------------------------------------------------------------- basics --

#[test]
fn four_validators_commit_in_round_zero() {
    let mut lab = Lab::new(&EQUAL4);
    lab.commit_height(1);
    let id = lab.committed(0, 1).expect("committed");
    for i in ALL4 {
        assert_eq!(lab.commits[i], vec![(1, id, 0)]);
        assert_eq!(lab.step(i), Step::NewHeight, "waiting on demand for height 2");
        assert_eq!(lab.locked(i), None);
    }
    assert_eq!(lab.proposed(1, 0).unwrap().header.builder, key(0));
}

/// §3.7: what must be durable is emitted before the message it protects, and
/// the persisted records rebuild the lock.
#[test]
fn persist_records_precede_the_messages_they_protect() {
    let ledger = ledger_with(&EQUAL4, |_| {});
    let chain: Arc<str> = Arc::from(ledger.params.chain_id.as_str());
    let cfg = Config { chain_id: chain.clone(), key: Some(sk(1)), timeouts: Timeouts::MODERATE, heartbeat_ms: HOUR };
    let ctx = HeightCtx { height: 1, set: ledger.active_set.clone(), proposers: ledger.next_proposers(), parent: ledger.tip, parent_time: ledger.tip_time, pending_work: true };
    let (mut m, mut all) = Machine::new(cfg, ctx);
    let block = Arc::new(ledger.build_block(key(0), 0, ledger.tip_time + 5, None, vec![transfer(1, 1_000_000)], vec![]));
    let proposal = Proposal::sign(&sk(0), &chain, 1, 0, None, block.clone());
    all.extend(m.handle(Input::Proposal { proposal, verdict: Verdict::Valid }));
    for i in [0, 2] {
        all.extend(m.handle(Input::Vote(Vote::sign(&sk(i), &chain, VoteType::Prevote, 1, 0, Some(block.id())))));
    }
    assert_eq!(m.locked(), Some((0, block.id())));
    let pos = |pred: &dyn Fn(&Output) -> bool| all.iter().position(|o| pred(o)).expect("output present");
    let prevote_slot = pos(&|o| matches!(o, Output::Persist(PersistRecord::VoteSlot { kind: VoteType::Prevote, .. })));
    let prevote_sent = pos(&|o| matches!(o, Output::Broadcast(Message::Vote(v)) if v.kind == VoteType::Prevote));
    let lock = pos(&|o| matches!(o, Output::Persist(PersistRecord::Lock { .. })));
    let valid = pos(&|o| matches!(o, Output::Persist(PersistRecord::RoundState { valid: Some(_), .. })));
    let precommit_slot = pos(&|o| matches!(o, Output::Persist(PersistRecord::VoteSlot { kind: VoteType::Precommit, .. })));
    let precommit_sent = pos(&|o| matches!(o, Output::Broadcast(Message::Vote(v)) if v.kind == VoteType::Precommit));
    assert!(prevote_slot < prevote_sent);
    assert!(lock < precommit_sent && valid < precommit_sent && precommit_slot < precommit_sent, "no lock file, no precommit");
    let mut saved = PersistedState::default();
    for o in &all {
        if let Output::Persist(rec) = o {
            saved.apply(rec);
        }
    }
    assert_eq!(saved.locked.as_ref().map(|(r, b)| (*r, b.id())), Some((0, block.id())));
    assert_eq!(saved.votes.get(&(VoteType::Precommit, 0)), Some(&Some(block.id())));
    // The by-value form is the same function.
    let (m2, out) = step(m.clone(), Input::TxPending);
    assert_eq!(m2.state_hash(), m.state_hash());
    assert!(out.is_empty());
}

// ------------------------------------------------------------ D1: bytes --

#[test]
fn d1_signed_bytes_sizes_and_domain_separation() {
    let id = BlockId([0xab; 32]);
    let hex = "ab".repeat(32);
    assert_eq!(vote_sign_bytes(Domain::V3, "rougechain-mainnet", VoteType::Prevote, 12, 3, None), "ROUGECHAIN_CONSENSUS_V3|chain=rougechain-mainnet|type=prevote|height=12|round=3|block=nil");
    assert_eq!(
        vote_sign_bytes(Domain::V3, "rougechain-mainnet", VoteType::Precommit, 250, 0, Some(&id)),
        format!("ROUGECHAIN_CONSENSUS_V3|chain=rougechain-mainnet|type=precommit|height=250|round=0|block={hex}")
    );
    assert_eq!(proposal_sign_bytes("c", 7, 2, None, &id), format!("ROUGECHAIN_CONSENSUS_V3|chain=c|type=proposal|height=7|round=2|pol=none|block={hex}"));
    assert_eq!(proposal_sign_bytes("c", 7, 2, Some(1), &id), format!("ROUGECHAIN_CONSENSUS_V3|chain=c|type=proposal|height=7|round=2|pol=1|block={hex}"));
    assert_eq!(vote_sign_bytes(Domain::V2, "c", VoteType::Precommit, 7, 0, Some(&id)), format!("ROUGECHAIN_FINALITY_VOTE_V2|chain=c|type=precommit|height=7|round=0|block={hex}"));
    // Real ML-DSA-65 sizes (§2.2).
    assert_eq!((SIG_BYTES, KEY_BYTES, VOTE_WIRE_BYTES), (3_309, 1_952, 3_356));
    // A signature binds chain, type, height, round and value; another key cannot produce it.
    let v = Vote::sign(&sk(1), "c", VoteType::Prevote, 5, 1, Some(id));
    assert!(v.verify(Domain::V3, "c"));
    assert!(!v.verify(Domain::V3, "d") && !v.verify(Domain::V2, "c"));
    for forged in [Vote { round: 2, ..v }, Vote { height: 6, ..v }, Vote { kind: VoteType::Precommit, ..v }, Vote { block: None, ..v }, Vote { voter: key(2), ..v }] {
        assert!(!forged.verify(Domain::V3, "c"));
    }
    // The machine ignores a vote signed in the pre-fork domain, and one from outside the set.
    let mut lab = Lab::new(&EQUAL4);
    let chain = lab.chain_id();
    let before = lab.nodes[1].machine.state_hash();
    let old = Vote::sign_in(Domain::V2, &sk(0), &chain, VoteType::Prevote, 1, 0, None);
    lab.input(1, NodeInput::Message(Message::Vote(old)));
    lab.input(1, NodeInput::Message(Message::Vote(Vote::sign(&SigningKey::model(KeyId(99)), &chain, VoteType::Prevote, 1, 0, None))));
    assert_eq!(lab.nodes[1].machine.state_hash(), before);
}

// ------------------------------------------- D2: on-demand heights (§3.4) --

#[test]
fn d2_nothing_happens_without_work_and_one_small_validator_cannot_start_a_height() {
    let mut lab = Lab::new(&EQUAL4);
    assert!(lab.outbox.is_empty() && lab.timers.iter().all(|t| t.is_empty()));
    assert!(ALL4.iter().all(|i| lab.step(*i) == Step::NewHeight));
    // Rule 1 at one validator (not the proposer): it starts alone and prevotes nil on timeout.
    let fee = lab.nodes[0].ledger.params.base_fee;
    lab.tx(&[3], transfer(1, fee));
    assert_eq!(lab.step(3), Step::Propose);
    assert!(lab.fire(3, TimerKind::Propose));
    lab.settle_all();
    // One quarter of the stake is below t1: nobody else starts (rule 4 not met).
    assert!([0, 1, 2].iter().all(|i| lab.step(*i) == Step::NewHeight));
    // A second validator has work: together they hold ≥ t1, and the others join.
    lab.tx(&[2], transfer(1, fee));
    assert!(lab.fire(2, TimerKind::Propose));
    lab.deliver(&[2, 3], &[1], |_| true);
    assert_eq!(lab.step(1), Step::Propose, "rule 4: votes from ≥ t1 start the height");
}

#[test]
fn d2_a_proposal_starts_the_height_and_an_idle_proposer_loses_its_turn() {
    // Rule 3: a valid proposal starts the height for a validator with an empty mempool.
    let mut lab = Lab::new(&EQUAL4);
    let fee = lab.nodes[0].ledger.params.base_fee;
    lab.tx(&[0], transfer(1, fee));
    lab.deliver(&[0], &[1], is_proposal);
    assert_eq!(lab.step(1), Step::Prevote);
    assert_eq!(lab.votes_of(1, VoteType::Prevote, 1, 0)[0].block, lab.proposed(1, 0).map(|b| b.id()));

    // A proposer with nothing to propose does not propose; the next round's proposer serves the others.
    let mut lab = Lab::new(&EQUAL4);
    lab.tx(&[1, 2, 3], transfer(1, fee));
    lab.fire_all(&[1, 2, 3], TimerKind::Propose);
    lab.settle_all();
    assert_eq!(lab.step(0), Step::Propose, "the proposer was drawn in by rule 4");
    assert!(lab.proposed(1, 0).is_none(), "empty mempool, heartbeat not due: no proposal");
    lab.fire(0, TimerKind::Propose);
    lab.settle_all();
    lab.fire_all(&ALL4, TimerKind::Precommit);
    lab.settle_all();
    let block = lab.proposed(1, 1).expect("round 1 proposal");
    assert_eq!((block.header.builder, block.header.round), (key(1), 1));
    assert!(ALL4.iter().all(|i| lab.commits[*i] == vec![(1, block.id(), 1)]));
}

#[test]
fn d2_heartbeat_only_heights() {
    let mut lab = Lab::new(&EQUAL4);
    // Not due yet: the alarm is ignored and nothing is proposed.
    lab.advance(HOUR - 1_001);
    lab.wake(&ALL4);
    assert!(lab.outbox.is_empty());
    // Due: the scheduled proposer builds an empty block and it is voted like any block.
    lab.advance(1);
    lab.wake(&ALL4);
    lab.settle_all();
    let b1 = lab.proposed(1, 0).unwrap();
    assert!(b1.is_empty() && b1.header.time_ms == lab.nodes[0].ledger.params.heartbeat_ms + lab.nodes[0].ledger.activation_time);
    assert!(ALL4.iter().all(|i| lab.committed(*i, 1) == Some(b1.id())));
    // The next heartbeat is an hour of header time later, and carries the certificate for the first.
    lab.advance(HOUR - 1);
    lab.wake(&ALL4);
    assert!(lab.proposed(2, 0).is_none());
    lab.advance(1);
    lab.wake(&ALL4);
    lab.settle_all();
    let b2 = lab.proposed(2, 0).unwrap();
    assert!(b2.is_empty());
    assert_eq!(b2.parent_cert.as_ref().map(|c| (c.sigs.len(), c.encoded_len())), Some((4, 13_284)));
    assert!(ALL4.iter().all(|i| lab.committed(*i, 2) == Some(b2.id())));
}

// -------------------------------------------------- D3: integer thresholds --

#[test]
fn d3_thresholds_are_exact_in_stake_not_in_heads() {
    // T = 100: q = 67, t1 = 34. Validators 0 (34) and 1 (33) together hold exactly 67.
    let mut lab = Lab::new(&[34, 33, 33]);
    let fee = lab.nodes[0].ledger.params.base_fee;
    lab.tx(&[0, 1, 2], transfer(1, fee));
    lab.settle(&[0, 1]);
    assert!(lab.committed(0, 1).is_some() && lab.committed(1, 1).is_some(), "67 of 100 commits");
    // 33 + 33 = 66 does not.
    let mut lab = Lab::new(&[34, 33, 33]);
    lab.tx(&[0, 1, 2], transfer(1, fee));
    lab.deliver(&[0], &[1, 2], is_proposal);
    lab.settle(&[1, 2]);
    assert!(lab.committed(1, 1).is_none() && lab.locked(1).is_none(), "66 of 100 is not a quorum");
    // t1: 33 alone does not pull a waiting validator into the height, 34 does.
    let mut lab = Lab::new(&[34, 33, 33]);
    let chain = lab.chain_id();
    lab.input(1, vote_msg(2, &chain, VoteType::Prevote, 1, 0, None));
    assert_eq!(lab.step(1), Step::NewHeight);
    lab.input(2, vote_msg(0, &chain, VoteType::Prevote, 1, 0, None));
    assert_eq!(lab.step(2), Step::Propose);
}

// ----------------------------------------------------- D4: header time T2 --

#[test]
fn d4_time_too_far_ahead_is_a_nil_prevote_not_a_permanent_rejection() {
    let mut lab = Lab::new(&EQUAL4);
    lab.offsets[0] = 60_000; // the round-0 proposer's clock is a minute fast; the drift bound is 10 s
    lab.tx_all(1);
    let early = lab.proposed(1, 0).unwrap();
    lab.deliver(&[0], &[1, 2, 3], is_proposal);
    for i in [1, 2, 3] {
        assert_eq!(lab.votes_of(i, VoteType::Prevote, 1, 0)[0].block, None, "T2 failure: nil prevote in this round");
    }
    lab.settle_all();
    lab.fire_all(&ALL4, TimerKind::Precommit);
    lab.settle_all();
    let b = lab.proposed(1, 1).unwrap();
    assert!(ALL4.iter().all(|i| lab.commits[*i] == vec![(1, b.id(), 1)]));
    // The same header time is acceptable once local clocks catch up.
    let l = ledger_with(&EQUAL4, |_| {});
    assert!(!l.time_within_drift(&early, early.header.time_ms - 10_001));
    assert!(l.time_within_drift(&early, early.header.time_ms - 10_000));
}

/// Rule R1b: T2 gates prevotes only. A block that gathers a quorum of precommits
/// is committed even by a validator whose clock still thinks it is early.
#[test]
fn d4_a_block_with_a_commit_quorum_is_committed_regardless_of_local_t2() {
    let mut lab = Lab::new(&EQUAL4);
    lab.offsets = vec![60_000, 60_000, 60_000, 0]; // three fast clocks, one correct
    lab.tx_all(1);
    lab.settle_all();
    let b = lab.proposed(1, 0).unwrap();
    assert_eq!(lab.votes_of(3, VoteType::Prevote, 1, 0)[0].block, None);
    assert!(ALL4.iter().all(|i| lab.committed(*i, 1) == Some(b.id())), "the validator that prevoted nil still commits");
}

// ---------------------------------------------- D5: set changes (§6.4) --

/// A validator-set change falls exactly on an epoch-boundary block whose
/// height takes two rounds: the set that decides the height never changes
/// mid-height; the new validator votes from the next height.
#[test]
fn d5_set_change_at_an_epoch_boundary_during_a_round() {
    let ledger = ledger_with(&[1_000_000, 1_000_000, 1_000_000, 1_000_000, 0], |_| {});
    let fee = ledger.params.base_fee;
    let mut lab = Lab::on(ledger, 5);
    let all = [0, 1, 2, 3, 4];
    // One block with the stake and three approvals (placed in every mempool before the last one triggers the height).
    let stake = Tx { id: 50, from: Account::Key(key(4)), fee, kind: TxKind::Stake { amount: 200_000 * XRGE } };
    let approve = |i: usize| Tx { id: 51 + i as u64, from: Account::Key(key(i)), fee, kind: TxKind::Approve { candidate: key(4) } };
    for node in lab.nodes.iter_mut() {
        node.mempool.extend([stake.clone(), approve(0), approve(1)]);
    }
    lab.tx(&all, approve(2));
    lab.settle(&all);
    assert_eq!(lab.nodes[0].chain[0].block.txs.len(), 4);
    assert!(lab.committed(4, 1).is_some(), "an observer follows the chain");
    assert!(lab.nodes[0].ledger.validators[&key(4)].approved_at.is_some());
    assert!(lab.votes_of(4, VoteType::Prevote, 1, 0).is_empty(), "not in E(1): signs nothing");

    // Two days later the next block crosses an epoch boundary. Round 0 fails.
    lab.advance(2 * DAY);
    lab.tx(&all, transfer(60, fee));
    lab.fire_all(&[0, 2, 3], TimerKind::Propose); // the proposal of round 0 never arrives
    lab.settle(&all);
    lab.fire_all(&all, TimerKind::Precommit);
    assert!(all.iter().all(|i| lab.round(*i) == 1));
    assert!(all.iter().all(|i| lab.nodes[*i].machine.set().len() == 4), "E(2) is fixed for every round of height 2");
    lab.settle(&all);
    let b2 = lab.proposed(2, 1).unwrap();
    assert!(all.iter().all(|i| lab.commits[*i].last() == Some(&(2, b2.id(), 1))));
    assert!(lab.nodes[0].chain[1].effects.epoch_boundary && lab.nodes[0].chain[1].effects.activated == vec![key(4)]);
    assert!(lab.votes_of(4, VoteType::Prevote, 2, 1).is_empty(), "still not a voter in the boundary block");
    // From the next height it is in the set, votes, and is counted.
    assert!(all.iter().all(|i| lab.nodes[*i].machine.set().len() == 5 && lab.nodes[*i].machine.set().weight(key(4)) == 200_000));
    lab.tx(&all, transfer(61, fee));
    lab.settle(&all);
    assert_eq!(lab.votes_of(4, VoteType::Precommit, 3, 0).len(), 1);
    // Removal is immediate: an unbond in block 4 changes the weight for block 5.
    lab.tx(&all, Tx { id: 62, from: Account::Key(key(0)), fee, kind: TxKind::Unbond { amount: 400_000 * XRGE } });
    lab.settle(&all);
    assert!(all.iter().all(|i| lab.nodes[*i].machine.height() == 5 && lab.nodes[*i].machine.set().weight(key(0)) == 600_000));
}

// ------------------------------------ D6: the certificate lists everyone --

#[test]
fn d6_certificate_lists_every_precommit_the_proposer_holds_and_rewards_follow_it() {
    let mut lab = Lab::new(&EQUAL4);
    lab.tx_all(1);
    // Validator 3's precommit reaches everyone except validator 1, the proposer of height 2.
    let not_3s_precommit = |m: &Message| !matches!(m, Message::Vote(v) if v.kind == VoteType::Precommit && v.voter == key(3));
    while lab.deliver(&ALL4, &ALL4, not_3s_precommit) > 0 {}
    lab.deliver(&[3], &[0, 2], |_| true);
    assert!(ALL4.iter().all(|i| lab.committed(*i, 1).is_some()));
    // Height 2. The proposer lacks one precommit, so it observes the commit wait; the others do not need to.
    lab.tx_all(2);
    assert_eq!(lab.step(1), Step::NewHeight, "commit wait: collecting late precommits");
    assert_eq!(lab.step(0), Step::Propose, "all four held: no wait");
    assert!(lab.fire(1, TimerKind::CommitWait));
    lab.settle_all();
    let b2 = lab.proposed(2, 0).unwrap();
    let cert = b2.parent_cert.clone().unwrap();
    assert_eq!(cert.signers().collect::<Vec<_>>(), vec![key(0), key(1), key(2)], "every precommit it held, and only those");
    assert_eq!(cert.encoded_len(), 9_975);
    let fx = &lab.nodes[0].chain[1].effects;
    assert!(fx.credits.iter().all(|c| c.0 != Account::Key(key(3))), "not in the certificate: no reward (§5.1)");
    assert!(fx.unearned > 0, "the withheld share goes to the reserve, not to the proposer");
    // Height 3: everyone's precommit for height 2 arrived, so the certificate is complete.
    lab.tx_all(3);
    lab.settle_all();
    let b3 = lab.proposed(3, 0).unwrap();
    assert_eq!(b3.parent_cert.as_ref().map(|c| (c.sigs.len(), c.encoded_len())), Some((4, 13_284)));
}

// --------------------------------------------------------- D7: timeouts --

#[test]
fn d7_timeouts_grow_linearly_and_stop_at_the_cap() {
    let t = Timeouts::MODERATE;
    assert_eq!((t.propose(0), t.propose(1), t.propose(2)), (6_000, 8_000, 10_000));
    assert_eq!((t.vote(0), t.vote(1), t.vote(3)), (2_000, 3_000, 5_000));
    assert_eq!((t.propose(56), t.propose(57), t.propose(58), t.propose(u32::MAX)), (118_000, 120_000, 120_000, 120_000));
    assert_eq!((t.vote(117), t.vote(118), t.vote(119), t.vote(u32::MAX)), (119_000, 120_000, 120_000, 120_000));
    assert_eq!((Timeouts::FAST.propose(1), Timeouts::FAST.cap, Timeouts::SLOW.propose(1), Timeouts::SLOW.vote(1)), (3_500, 60_000, 30_000, 10_000));
    // The machine asks for exactly these durations.
    let ledger = ledger_with(&EQUAL4, |_| {});
    let cfg = Config { chain_id: Arc::from("c"), key: Some(sk(2)), timeouts: t, heartbeat_ms: HOUR };
    let ctx = HeightCtx { height: 1, set: ledger.active_set.clone(), proposers: ledger.next_proposers(), parent: ledger.tip, parent_time: ledger.tip_time, pending_work: true };
    let (mut m, out) = Machine::new(cfg, ctx);
    let timer = |out: &[Output], want: TimerKind| out.iter().find_map(|o| match o {
        Output::SetTimer { kind, round, ms, .. } if *kind == want => Some((*round, *ms)),
        _ => None,
    });
    assert_eq!(timer(&out, TimerKind::Propose), Some((0, 6_000)));
    let out = m.handle(Input::Timeout { kind: TimerKind::Precommit, height: 1, round: 0 });
    assert_eq!(timer(&out, TimerKind::Propose), Some((1, 8_000)));
    // Three nil prevotes (a quorum of anything) start the prevote timeout of round 1: 2 s + 1 s.
    m.handle(Input::Timeout { kind: TimerKind::Propose, height: 1, round: 1 });
    let mut out = Vec::new();
    for i in [0, 1] {
        out.extend(m.handle(Input::Vote(Vote::sign(&sk(i), "c", VoteType::Prevote, 1, 1, Some(BlockId([i as u8; 32]))))));
    }
    assert_eq!(timer(&out, TimerKind::Prevote), Some((1, 3_000)));
    // A stale timer (old round) is ignored; rounds never go backwards (I4).
    m.handle(Input::Timeout { kind: TimerKind::Precommit, height: 1, round: 0 });
    assert_eq!(m.round(), 1);
}

// --------------------------------------------------- P5: no stuck locks --

/// The defect of the earlier "Release 2b" design: some validators precommit
/// the block, the rest precommit nil, neither side reaches a quorum.
#[test]
fn p5_split_precommits_do_not_leave_the_round_stuck() {
    let mut lab = Lab::new(&EQUAL4);
    lab.tx_all(1);
    let x = lab.proposed(1, 0).unwrap().id();
    lab.deliver(&[0], &[1, 2], is_proposal); // validator 3 never sees the proposal in time
    lab.fire(3, TimerKind::Propose);
    // Validators 0 and 1 see the three prevotes for X and precommit it.
    lab.deliver(&ALL4, &[0, 1], is_vote(VoteType::Prevote, 0));
    // Validators 2 and 3 see three prevotes but not three for X; they time out and precommit nil.
    lab.deliver(&[0, 3], &[2], is_vote(VoteType::Prevote, 0));
    lab.deliver(&[0, 2], &[3], is_vote(VoteType::Prevote, 0));
    lab.fire(2, TimerKind::Prevote);
    lab.fire(3, TimerKind::Prevote);
    assert_eq!((lab.locked(0), lab.locked(1), lab.locked(2), lab.locked(3)), (Some((0, x)), Some((0, x)), None, None));
    lab.deliver(&ALL4, &ALL4, is_vote(VoteType::Precommit, 0));
    assert!(ALL4.iter().all(|i| lab.commits[*i].is_empty()), "two precommits each way: no quorum");
    // The network heals. Everybody learns the prevotes; the round ends by timeout.
    lab.settle_all();
    lab.fire_all(&ALL4, TimerKind::Precommit);
    assert!(ALL4.iter().all(|i| lab.round(*i) == 1));
    // The round-1 proposer holds X as its valid block and re-proposes it with pol = 0.
    lab.settle_all();
    let again = lab.outbox.iter().find_map(|(_, m)| match m {
        Message::Proposal(p) if p.round == 1 => Some((p.block.id(), p.pol, p.proposer, p.block.header.builder, p.block.header.round)),
        _ => None,
    });
    assert_eq!(again, Some((x, Some(0), key(1), key(0), 0)), "same block, new proposer, the builder stays");
    assert!(ALL4.iter().all(|i| lab.commits[*i] == vec![(1, x, 1)]));
    assert!(ALL4.iter().all(|i| lab.locked(*i).is_none()));
}

/// A lock on a block that cannot be committed is released by the lock rule
/// (proposal with `pol = vr ≥ locked_round` and a quorum of prevotes in `vr`).
#[test]
fn p5_a_lock_on_a_dead_block_is_released_by_a_later_proof_of_lock() {
    let mut lab = Lab::new(&EQUAL4);
    lab.tx_all(1);
    let x = lab.proposed(1, 0).unwrap().id();
    lab.deliver(&[0], &[1, 2], is_proposal);
    lab.fire(3, TimerKind::Propose);
    // Only validator 0 sees the quorum of prevotes for X: it alone locks.
    lab.deliver(&ALL4, &[0], is_vote(VoteType::Prevote, 0));
    lab.deliver(&[0, 3], &[1], is_vote(VoteType::Prevote, 0));
    lab.deliver(&[0, 3], &[2], is_vote(VoteType::Prevote, 0));
    lab.deliver(&[0, 1], &[3], is_vote(VoteType::Prevote, 0));
    lab.fire_all(&[1, 2, 3], TimerKind::Prevote);
    assert_eq!(lab.locked(0), Some((0, x)));
    lab.deliver(&ALL4, &ALL4, is_vote(VoteType::Precommit, 0));
    lab.fire_all(&ALL4, TimerKind::Precommit);
    // Round 1: validator 1 never saw the quorum for X and proposes a new block Y.
    let y = lab.proposed(1, 1).unwrap().id();
    assert_ne!(x, y);
    lab.deliver(&[1], &ALL4, is_proposal);
    assert_eq!(lab.votes_of(0, VoteType::Prevote, 1, 1)[0].block, None, "locked on X: prevotes nil for Y");
    // Validator 0 reaches the precommit step of round 1 before it sees the quorum for Y.
    lab.deliver(&[1, 2], &[0], is_vote(VoteType::Prevote, 1));
    lab.fire(0, TimerKind::Prevote);
    lab.deliver(&ALL4, &ALL4, is_vote(VoteType::Prevote, 1));
    assert_eq!(lab.locked(0), Some((0, x)), "still locked on X");
    assert_eq!(lab.nodes[0].machine.valid(), Some((1, y)), "but Y is now its valid block");
    assert!([1, 2, 3].iter().all(|i| lab.locked(*i) == Some((1, y))));
    // The precommits for Y are lost; each validator sees three precommits without a quorum for Y.
    lab.deliver(&[0, 2], &[1], is_vote(VoteType::Precommit, 1));
    lab.deliver(&[0, 1], &[2], is_vote(VoteType::Precommit, 1));
    lab.deliver(&[0, 1], &[3], is_vote(VoteType::Precommit, 1));
    lab.deliver(&[1, 2], &[0], is_vote(VoteType::Precommit, 1));
    lab.fire_all(&ALL4, TimerKind::Precommit);
    assert!(ALL4.iter().all(|i| lab.round(*i) == 2 && lab.commits[*i].is_empty()));
    // Round 2: validator 2 re-proposes Y with pol = 1. Validator 0's lock (round 0) is older: released.
    lab.deliver(&[2], &[0], in_round(2));
    assert_eq!(lab.votes_of(0, VoteType::Prevote, 1, 2)[0].block, Some(y), "the only way a lock is released");
    lab.settle_all();
    assert!(ALL4.iter().all(|i| lab.committed(*i, 1) == Some(y)));
}

// ------------------------------------------------------------- restarts --

fn locked_then_restart(with_state: bool) -> (Lab, BlockId) {
    let mut lab = Lab::new(&EQUAL4);
    lab.tx_all(1);
    let x = lab.proposed(1, 0).unwrap().id();
    lab.deliver(&[0], &[1, 2], is_proposal);
    lab.fire(3, TimerKind::Propose);
    lab.deliver(&ALL4, &[1], is_vote(VoteType::Prevote, 0));
    assert_eq!(lab.locked(1), Some((0, x)));
    lab.input(1, NodeInput::Restart { with_state });
    (lab, x)
}

#[test]
fn restart_with_persisted_state_keeps_the_lock_and_never_signs_twice() {
    let (mut lab, x) = locked_then_restart(true);
    assert_eq!(lab.locked(1), Some((0, x)));
    assert_eq!(lab.nodes[1].machine.valid(), Some((0, x)));
    assert_eq!((lab.round(1), lab.step(1)), (0, Step::Precommit), "resumes where the journal says it was");
    // Journaled votes are sent again, byte for byte (I1).
    for kind in [VoteType::Prevote, VoteType::Precommit] {
        let sent = lab.votes_of(1, kind, 1, 0);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], sent[1]);
    }
    // The others precommit nil; round 1 belongs to validator 1, which re-proposes its locked block.
    lab.deliver(&[0, 3], &[2], is_vote(VoteType::Prevote, 0));
    lab.deliver(&[2, 3], &[0], is_vote(VoteType::Prevote, 0));
    lab.deliver(&[0, 2], &[3], is_vote(VoteType::Prevote, 0));
    lab.fire_all(&[0, 2, 3], TimerKind::Prevote);
    lab.deliver(&[0, 2, 3], &[1], is_vote(VoteType::Precommit, 0));
    assert!(lab.fire(1, TimerKind::Precommit));
    let p = lab.outbox.iter().find_map(|(_, m)| match m {
        Message::Proposal(p) if p.round == 1 => Some((p.block.id(), p.pol)),
        _ => None,
    });
    assert_eq!(p, Some((x, Some(0))));
    // A second restart in round 1 does not go back to round 0 and does not propose anything else.
    lab.input(1, NodeInput::Restart { with_state: true });
    assert_eq!(lab.round(1), 1);
    let proposals: Vec<BlockId> = lab.outbox.iter().filter_map(|(s, m)| match m {
        Message::Proposal(p) if *s == 1 && p.round == 1 => Some(p.block.id()),
        _ => None,
    }).collect();
    assert_eq!(proposals, vec![x, x]);
}

/// "Must be shown unsafe": without the journal an honest validator signs a
/// second, different prevote for the same slot — self-inflicted slashable evidence —
/// and has forgotten its lock.
#[test]
fn restart_without_persisted_state_double_signs_and_forgets_the_lock() {
    let (mut lab, x) = locked_then_restart(false);
    assert_eq!(lab.locked(1), None, "the lock is gone");
    assert!(lab.fire(1, TimerKind::Propose));
    let prevotes = lab.votes_of(1, VoteType::Prevote, 1, 0);
    assert_eq!((prevotes[0].block, prevotes[1].block), (Some(x), None));
    let ev = Evidence::from_votes(&prevotes[0], &prevotes[1]).expect("a provable duplicate vote");
    // That evidence is valid on chain and costs the validator its whole stake (§4.3).
    lab.deliver(&ALL4, &[0], |_| true);
    assert!(lab.evidence.contains(&ev), "a peer that sees both builds the evidence itself (§4.2)");
}

// --------------------------------------------- equivocation (finding F1) --

/// One equivocating validator shows validator 0 a prevote for X and the others
/// nil. Validator 0 locks on X. The others must be able to learn that quorum
/// when the conflicting vote reaches them — a tally that keeps only the first
/// vote per validator would leave validator 0 locked for ever.
#[test]
fn an_equivocators_votes_count_for_each_value_and_yield_evidence() {
    let mut lab = Lab::new(&EQUAL4);
    let chain = lab.chain_id();
    let fee = lab.nodes[0].ledger.params.base_fee;
    lab.tx(&[0, 1, 2], transfer(1, fee));
    let x = lab.proposed(1, 0).unwrap().id();
    lab.deliver(&[0], &[1], is_proposal);
    lab.fire(2, TimerKind::Propose); // validator 2 prevotes nil
    let for_x = vote_msg(3, &chain, VoteType::Prevote, 1, 0, Some(x));
    let for_nil = vote_msg(3, &chain, VoteType::Prevote, 1, 0, None);
    lab.input(0, for_x.clone());
    lab.deliver(&[1], &[0], is_vote(VoteType::Prevote, 0));
    assert_eq!(lab.locked(0), Some((0, x)), "0 + 1 + the equivocator: a quorum for X");
    lab.input(1, for_nil);
    lab.deliver(&[0, 2], &[1], is_vote(VoteType::Prevote, 0));
    assert_eq!(lab.locked(1), None, "validator 1 holds X, X, nil, nil: no quorum yet");
    assert!(lab.evidence.is_empty());
    // Gossip brings the equivocator's other vote.
    lab.input(1, for_x);
    assert_eq!(lab.evidence.len(), 1, "duplicate vote: evidence");
    assert_eq!(lab.evidence[0].offender(), key(3));
    assert_eq!(lab.locked(1), Some((0, x)), "and the vote still counts for X: validator 1 sees the same quorum");
    // A further value for a block nobody proposed is evidence but is not stored.
    let before = lab.nodes[1].machine.messages().len();
    lab.input(1, vote_msg(3, &chain, VoteType::Prevote, 1, 0, Some(BlockId([0xee; 32]))));
    assert_eq!(lab.nodes[1].machine.messages().len(), before);
    // Validator 2 learns the same quorum the same way, and the block commits.
    lab.settle(&[0, 1, 2]);
    lab.input(2, vote_msg(3, &chain, VoteType::Prevote, 1, 0, Some(x)));
    lab.settle(&[0, 1, 2]);
    assert!([0, 1, 2].iter().all(|i| lab.committed(*i, 1) == Some(x)));
    // The evidence is pending work (§3.4 rule 1): the next block carries it and the equivocator is slashed.
    lab.advance(1_000);
    lab.settle(&[0, 1, 2]);
    let fx = &lab.nodes[0].chain[1].effects;
    assert_eq!(fx.slashes.len(), 1);
    assert_eq!((fx.slashes[0].key, fx.slashes[0].cut_bond), (key(3), 1_000_000 * XRGE));
    assert!(!lab.nodes[0].ledger.active_set.contains(key(3)));
}

// ------------------------------------------------------------ catching up --

#[test]
fn catch_up_commits_from_block_and_certificate_and_signs_nothing_for_old_heights() {
    let mut lab = Lab::new(&EQUAL4);
    let fee = lab.nodes[0].ledger.params.base_fee;
    for h in 1..=2u64 {
        lab.tx(&[0, 1, 2], transfer(h, fee));
        lab.settle(&[0, 1, 2]);
        lab.fire_all(&[0, 1, 2], TimerKind::CommitWait);
        lab.settle(&[0, 1, 2]);
    }
    assert_eq!(lab.nodes[0].ledger.height, 2);
    let c1 = lab.nodes[0].chain[0].clone();
    let c2 = lab.nodes[0].chain[1].clone();
    // Out of order: ignored. A certificate below quorum, or for another round than signed: ignored.
    lab.input(3, NodeInput::CatchUp { block: c2.block.clone(), cert: c2.cert.clone() });
    let mut thin = c1.cert.clone();
    thin.sigs.truncate(2);
    lab.input(3, NodeInput::CatchUp { block: c1.block.clone(), cert: thin });
    let mut wrong_round = c1.cert.clone();
    wrong_round.round = 5;
    lab.input(3, NodeInput::CatchUp { block: c1.block.clone(), cert: wrong_round });
    assert!(lab.commits[3].is_empty());
    // In order, with valid certificates: committed without taking part in any round.
    lab.input(3, NodeInput::CatchUp { block: c1.block.clone(), cert: c1.cert.clone() });
    lab.input(3, NodeInput::CatchUp { block: c2.block.clone(), cert: c2.cert.clone() });
    assert_eq!(lab.commits[3], vec![(1, c1.block.id(), 0), (2, c2.block.id(), 0)]);
    assert_eq!(lab.nodes[3].ledger.state_hash(), lab.nodes[0].ledger.state_hash());
    assert!(lab.outbox.iter().all(|(s, _)| *s != 3), "never signs for a height that is already committed");
    // Old messages for those heights are inert.
    lab.deliver(&[0, 1, 2], &[3], |_| true);
    assert!(lab.outbox.iter().all(|(s, _)| *s != 3));
    assert_eq!(lab.nodes[3].machine.height(), 3);
}

// ------------------------------- today's stake distribution (≈ 99.98 %) --

const TODAY: [Weight; 3] = [100_090_000, 10_000, 9_000];

/// What the protocol gives with one key above two thirds: that key decides alone.
#[test]
fn today_the_large_validator_commits_alone() {
    let mut lab = Lab::new(&TODAY);
    let fee = lab.nodes[0].ledger.params.base_fee;
    assert_eq!(lab.nodes[0].ledger.active_set.quorum(), 66_739_334);
    lab.tx(&[0], transfer(1, fee));
    assert_eq!(lab.commits[0].len(), 1, "its own prevote and precommit are a quorum: no message from anyone is needed");
    // The two small validators can neither stop it nor fork it, whatever they sign.
    let chain = lab.chain_id();
    let fake = BlockId([0x66; 32]);
    for i in [1, 2] {
        for kind in [VoteType::Prevote, VoteType::Precommit] {
            for j in [1, 2] {
                lab.input(j, vote_msg(i, &chain, kind, 1, 0, Some(fake)));
            }
        }
    }
    assert!(lab.commits[1].is_empty() && lab.commits[2].is_empty(), "19,000 of 100,109,000 commits nothing");
    lab.settle_all();
    let id = lab.commits[0][0].1;
    assert!(lab.committed(1, 1) == Some(id) && lab.committed(2, 1) == Some(id));
}

/// What the protocol does NOT give today: liveness depends entirely on that one validator.
#[test]
fn today_liveness_depends_entirely_on_the_large_validator() {
    let mut lab = Lab::new(&TODAY);
    let fee = lab.nodes[0].ledger.params.base_fee;
    lab.tx(&[1, 2], transfer(1, fee)); // the large validator is offline
    // It is the proposer of round 0 — and of every round the others could ever reach.
    let mut proposers = lab.nodes[1].ledger.next_proposers();
    assert!((0..2_000).all(|r| proposers.get(r) == Some(key(0))));
    lab.fire_all(&[1, 2], TimerKind::Propose);
    lab.settle(&[1, 2]);
    // Two nil prevotes are 0.019 % of the stake: no quorum of prevotes, so not even a timeout starts.
    assert!([1, 2].iter().all(|i| lab.step(*i) == Step::Prevote && lab.round(*i) == 0));
    assert!(lab.timers[1].iter().all(|t| t.0 != TimerKind::Prevote) && lab.timers[2].iter().all(|t| t.0 != TimerKind::Prevote));
    assert!(lab.commits.iter().all(|c| c.is_empty()), "no block, in any number of rounds: a halt, never a fork");
}

/// Nor safety against it: a key above two thirds can commit two blocks at one
/// height. Both small validators are honest and still end on different blocks.
/// The double-signing is provable (P3) — which helps only if someone can act on it.
#[test]
fn today_safety_depends_entirely_on_the_large_validator() {
    let mut lab = Lab::new(&TODAY);
    let chain = lab.chain_id();
    let l = lab.nodes[0].ledger.clone();
    let block = |id| Arc::new(l.build_block(key(0), 0, l.tip_time + 2_000, None, vec![transfer(id, l.params.base_fee)], vec![]));
    let (a, b) = (block(1), block(2));
    let mut pool = Vec::new();
    for (victim, blk) in [(1usize, &a), (2usize, &b)] {
        lab.input(victim, NodeInput::Message(Message::Proposal(Proposal::sign(&sk(0), &chain, 1, 0, None, blk.clone()))));
        for kind in [VoteType::Prevote, VoteType::Precommit] {
            let v = Vote::sign(&sk(0), &chain, kind, 1, 0, Some(blk.id()));
            pool.push(v);
            lab.input(victim, NodeInput::Message(Message::Vote(v)));
        }
    }
    assert_eq!(lab.committed(1, 1), Some(a.id()));
    assert_eq!(lab.committed(2, 1), Some(b.id()));
    let accused = duplicate_voters(pool.iter());
    let set = &l.active_set;
    let weight: Weight = accused.keys().map(|(_, k)| set.weight(*k)).sum();
    assert!(weight >= 2 * set.quorum() - set.total(), "evidence covers at least 2q − T");
    assert_eq!(accused.keys().map(|(_, k)| *k).collect::<Vec<_>>(), vec![key(0)]);
}
