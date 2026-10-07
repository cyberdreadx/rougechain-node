//! **The client loop of `NOTES.md` §6, as code** (REVIEW_WALLET_5, condition 1).
//!
//! `NOTES.md` §6 and spec §5.5 state the loop as an algorithm; this module is that algorithm,
//! decision for decision, and it is the ONLY place in the test suite where a decision of the
//! loop is taken: the property test's client (`tests/settlement_properties.rs`, `World::round`)
//! and the loop tests of `tests/review_wallet_5.rs` ([`LoopClient`]) both call [`Session`]. A
//! change of the loop is a change here and in the two documents, nowhere else.
//!
//! **After REVIEW_WALLET_6** (RW6-1 … RW6-3) the loop also keeps which node served which
//! heights ([`Session::served`]) — a refuted listing bans the listing node only for heights it
//! served, and a contradiction of what was confirmed earlier blames nobody; it does not pin a
//! node on a fault; and it knows the answer "the pool is not active" ([`Session::inactive`],
//! [`Stop::PoolInactive`]). The loop tests of `tests/review_wallet_6.rs` (through their own
//! driver, which calls [`Session`] method by method) and of `tests/review_wallet_6_resolution.rs`
//! run it too.
//!
//! **After REVIEW_WALLET_6B** (RW6B-2, RW6B-3 and its recommendation): an answer that is not a
//! listing page (`ListingPage::is_page`) is no answer — a strike, never a ban; a `listing:`
//! error and `leaf_mismatch` ban only when the unconfirmed part of the state is the listing
//! node's own ([`Session::unconfirmed_tail_is_listing_nodes`]), and otherwise rescan and blame
//! nobody; and such rescans are capped ([`BLAMELESS_IN_A_ROW`], [`BLAMELESS_PER_TENURE`]):
//! at the cap the node is left, without a ban. After REVIEW_WALLET_6C: step 3 has a rule for
//! an error of `confirm_state` ([`Session::after_confirm_error`]) and the per-tenure cap is 3.
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
/// `P`: the pages [`LoopClient`] reads per round. `P ≥ 1` is the client's choice (`NOTES.md` §6);
/// the property test's client uses 6 (`settlement_properties.rs`, `PAGES_PER_ROUND`).
pub const LOOP_CLIENT_PAGES: usize = 4;
/// `K`: consecutive rounds a listing node may fail to deliver before it is left.
pub const STRIKES: u32 = 3;
/// `W`: rounds the FIRST state check of a state without an embargo base waits for a report from
/// every configured node for one height (`UI_CONTRACT.md`, obligation 2).
pub const FIRST_CHECK_ROUNDS: u32 = 5;
/// `R_c`: blameless rescans IN A ROW on one listing node — no round between them that ended with
/// the tip confirmed — after which that node is left, without a ban (REVIEW_WALLET_6B).
pub const BLAMELESS_IN_A_ROW: u32 = 2;
/// `R_t`: blameless rescans in one TENURE of a listing node (the counts start again when the
/// listing node changes, and with a new session), however many confirmed tips lie between
/// them, after which that node is left, without a ban: a node that lists the truth after every
/// blameless rescan and gives the next occasion for one is not listed from for ever. Equal to
/// `K` (REVIEW_WALLET_6C, section 5: "6 is acceptable, 3 is better").
pub const BLAMELESS_PER_TENURE: u32 = 3;
/// The name [`BLAMELESS_PER_TENURE`] had (`tests/review_wallet_6c.rs` uses it).
pub const BLAMELESS_IN_A_SESSION: u32 = BLAMELESS_PER_TENURE;
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
    /// rescan, no new state. **The fault does not pin the node it happened on** (REVIEW_WALLET_6
    /// RW6-2): when the loop stops for it, `Session::listing` is already the NEXT node and
    /// `Session::origin` is `None` — the client stores "start at `listing`, `listed_from`
    /// unknown", and the next session is [`Session::new_unattributed`].
    Fault(String),
    /// A strict majority of the configured nodes answer that the shielded pool is not active
    /// (REVIEW_WALLET_6 RW6-3). Not a failure and nobody's fault: shown to the user as "the
    /// shielded pool is not active on this network". Nothing is banned for it, nothing is
    /// rescanned, the state is untouched. The loop idles: a new session, or
    /// [`Session::recheck_pool`] after a long interval, asks again.
    PoolInactive,
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
    /// The state holds no page at all (nothing was ever scanned into it): whatever it holds
    /// from here on was listed in this session.
    pub empty: bool,
}

