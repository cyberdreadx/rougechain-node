//! **The client loop of `NOTES.md` §6, as code** (REVIEW_WALLET_5, condition 1).
//!
//! `NOTES.md` §6 and spec §5.5 state the loop as an algorithm; this module is that algorithm,
//! decision for decision, and it is the ONLY place in the test suite where a decision of the
//! loop is taken: the property test's client (`tests/settlement_properties.rs`, `World::round`)
//! and the loop tests of `tests/review_wallet_5.rs` ([`LoopClient`]) both call [`Session`]. A
//! change of the loop is a change here and in the two documents, nowhere else.
//!
//! It is not a network client: a page and a set of reports are handed in by the caller. What
//! it decides is everything the documents leave to no one's judgement — when a listing node is
//! left, when it is banned, when the state is rescanned, when the loop stops.

use std::collections::BTreeSet;

use quantum_vault_shield_v2_wallet::{ConfirmReport, ListingPage, ScanKey, ScanReport, SpendEmbargo, StateReport, WalletError, WalletState};

/// `B`: the blocks a client asks for per page (`blocks=64`). A node answers a page that either
/// reaches its tip or covers the heights asked for — 64 blocks hold at most 512 pool
/// transactions (`SHIELD_V2_MAX_TX_PER_BLOCK` = 8), the node's cap per page, so the cap never
/// cuts such a page short. A page that does neither is not an answer of the listing API.
pub const PAGE_BLOCKS: u64 = 64;
/// `K`: consecutive rounds a listing node may fail to deliver before it is left.
pub const STRIKES: u32 = 3;
/// `W`: rounds the FIRST state check of a state without an embargo base waits for a report from
/// every configured node for one height (`UI_CONTRACT.md`, obligation 2).
pub const FIRST_CHECK_ROUNDS: u32 = 5;
/// The reports of this many rounds are handed to `confirm_state`, at most [`MAX_REPORTS`].
pub const REPORT_ROUNDS: u64 = 3;
pub const MAX_REPORTS: usize = 1_024;

/// Why the loop stopped. It does not start again by itself: a new session, or the user's
/// explicit "try again" (which is a new session), is what clears `bad`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stop {
    /// Every configured node is in `bad`: each of them served a listing that is not a chain's.
    /// Shown to the user as "no honest listing node reachable". `bad` is NOT cleared.
    NoHonestListingNode,
    /// `state_invariant:` (or an error the loop has no other rule for) from a call: a bug in
    /// the wallet library or in the client. Reported; the stored state is kept as it is — no
    /// rescan, no new state.
    Fault(String),
}

/// What the loop does with the answer to one call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Go on with the round.
    Go,
    /// `LEAVE(ban)`: see [`Session::plan_leave`]. The round ends.
    Leave { ban: bool, why: &'static str },
    /// `rescan_state`, the same listing node, nobody blamed. The round ends.
    Rescan,
    /// The state in hand is not the stored one: load the stored state. The round ends.
    Reload,
    /// The round ends here and nothing else happens (the first state check is waiting).
    Wait,
    /// The loop stops.
    Stop(Stop),
}

/// What `LEAVE` does, computed before anything is written ([`Session::plan_leave`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leave {
    /// `L` after the change (`None`: every node is in `bad` — the loop stops).
    pub next: Option<usize>,
    /// The state must be replaced by `rescan_state(S)` before `L` changes.
    pub rescan: bool,
    pub ban: bool,
}

/// The session of `NOTES.md` §6: everything the loop keeps in memory. Lost in a crash and at
/// the end of the application; `listing` is ALSO stored with the state (`listed_from`).
#[derive(Clone, Debug)]
pub struct Session {
    /// `L`: the node listed from — every page the state holds above its confirmed height came
    /// from this node.
    pub listing: usize,
    /// `|N|`
    pub nodes: usize,
    /// Nodes whose listing was shown not to be a chain's, in this session.
    pub bad: BTreeSet<usize>,
    pub strikes: u32,
    /// `prev`: the scanned height at the end of the previous round on this listing node.
    pub prev: Option<Option<u64>>,
    /// Rounds the first state check has waited for every node.
    pub waited: u32,
    /// `L` left a listing request of THIS round unanswered: the round cannot clear its strikes.
    pub unanswered: bool,
    /// `R`: (round, report)
    pub reports: Vec<(u64, StateReport)>,
    pub round: u64,
    pub stopped: Option<Stop>,
}

impl Session {
    /// The start of a session: `bad` empty, the listing node the one the state was stored with.
    pub fn new(nodes: usize, listed_from: usize) -> Self {
        Self { listing: listed_from, nodes, bad: BTreeSet::new(), strikes: 0, prev: None, waited: 0, unanswered: false, reports: Vec::new(), round: 0, stopped: None }
    }

    /// Step 0: a round begins. `false`: the loop has stopped — nothing is asked, nothing written.
    pub fn begin_round(&mut self) -> bool {
        if self.stopped.is_some() {
            return false;
        }
        self.round += 1;
        self.unanswered = false;
        true
    }

