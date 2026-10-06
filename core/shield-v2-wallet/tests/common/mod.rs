//! Shared by the integration tests: a stand-in for the node made of the stage-1 crate's `Pool`
//! (the consensus rules of spec §4 as pure logic) and a listing in the JSON shape of the node's
//! `GET /api/shield-v2/notes`. The real node is exercised by the daemon's
//! `node::shield_v2_wallet_interop_tests`.
#![allow(dead_code)]

use quantum_vault_shield_v2::pool::{MemoryPoolStore, Pool, PoolState, PoolTx, TxKind as PoolKind};
use quantum_vault_shield_v2_wallet::body::{Body, TxKind, OFF_KEM, OFF_NOTE};
use quantum_vault_shield_v2_wallet::{ListingPage, ShieldedKeys, StateReport, TxContext, WalletState};
use sha2::{Digest as _, Sha256};

pub const Q: u64 = 1_000_000_000;
pub const CHAIN: &str = "rougechain-devnet-1";
/// Activation height of the stand-in chain.
pub const A: u64 = 3;

pub const PHRASE_1: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
pub const PHRASE_2: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

pub fn keys(phrase: &str) -> ShieldedKeys {
    ShieldedKeys::from_phrase(phrase, "").unwrap()
}

/// 1,952 arbitrary bytes standing in for an ML-DSA-65 public key (only its SHA-256 enters a body).
pub fn fake_account_key(tag: u8) -> Vec<u8> {
    (0..1_952u32).map(|i| (i as u8).wrapping_mul(29).wrapping_add(tag)).collect()
}

pub fn pool_tx(body: &[u8]) -> PoolTx {
    let b = Body::decode(body).expect("a body the wallet built");
    PoolTx {
        kind: match b.kind {
            TxKind::Shield => PoolKind::Shield,
            TxKind::Transfer => PoolKind::Transfer,
            TxKind::Unshield => PoolKind::Unshield,
        },
        anchor: b.anchor,
        nf: b.nf,
        cm_out: b.cm_out,
        v_in: b.v_in,
        v_out: b.v_out,
        fee: b.fee,
        account: b.account,
    }
}

/// One transaction as the node lists it: at `height`, `index` in its block, its outputs at the
/// leaf positions `first_leaf` and `first_leaf + 1`.
pub fn listing_entry(body: &[u8], height: u64, index: u64, first_leaf: u64) -> serde_json::Value {
    let out = |j: usize| {
        serde_json::json!({
            "cm_out": hex::encode(&body[138 + 32 * j..170 + 32 * j]),
            "leaf": first_leaf + j as u64,
            "kem_ct": hex::encode(&body[OFF_KEM[j]..OFF_KEM[j] + 1088]),
            "note_ct": hex::encode(&body[OFF_NOTE[j]..OFF_NOTE[j] + 56]),
        })
    };
    serde_json::json!({
        "height": height, "index": index, "tx_hash": hex::encode(Sha256::digest(body)),
        "tx_type": Body::decode(body).unwrap().kind.tx_type(),
        "nf1": hex::encode(&body[74..106]), "nf2": hex::encode(&body[106..138]),
        "outputs": [out(0), out(1)],
    })
}

/// The stand-in chain: the pool, and one listing entry per accepted transaction.
pub struct Chain {
    pub pool: Pool<MemoryPoolStore>,
    pub height: u64,
    listed: Vec<serde_json::Value>,
}

impl Chain {
    pub fn new() -> Self {
        Self { pool: Pool::open_or_init(MemoryPoolStore::new(), A).unwrap(), height: A - 1, listed: Vec::new() }
    }

    pub fn state(&self) -> PoolState {
        self.pool.state().unwrap()
    }

    /// What a wallet reads from `/api/shield-v2/stats` before building: the latest anchor, and an
    /// expiry inside the anchor's validity.
    pub fn ctx(&self) -> TxContext {
        TxContext { chain_id: CHAIN.to_string(), anchor: self.state().tree_root, anchor_height: self.height, expiry_height: self.height + 100 }
    }

    /// What the node `node_id` reports for its tip (`report` of `/api/shield-v2/stats`): the
    /// height and BOTH halves of the pool state, from the stage-1 `Pool` itself.
    pub fn report(&self, node_id: &str) -> StateReport {
        let s = self.state();
        StateReport {
            node_id: node_id.to_string(),
            height: self.height,
            tree_root: s.tree_root,
            nullifier_acc: s.nullifier_acc,
            note_count: s.note_count,
            nullifier_count: s.nullifier_count,
        }
    }

    /// What two independent nodes report for the tip.
    pub fn state_reports(&self) -> Vec<StateReport> {
        vec![self.report("node-a"), self.report("node-b")]
    }

    /// Empty blocks until the chain's height is `height`.
    pub fn advance_to(&mut self, height: u64) {
        while self.height < height {
            self.block(&[]).unwrap();
        }
    }

    /// Applies one block with these bodies through the pool rules (spec §4) and lists them.
    pub fn block(&mut self, bodies: &[&[u8]]) -> Result<(), String> {
        let h = self.height + 1;
        let txs: Vec<PoolTx> = bodies.iter().map(|b| pool_tx(b)).collect();
        let first = self.state().note_count;
        self.pool.apply_block(h, &txs).map_err(|e| format!("{e:?}"))?;
        for (i, body) in bodies.iter().enumerate() {
            self.listed.push(listing_entry(body, h, i as u64, first + 2 * i as u64));
        }
        self.height = h;
        Ok(())
    }

    /// The listing page a node answers for `since` (all blocks up to the tip).
    pub fn page(&self, since: u64) -> ListingPage {
        ListingPage::from_json(&self.page_value(since, self.height).to_string()).unwrap()
    }

    /// The JSON of the page for `since` as a node whose tip is `until` answers it (the chain as
    /// it was at that height): what a test edits to make a node lie, and what gives the true
    /// state of a wallet at an earlier height.
    pub fn page_value(&self, since: u64, until: u64) -> serde_json::Value {
        let start = since.max(A);
        let until = until.min(self.height);
        let txs: Vec<&serde_json::Value> = self.listed.iter().filter(|t| (start..=until).contains(&t["height"].as_u64().unwrap())).collect();
        serde_json::json!({
            "active": true, "tip_height": until, "from_height": start,
            "next_height": (until + 1).max(start), "txs": txs,
        })
    }

    /// `true` when this nullifier is in the pool's nullifier set.
    pub fn is_spent(&self, nf: &[u8; 32]) -> bool {
        self.pool.is_spent(nf).unwrap()
    }
}

/// The state check of a wallet that has scanned to the tip against two nodes that agree
/// (`WalletState::confirm_state`, default quorum): every note of the state becomes confirmed.
pub fn confirm(chain: &Chain, state: &mut WalletState) {
    assert_eq!(state.next_height(), chain.height + 1, "confirm() is for a state scanned to the tip");
    let report = state.confirm_state(&chain.state_reports(), None).unwrap();
    assert_eq!(report.matched_height, Some(chain.height));
    assert!(!report.diverged);
    assert_eq!(state.nullifier_acc(), chain.state().nullifier_acc, "the wallet's nullifier hash is the pool's");
}