/// Heights `from ..= to` of the state came from pages `node` served (REVIEW_WALLET_6 RW6-1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Served {
    pub node: usize,
    pub from: u64,
    pub to: u64,
}

/// The session of `NOTES.md` §6: everything the loop keeps in memory. Lost in a crash and at
/// the end of the application; `listing` is ALSO stored with the state (`listed_from`).
#[derive(Clone, Debug)]
pub struct Session {
    /// `L`: the node listed from — every page the state holds above its confirmed height came
    /// from this node. The index is the node's place in the configured set as the core keeps
    /// it (`WalletState::nodes()`: canonical ids, sorted).
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
    /// `served`: which node served which heights of the state, for every page applied in this
    /// session since the state was last empty (a rescan). Ascending, disjoint. A refutation
    /// bans `L` only for heights that are `L`'s here (RW6-1).
    pub served: Vec<Served>,
    /// The state was empty at some point of this session (a rescan, or a state nothing had
    /// been scanned into): from then on EVERY height it holds is in `served`.
    pub from_empty: bool,
    /// The stored `listed_from` this session started with: the node every page that the STORED
    /// state held above its confirmed height came from. `None`: not known (a state stored
    /// after a fault, or by a client that did not store it) — no height that this session did
    /// not list itself is anybody's then.
    pub origin: Option<usize>,
    /// `inactive`: the nodes whose LATEST answer — a listing page, or the `active` field of
    /// `/api/shield-v2/stats` — says that the shielded pool is not active (RW6-3).
    pub inactive: BTreeSet<usize>,
    /// Nodes whose state report showed a pool that holds something (`note_count` or
    /// `nullifier_count` above 0) in this session.
    pub pool_seen: BTreeSet<usize>,
    /// `L` answered "the pool is not active" in step 1 of THIS round; step 2 decides.
    pub said_inactive: bool,
    /// The highest confirmed height of the state this session has seen (in a call that is
    /// handed the state). `None`: nothing confirmed, or not seen yet.
    pub confirmed_seen: Option<u64>,
    /// The state may hold heights ABOVE its confirmed height that no page of this session
    /// listed (what the stored state held at the start). They are `origin`'s. Cleared when the
    /// session sees the state with everything confirmed, and by a rescan.
    pub unrecorded_tail: bool,
    /// Rescans for which nobody was blamed while `L` has been the listing node: in a row (no
    /// round in between that ended with the tip confirmed), and in this session.
    pub blameless_in_a_row: u32,
    pub blameless_on_l: u32,
    /// The LEAVE that is about to be planned must rescan whatever the state holds (it ends a
    /// run of blameless rescans: the state in hand is the one that was to be thrown away).
    pub leave_rescans: bool,
}

impl Session {
    /// The start of a session: `bad` empty, the listing node the one the state was stored with.
    pub fn new(nodes: usize, listed_from: usize) -> Self {
        Self {
            listing: listed_from,
            nodes,
            bad: BTreeSet::new(),
            strikes: 0,
            prev: None,
            waited: 0,
            unanswered: false,
            reports: Vec::new(),
            round: 0,
            stopped: None,
            served: Vec::new(),
            from_empty: false,
            origin: Some(listed_from),
            inactive: BTreeSet::new(),
            pool_seen: BTreeSet::new(),
            said_inactive: false,
            confirmed_seen: None,
            unrecorded_tail: true,
            blameless_in_a_row: 0,
            blameless_on_l: 0,
            leave_rescans: false,
        }
    }