    /// `true` when everything the state holds is confirmed (or it holds nothing): such a state
    /// is nobody's word, and the listing node can change without a rescan.
    pub fn nothing_unconfirmed(state: &WalletState) -> bool {
        state.scanned_height() == state.confirmed_height()
    }

    /// Step 1, the answer to one `scan`.
    pub fn after_scan(&self, page: &ListingPage, result: &Result<ScanReport, WalletError>) -> Decision {
        match result {
            // the page is the node's, and it is not a chain's listing
            Err(WalletError::Listing(_)) => Decision::Leave { ban: true, why: "a listing: error" },
            // the client's own worker overflowed its log: nobody lied
            Err(WalletError::RescanRequired) => Decision::Rescan,
            Err(WalletError::StaleState) => Decision::Reload,
            // `state_invariant:` and everything else: stop and report, keep the state
            Err(e) => Decision::Stop(Stop::Fault(e.to_string())),
            Ok(r) if r.leaf_mismatch => Decision::Leave { ban: true, why: "leaf_mismatch" },
            // neither at the node's tip nor the heights that were asked for
            Ok(r) if !r.at_tip && (!page.active || page.next_height.saturating_sub(page.from_height) < PAGE_BLOCKS) => Decision::Leave { ban: true, why: "a short page" },
            Ok(_) => Decision::Go,
        }
    }

    /// Step 1, no answer: the listing node did not answer the request, or answered something
    /// that is not a page. A strike — which no state check of this round takes back: a node
    /// that does not answer is not "delivering" because the state it was handed happens to be
    /// confirmed (a state the worker left view-only would otherwise wait for its one page with
    /// the full key for as long as the node stays silent). The round goes on with step 2.
    pub fn after_no_answer(&mut self) -> Decision {
        self.unanswered = true;
        self.strikes += 1;
        if self.strikes >= STRIKES {
            return Decision::Leave { ban: false, why: "no answer" };
        }
        Decision::Go
    }

    /// Step 2: this round's answers join `R`; what is handed to `confirm_state`.
    pub fn add_reports(&mut self, fresh: Vec<StateReport>) -> Vec<StateReport> {
        let now = self.round;
        self.reports.retain(|(round, _)| round + REPORT_ROUNDS > now);
        self.reports.extend(fresh.into_iter().map(|r| (now, r)));
        let excess = self.reports.len().saturating_sub(MAX_REPORTS);
        self.reports.drain(..excess);
        self.reports.iter().map(|(_, r)| r.clone()).collect()
    }

    /// Step 2a: the FIRST state check of a state made by `new_state` without the user's
    /// statement fixes its embargo base, and a configured node that is missing from it costs
    /// 256 blocks. It is made only when every configured node has answered THIS round for one
    /// common height — or after `W` rounds of waiting.
    pub fn first_check_may_run(&mut self, state: &WalletState, fresh: &[StateReport]) -> Decision {
        if state.spend_embargo() != SpendEmbargo::AwaitingBase || state.sole_copy_asserted() {
            return Decision::Go;
        }
        let nodes = state.nodes();
        let heights: BTreeSet<u64> = fresh.iter().map(|r| r.height).collect();
        let complete = heights.iter().any(|h| nodes.iter().all(|id| fresh.iter().any(|r| r.height == *h && quantum_vault_shield_v2_wallet::canonical_node_id(&r.node_id).ok().as_deref() == Some(id.as_str()))));
        if complete || self.waited >= FIRST_CHECK_ROUNDS {
            return Decision::Go;
        }
        self.waited += 1;
        Decision::Wait
    }

    /// Step 3, the answer to `confirm_state`. `state`: the state that call returned.
    pub fn after_confirm(&mut self, c: &ConfirmReport, at_tip: bool, state: &WalletState) -> Decision {
        if c.embargo_base_set || state.spend_embargo() != SpendEmbargo::AwaitingBase {
            self.waited = 0;
        }
        // more configured nodes contradict the state than a lying minority can be: the listing
        // is not the chain's, and every unconfirmed page of it came from L
        if c.listing_refuted {
            return Decision::Leave { ban: true, why: "listing_refuted" };
        }
        // without a quorum answering nothing is counted: the node is not what is missing
        let Some(tip) = c.quorum_tip else { return Decision::Go };
        let (scanned, confirmed) = (state.scanned_height(), state.confirmed_height());
        if !at_tip && scanned < Some(tip) {
            // catching up, at the speed the listing API guarantees (step 1): no verdict yet
            self.prev = Some(scanned);
            return Decision::Go;
        }
        // the node does not get the wallet to where the quorum is:
        let ahead = c.listing_ahead; //                 pool transactions in blocks the quorum does not have
        let short = at_tip && scanned < Some(tip); //   its tip is below the quorum's
        let unconfirmed = self.prev.is_some_and(|p| confirmed < p); // what it listed a round ago is still nobody's
        self.prev = Some(scanned);
        if ahead || short || unconfirmed {
            self.strikes += 1;
            if self.strikes >= STRIKES {
                return Decision::Leave { ban: false, why: if ahead { "listing_ahead" } else if short { "behind the quorum's tip" } else { "scanned stays above confirmed" } };
            }
        } else if !self.unanswered {
            self.strikes = 0;
        }
        Decision::Go
    }