    /// The start of a session whose stored state has no known `listed_from` — after
    /// `STOP(fault)`, which stores "start at the next node, `listed_from` unknown" — listing
    /// from `start`. The state is kept as it is (no rescan at the start: after a fault the
    /// stored state is not touched); what it holds above its confirmed height is nobody's: if
    /// it is refuted, the state is rescanned and no node is banned.
    pub fn new_unattributed(nodes: usize, start: usize) -> Self {
        Self { origin: None, ..Self::new(nodes, start) }
    }

    /// The quorum of the configured set: a strict majority, at least 2 (as the core's).
    pub fn quorum(&self) -> usize {
        (self.nodes / 2 + 1).max(2)
    }

    /// The first node after `L`, in the order of the configured set, cyclically, not in `bad`.
    fn next_node(&self) -> Option<usize> {
        (1..self.nodes).map(|k| (self.listing + k) % self.nodes).find(|i| !self.bad.contains(i))
    }

    /// A page of `L` was applied: its heights are `L`'s.
    fn serve(&mut self, page: &ListingPage) {
        if page.next_height <= page.from_height {
            return; // no height in it
        }
        // A page that does not continue what is recorded was applied to a state that had been
        // emptied without this session being told (a recovered state, another writer's
        // rescan): what is recorded is of a state that is gone.
        if self.served.last().is_some_and(|last| page.from_height <= last.to) {
            self.emptied();
        }
        // the first page into an empty state decides where the listing starts (the jump to the
        // activation height): what it skipped is that node's word too
        let from = if self.served.is_empty() && self.from_empty { 0 } else { page.from_height };
        let to = page.next_height - 1;
        match self.served.last_mut() {
            Some(last) if last.node == self.listing && last.to.checked_add(1) == Some(from) => last.to = to,
            _ => self.served.push(Served { node: self.listing, from, to }),
        }
    }

    /// `true`: every height of `from ..= to` that the state holds was listed by `L` — by a page
    /// of this session (`served`), or, for a height no page of this session covers, because
    /// the session started on `L` with the stored `listed_from` and has not left it.
    pub fn listed_by_listing_node(&self, from: u64, to: u64) -> bool {
        let l = self.listing;
        let stored_is_ls = !self.from_empty && self.origin == Some(l);
        let mut cursor = from; // the first height not attributed yet
        for s in &self.served {
            if s.to < cursor {
                continue;
            }
            if s.from > to {
                break;
            }
            if (s.from > cursor && !stored_is_ls) || s.node != l {
                return false;
            }
            if s.to >= to {
                return true;
            }
            cursor = s.to + 1;
        }
        stored_is_ls
    }

    /// The state is empty again (`rescan_state`, or nothing was ever scanned into it).
    fn emptied(&mut self) {
        self.served.clear();
        self.from_empty = true;
        self.unrecorded_tail = false;
        self.confirmed_seen = None;
    }

    /// A call that is handed the state: what the session learns from it.
    fn see(&mut self, state: &WalletState) {
        self.confirmed_seen = self.confirmed_seen.max(state.confirmed_height());
        if Self::nothing_unconfirmed(state) {
            self.unrecorded_tail = false;
        }
    }

    /// `true`: every height the state holds ABOVE its confirmed height was listed by `L`
    /// (REVIEW_WALLET_6B RW6B-3) — the pages of this session above the confirmed height are
    /// all `L`'s, and what the stored state held at the start, if any of it is still
    /// unconfirmed, is `L`'s by the stored `listed_from`. A page of `L` that does not continue
    /// such a state — a `listing:` error, leaf numbers below the wallet's tree — contradicts
    /// `L`'s own listing, or the chain a quorum confirmed: evidence. When it is `false` the
    /// page may be true and the tail another node's: no evidence against `L`.
    pub fn unconfirmed_tail_is_listing_nodes(&self) -> bool {
        let l = self.listing;
        (!self.unrecorded_tail || self.origin == Some(l)) && self.served.iter().all(|s| s.node == l || self.confirmed_seen.is_some_and(|c| s.to <= c))
    }

    /// The state is to be rescanned and nobody is blamed for it. **Capped** (REVIEW_WALLET_6B):
    /// after [`BLAMELESS_IN_A_ROW`] of them without a round that ended with the tip confirmed,
    /// or [`BLAMELESS_PER_TENURE`] of them in this tenure of the listing node, the node is
    /// LEFT instead — without a ban, with the rescan — so that no node can keep a client
    /// rescanning for as long as it is listed from.
    fn blameless_rescan(&mut self) -> Decision {
        self.blameless_in_a_row += 1;
        self.blameless_on_l += 1;
        if self.blameless_in_a_row >= BLAMELESS_IN_A_ROW || self.blameless_on_l >= BLAMELESS_PER_TENURE {
            self.leave_rescans = true;
            return Decision::Leave { ban: false, why: "rescans that blamed nobody" };
        }
        Decision::Rescan
    }

    /// Step 0: a round begins. `false`: the loop has stopped — nothing is asked, nothing written.
    pub fn begin_round(&mut self) -> bool {
        if self.stopped.is_some() {
            return false;
        }
        self.round += 1;
        self.unanswered = false;
        self.said_inactive = false;
        true
    }

    /// `true` when everything the state holds is confirmed (or it holds nothing): such a state
    /// is nobody's word, and the listing node can change without a rescan.
    pub fn nothing_unconfirmed(state: &WalletState) -> bool {
        state.scanned_height() == state.confirmed_height()
    }

    /// Step 1, the answer to one `scan`.
    pub fn after_scan(&mut self, page: &ListingPage, result: &Result<ScanReport, WalletError>) -> Decision {
        match result {
            Err(e) => self.after_scan_error(e),
            // "the pool is not active on this node" (RW6-3): not a short page, not evidence.
            // No more pages are asked for in this round; step 2 — where every node is asked —
            // decides what it means (`after_inactive_page`)
            Ok(r) if !page.active || !r.pool_active => {
                self.said_inactive = true;
                Decision::Go
            }
            Ok(r) => {
                self.inactive.remove(&self.listing);
                // (judged before the page joins `served`: is what it was applied ON `L`'s?)
                let own_tail = self.unconfirmed_tail_is_listing_nodes();
                self.serve(page);
                if r.leaf_mismatch && !own_tail {
                    // numbered below a tail that another node listed (RW6B-3): not evidence
                    self.blameless_rescan()
                } else if r.leaf_mismatch {
                    Decision::Leave { ban: true, why: "leaf_mismatch" }
                } else if !r.at_tip && page.next_height.saturating_sub(page.from_height) < PAGE_BLOCKS {
                    // neither at the node's tip nor the heights that were asked for
                    Decision::Leave { ban: true, why: "a short page" }
                } else {
                    Decision::Go
                }
            }
        }
    }

    /// Step 1, `scan` (or `ListingPage::from_json`: the body `L` answered with is not a page the
    /// core reads — on the WebAssembly surface that is the same call and the same `listing:`)
    /// refused.
    pub fn after_scan_error(&mut self, e: &WalletError) -> Decision {
        match e {
            // the body is not a listing page at all (REVIEW_WALLET_6B RW6B-2: nothing, a proxy's
            // error page, the node's own `{ "success": false, … }` — `ListingPage::is_page`):
            // NO ANSWER. A strike; never a ban
            e if e.is_not_a_page() => self.after_no_answer(),
            // the page is the node's, and it is not a chain's listing — EVERY way the content
            // of a page can be invalid is this error (REVIEW_WALLET_6 RW6-2). Evidence against
            // `L` — unless the state holds an unconfirmed tail that `L` did not list
            // (RW6B-3: after a fault): then the page may be the truth and the tail the lie;
            // the state is rescanned, nobody is blamed, and from there every page is `L`'s
            WalletError::Listing(_) if !self.unconfirmed_tail_is_listing_nodes() => self.blameless_rescan(),
            WalletError::Listing(_) => Decision::Leave { ban: true, why: "a listing: error" },
            // the client's own worker overflowed its log: nobody lied
            WalletError::RescanRequired => Decision::Rescan,
            WalletError::StaleState => Decision::Reload,
            // `state_invariant:` and everything else (the caller's key, the caller's state, a
            // fault): stop and report, keep the state. No page causes any of them; should one
            // ever do, the node it came from is not where the next session starts (RW6-2):
            // `L` moves on, and what the stored state holds is no node's from here
            e => {
                if let Some(next) = self.next_node() {
                    self.listing = next;
                }
                self.origin = None;
                Decision::Stop(Stop::Fault(e.to_string()))
            }
        }
    }