    /// Step 5: is a payment offered in this round?
    pub fn may_offer_payment(c: &ConfirmReport, at_tip: bool, state: &WalletState) -> bool {
        at_tip && c.matched_height.is_some() && state.confirmed_height() == state.scanned_height() && state.spend_status(c.quorum_tip).can_spend_now
    }

    /// `LEAVE(ban)`, planned: the next listing node and whether the state must be rescanned
    /// first. Nothing is changed — a client that cannot store the rescanned state has not left.
    ///
    /// * `ban`: `L` goes into `bad`. Only on evidence that L's listing is not a chain's (a
    ///   `listing:` error, `leaf_mismatch`, a short page, `listing_refuted`).
    /// * the next node: the first after `L`, in the order of the configured set, cyclically,
    ///   that is not in `bad`. None and `L` banned: the loop stops. None and `L` not banned:
    ///   `L` is the only node left and stays.
    /// * the state is rescanned whenever the listing node changes — unless everything it holds
    ///   is confirmed. So every unconfirmed page of a state is its CURRENT listing node's, and
    ///   the node that is banned is the node that lied.
    pub fn plan_leave(&self, ban: bool, state: &WalletState) -> Leave {
        let next = (1..self.nodes).map(|k| (self.listing + k) % self.nodes).find(|i| !self.bad.contains(i));
        match next {
            Some(_) => Leave { next, rescan: ban || !Self::nothing_unconfirmed(state), ban },
            None if ban => Leave { next: None, rescan: true, ban },
            None => Leave { next: Some(self.listing), rescan: false, ban },
        }
    }

    /// `LEAVE`, done: the rescanned state (if any) and the new `listed_from` are stored.
    pub fn commit_leave(&mut self, plan: Leave) {
        if plan.ban {
            self.bad.insert(self.listing);
        }
        (self.strikes, self.prev) = (0, None);
        match plan.next {
            Some(next) => self.listing = next,
            None => self.stopped = Some(Stop::NoHonestListingNode),
        }
    }

    /// `rescan_state` without a change of node (`rescan_required:`, a migration, the user).
    pub fn after_rescan(&mut self) {
        self.prev = None;
    }
}

/// A client that runs the loop on a state in memory: steps 1 to 4, storage that never fails.
/// For the loop tests of `tests/review_wallet_5.rs`.
pub struct LoopClient {
    pub s: WalletState,
    pub session: Session,
    pub pages_per_round: usize,
    pub rescans: u32,
    /// (round, node, banned, why) of every `LEAVE`
    pub left: Vec<(u64, usize, bool, &'static str)>,
}

impl LoopClient {
    pub fn new(s: WalletState, listed_from: usize) -> Self {
        let nodes = s.nodes().len();
        Self { s, session: Session::new(nodes, listed_from), pages_per_round: 4, rescans: 0, left: Vec::new() }
    }

    fn leave(&mut self, ban: bool, why: &'static str) {
        let plan = self.session.plan_leave(ban, &self.s);
        if plan.rescan {
            self.s = self.s.fresh_for_rescan();
            self.rescans += 1;
        }
        self.left.push((self.session.round, self.session.listing, ban, why));
        self.session.commit_leave(plan);
    }

    /// `false`: the decision ended the round.
    fn apply(&mut self, d: Decision) -> bool {
        match d {
            Decision::Go => return true,
            Decision::Leave { ban, why } => self.leave(ban, why),
            Decision::Rescan => {
                self.s = self.s.fresh_for_rescan();
                self.rescans += 1;
                self.session.after_rescan();
            }
            Decision::Reload | Decision::Wait => {}
            Decision::Stop(stop) => self.session.stopped = Some(stop),
        }
        false
    }

    /// One round. `page(node, since)`: what that node answers to the listing request;
    /// `reports()`: what the nodes answer to step 2.
    pub fn round(&mut self, key: &ScanKey, page: &mut dyn FnMut(usize, u64) -> ListingPage, reports: &mut dyn FnMut() -> Vec<StateReport>) {
        if !self.session.begin_round() {
            return;
        }
        // 1. pages from L until its tip or the page budget
        let mut at_tip = false;
        for _ in 0..self.pages_per_round {
            let p = page(self.session.listing, self.s.next_height());
            let mut next = self.s.clone();
            let r = next.scan(&p, key);
            if r.is_ok() {
                self.s = next;
            }
            let d = self.session.after_scan(&p, &r);
            if !self.apply(d) {
                return;
            }
            if r.is_ok_and(|r| r.at_tip) {
                at_tip = true;
                break;
            }
        }
        // 2. every node is asked; the reports of the last rounds
        let fresh = reports();
        let wait = self.session.first_check_may_run(&self.s, &fresh);
        let handed_in = self.session.add_reports(fresh);
        if !self.apply(wait) {
            return;
        }
        // 3. confirm_state and its rules
        let c = self.s.confirm_state(&handed_in).unwrap();
        let d = self.session.after_confirm(&c, at_tip, &self.s);
        if !self.apply(d) {
            return;
        }
        // 4. resolve_pending
        self.s.resolve();
    }
}