    /// Step 2, when `L` answered `"active": false` in step 1 — its chain has no activation
    /// height for the pool (`core/daemon/src/node.rs`, `shield_v2_notes_since`); `scan` changed
    /// nothing. Decided here, after this round's stats answers and reports are in
    /// (`after_stats`, `note_reports`):
    ///
    /// * **A node that contradicts itself is banned**: the same node's state report showed a
    ///   pool that holds notes or nullifiers in this session (this round included). A node has a pool record
    ///   with something in it only on a chain where the pool was activated, and such a node
    ///   lists `"active": true`: the page and the report cannot both be true.
    /// * Otherwise the node joins `inactive`. **A strict majority of the configured nodes
    ///   inactive: the pool is not active on this network** — the loop idles
    ///   ([`Stop::PoolInactive`]); no ban, no rescan.
    /// * A minority: the node is behind the network (an outdated build, another chain's
    ///   configuration) or lies. It is LEFT at once, not banned — and it does not come before
    ///   the others for it: the next node lists.
    fn after_inactive_page(&mut self) -> Decision {
        let l = self.listing;
        if self.pool_seen.contains(&l) {
            return Decision::Leave { ban: true, why: "not active, against its own state report" };
        }
        self.inactive.insert(l);
        if self.inactive.len() >= self.quorum() {
            return Decision::Stop(Stop::PoolInactive);
        }
        Decision::Leave { ban: false, why: "the pool is not active on this node" }
    }

    /// Step 2, optional input: what the `active` field of each node's `/api/shield-v2/stats`
    /// said in this round, as `(node, active)`. (`active: false` there also covers a chain
    /// whose activation height is set and not reached; the listing of such a node is an
    /// ordinary empty page at its tip.) A node that says `false` joins `inactive`, one that
    /// says `true` leaves it; with a strict majority of the configured nodes inactive the loop
    /// idles. A lying listing node cannot keep a wallet from learning that the pool is not
    /// active by serving pages of its own: every node is asked here.
    pub fn after_stats(&mut self, answers: &[(usize, bool)]) -> Decision {
        for &(node, active) in answers {
            if node >= self.nodes {
                continue;
            }
            if active {
                self.inactive.remove(&node);
            } else {
                self.inactive.insert(node);
            }
        }
        if self.inactive.len() >= self.quorum() {
            return Decision::Stop(Stop::PoolInactive);
        }
        Decision::Go
    }

    /// The idle loop asks again (the client's timer: a long interval — the pool is activated
    /// by a release, not by a block). `bad` is kept; what the nodes said before is forgotten.
    pub fn recheck_pool(&mut self) {
        if self.stopped == Some(Stop::PoolInactive) {
            self.stopped = None;
            self.inactive.clear();
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

    /// Step 2, before anything is decided on this round's answers: a configured node whose
    /// report shows a pool that holds something (`note_count` or `nullifier_count` above 0)
    /// cannot answer "not active" later (`after_inactive_page`). Called by
    /// [`Session::first_check_may_run`]; a client that takes [`Session::after_stats`] first
    /// calls it before.
    pub fn note_reports(&mut self, state: &WalletState, fresh: &[StateReport]) {
        self.see(state);
        for r in fresh.iter().filter(|r| r.note_count > 0 || r.nullifier_count > 0) {
            let id = quantum_vault_shield_v2_wallet::canonical_node_id(&r.node_id).ok();
            if let Some(i) = id.and_then(|id| state.nodes().iter().position(|n| *n == id)) {
                self.pool_seen.insert(i);
            }
        }
    }

    /// Step 2a: the FIRST state check of a state made by `new_state` without the user's
    /// statement fixes its embargo base, and a configured node that is missing from it costs
    /// 256 blocks. It is made only when every configured node has answered THIS round for one
    /// common height — or after `W` rounds of waiting.
    pub fn first_check_may_run(&mut self, state: &WalletState, fresh: &[StateReport]) -> Decision {
        self.note_reports(state, fresh);
        // (step 2, first) the listing node said "the pool is not active" in this round
        if self.said_inactive {
            return self.after_inactive_page();
        }
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
        // More configured nodes contradict the state than a lying minority can be: the state
        // is not the chain's. WHOSE pages are in doubt is what the core reports with it
        // (REVIEW_WALLET_6 RW6-1, `ConfirmReport::refuted`):
        // * a height ABOVE what was confirmed before, in heights `L` itself served since the
        //   state was last empty: `L` served a listing that is not a chain's — LEAVE(ban);
        // * anything else — a height at or below the confirmed height (an earlier quorum's
        //   word is contradicted; the pages down there may be any node's), or heights `L` did
        //   not serve: the state is rescanned, `L` stays, NOBODY is blamed.
        self.see(state);
        if c.listing_refuted {
            let ls = c.refuted.iter().any(|r| !r.confirmed && self.listed_by_listing_node(r.from_height, r.height));
            return if ls { Decision::Leave { ban: true, why: "listing_refuted" } } else { self.blameless_rescan() };
        }
        // a round that ends with the tip confirmed and no rescan ends a run of blameless rescans
        if c.quorum_tip.is_some_and(|tip| state.confirmed_height() >= Some(tip)) && Self::nothing_unconfirmed(state) {
            self.blameless_in_a_row = 0;
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

    /// Step 3, `confirm_state` refused (REVIEW_WALLET_6C RW6C-1: the step had no rule, and the
    /// reference unwrapped). Nothing a node sends causes it: a malformed report is "no report
    /// from that node" and the call succeeds. What remains is the client's own — more than
    /// 1,024 reports, an argument that is not an array (`request:`), a state that is not the
    /// stored one (`stale_state:` → reload) — or a fault (`state_invariant:`): STOP(fault), the
    /// state kept. The listing node is not moved on: it had no part in it.
    pub fn after_confirm_error(&mut self, e: &WalletError) -> Decision {
        match e {
            WalletError::StaleState => Decision::Reload,
            e => Decision::Stop(Stop::Fault(e.to_string())),
        }
    }

    /// Step 5: is a payment offered in this round?
    pub fn may_offer_payment(c: &ConfirmReport, at_tip: bool, state: &WalletState) -> bool {
        at_tip && c.matched_height.is_some() && state.confirmed_height() == state.scanned_height() && state.spend_status(c.quorum_tip).can_spend_now
    }

    /// `LEAVE(ban)`, planned: the next listing node and whether the state must be rescanned
    /// first. Nothing is changed — a client that cannot store the rescanned state has not left.
    ///
    /// * `ban`: `L` goes into `bad`. Only on evidence that L's listing is not a chain's (a
    ///   `listing:` error, `leaf_mismatch`, a short page, `listing_refuted` for heights `L`
    ///   served, "not active" against its own state report).
    /// * the next node: the first after `L`, in the order of the configured set, cyclically,
    ///   that is not in `bad`. None and `L` banned: the loop stops. None and `L` not banned:
    ///   `L` is the only node left and stays.
    /// * the state is rescanned whenever the listing node changes — unless everything it holds
    ///   is confirmed. So every unconfirmed page of a state is its CURRENT listing node's, and
    ///   the node that is banned is the node that lied.
    pub fn plan_leave(&self, ban: bool, state: &WalletState) -> Leave {
        let next = self.next_node();
        let empty = state.scanned_height().is_none();
        match next {
            // (the only node left, and it is to be left for its blameless rescans: it stays,
            // and the rescan is made)
            None if !ban && self.leave_rescans => Leave { next: Some(self.listing), rescan: true, ban, empty },
            Some(_) => Leave { next, rescan: ban || self.leave_rescans || !Self::nothing_unconfirmed(state), ban, empty },
            None if ban => Leave { next: None, rescan: true, ban, empty },
            None => Leave { next: Some(self.listing), rescan: false, ban, empty },
        }
    }

    /// `LEAVE`, done: the rescanned state (if any) and the new `listed_from` are stored.
    pub fn commit_leave(&mut self, plan: Leave) {
        if plan.ban {
            self.bad.insert(self.listing);
        }
        (self.strikes, self.prev) = (0, None);
        (self.blameless_in_a_row, self.blameless_on_l, self.leave_rescans) = (0, 0, false);
        if plan.rescan || plan.empty {
            self.emptied();
        } else {
            // handed on without a rescan: everything the state holds is confirmed
            self.unrecorded_tail = false;
        }
        match plan.next {
            Some(next) => self.listing = next,
            None => self.stopped = Some(Stop::NoHonestListingNode),
        }
    }

    /// `rescan_state` without a change of node (`rescan_required:`, a migration, the user).
    pub fn after_rescan(&mut self) {
        self.prev = None;
        self.emptied();
    }
}

/// A client that runs the loop on a state in memory: steps 1 to 4, storage that never fails.
/// For the loop tests of `tests/review_wallet_5.rs` and `tests/review_wallet_6_resolution.rs`.
/// `P` = [`LOOP_CLIENT_PAGES`].
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
        Self { s, session: Session::new(nodes, listed_from), pages_per_round: LOOP_CLIENT_PAGES, rescans: 0, left: Vec::new() }
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
    /// `reports()`: what the nodes answer to step 2. Every listing request is answered and no
    /// node says anything about the pool being active: see [`LoopClient::round_with`].
    pub fn round(&mut self, key: &ScanKey, page: &mut dyn FnMut(usize, u64) -> ListingPage, reports: &mut dyn FnMut() -> Vec<StateReport>) {
        self.round_with(key, &mut |node, since| Some(page(node, since)), &mut || Stats { reports: reports(), active: Vec::new() })
    }

    /// One round, with everything a node can answer: `page(node, since)` is `None` when the
    /// listing request is not answered (or the answer is not a page); `stats()` is what step 2
    /// collected — the reports, and what each node's `active` field said.
    pub fn round_with(&mut self, key: &ScanKey, page: &mut dyn FnMut(usize, u64) -> Option<ListingPage>, stats: &mut dyn FnMut() -> Stats) {
        if !self.session.begin_round() {
            return;
        }
        // 1. pages from L until its tip or the page budget
        let mut at_tip = false;
        for _ in 0..self.pages_per_round {
            let Some(p) = page(self.session.listing, self.s.next_height()) else {
                let d = self.session.after_no_answer();
                if !self.apply(d) {
                    return;
                }
                break; // "otherwise go to step 2"
            };
            let mut next = self.s.clone();
            let r = next.scan(&p, key);
            if r.is_ok() {
                self.s = next;
            }
            let d = self.session.after_scan(&p, &r);
            if !self.apply(d) {
                return;
            }
            if self.session.said_inactive {
                break; // "the pool is not active": nothing more to ask this node for
            }
            if r.is_ok_and(|r| r.at_tip) {
                at_tip = true;
                break;
            }
        }
        // 2. every node is asked; the reports of the last rounds
        let Stats { reports: fresh, active } = stats();
        self.session.note_reports(&self.s, &fresh);
        let idle = self.session.after_stats(&active);
        if !self.apply(idle) {
            return;
        }
        let wait = self.session.first_check_may_run(&self.s, &fresh);
        let handed_in = self.session.add_reports(fresh);
        if !self.apply(wait) {
            return;
        }
        // 3. confirm_state and its rules
        let c = match self.s.confirm_state(&handed_in) {
            Ok(c) => c,
            Err(e) => {
                let d = self.session.after_confirm_error(&e);
                self.apply(d);
                return;
            }
        };
        let d = self.session.after_confirm(&c, at_tip, &self.s);
        if !self.apply(d) {
            return;
        }
        // 4. resolve_pending
        self.s.resolve();
    }
}

/// What step 2 collected in one round.
pub struct Stats {
    /// the `report` objects, labelled with the configured origins
    pub reports: Vec<StateReport>,
    /// `(node, active)`: the `active` field of each answer of `/api/shield-v2/stats`
    pub active: Vec<(usize, bool)>,
}
