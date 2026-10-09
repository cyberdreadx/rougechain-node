// ============================================================================
// shield_v2_store — persistent state of the shielded pool V2
// (docs/SHIELDED_POOL_V2_SPEC.md §4.1): the nullifier set (with its insertion
// order), the leaves of the append-only commitment tree, and one opaque
// metadata record the daemon encodes (pool total, frontier, anchor window,
// bookkeeping heights).
//
// This store knows nothing about the pool's rules: it is bytes behind an
// atomic, append-only, rollback-able interface. The rules live in the
// `quantum-vault-shield-v2` crate; the daemon implements that crate's
// `PoolStore` trait on top of this type. Keeping the proof library out of
// this crate keeps it out of every other dependant of the storage crate.
//
// Atomicity: every write is ONE `sled::Tree::apply_batch`, so a commit (or a
// rollback) is all or nothing. Append-only: a nullifier, once stored, is never
// removed (spec §4.2 rule 3) except by `restore` to a snapshot taken BEFORE the
// block that inserted it (rule 5) — the rollback primitive the daemon uses when
// a block is rejected after its speculative apply. Because the store is
// append-only, a snapshot is just the two counters plus the metadata record,
// not a dump of the (ever-growing) set.
//
// Key layout (one tree, key prefixes):
//   "m"             → the daemon's metadata record (opaque bytes)
//   "c"             → counters: nullifier_count (u64 BE) ‖ leaf_count (u64 BE)
//   "n" ‖ nf(32)    → insertion index (u64 BE)          — the nullifier SET
//   "l" ‖ idx(8 BE) → nf(32)                            — the nullifier LOG (insertion order)
//   "t" ‖ pos(8 BE) → leaf(32)                          — the commitment tree's leaves
//   "h" ‖ height(8) → first_leaf(8 BE) ‖ leaf_count_after(8 BE) — per-block leaf range (wallet scan)
//   "x"             → NODE-LOCAL side record (opaque bytes; the daemon keeps its running
//                     ciphertext hash here). Written in the SAME batch as "m", rolled back by
//                     the same snapshot / restore, cleared by `clear`. It is NOT part of the
//                     metadata record and therefore not of anything the state root reads.
//   "r"             → NODE-LOCAL record of the last ACCEPTED block's report (opaque bytes),
//                     written by the daemon only after a block was stored on its chain.
// ============================================================================

use std::path::Path;

const K_META: &[u8] = b"m";
const K_COUNTERS: &[u8] = b"c";
const K_SIDE: &[u8] = b"x";
const K_ACCEPTED: &[u8] = b"r";
const P_NF_SET: u8 = b'n';
const P_NF_LOG: u8 = b'l';
const P_LEAF: u8 = b't';
const P_HEIGHT: u8 = b'h';

/// Everything needed to roll the store back to the moment the snapshot was taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldV2Snapshot {
    meta: Option<Vec<u8>>,
    nullifier_count: u64,
    leaf_count: u64,
    /// Heights that had a per-block record at snapshot time are kept; later ones are removed.
    max_height_record: Option<u64>,
    /// The node-local side record and accepted-report record as they were.
    side: Option<Vec<u8>>,
    accepted: Option<Vec<u8>>,
}

#[derive(Clone)]
pub struct ShieldV2Store {
    tree: sled::Tree,
}

fn key(prefix: u8, suffix: &[u8]) -> Vec<u8> {
    let mut k = Vec::with_capacity(1 + suffix.len());
    k.push(prefix);
    k.extend_from_slice(suffix);
    k
}

fn u64_at(v: &[u8], at: usize) -> Result<u64, String> {
    let s = v.get(at..at + 8).ok_or("shield-v2 store: short integer")?;
    Ok(u64::from_be_bytes(s.try_into().map_err(|_| "shield-v2 store: bad integer")?))
}

fn bytes32(v: &[u8]) -> Result<[u8; 32], String> {
    v.try_into().map_err(|_| "shield-v2 store: value is not 32 bytes".to_string())
}

impl ShieldV2Store {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("shield-v2-db");
        let db = sled::open(&path).map_err(|e| format!("Failed to open shield-v2 store: {}", e))?;
        let tree = db.open_tree("pool").map_err(|e| format!("Failed to open shield-v2 pool tree: {}", e))?;
        Ok(Self { tree })
    }

    /// Every sled tree this store writes to.
    pub fn trees(&self) -> Vec<&sled::Tree> {
        vec![&self.tree]
    }

    /// The daemon's metadata record, `None` until the first commit.
    pub fn meta(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(self.tree.get(K_META).map_err(|e| e.to_string())?.map(|v| v.to_vec()))
    }

    /// The node-local side record (see the key layout), `None` if never written. Not consensus.
    pub fn side(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(self.tree.get(K_SIDE).map_err(|e| e.to_string())?.map(|v| v.to_vec()))
    }

    /// Overwrites the node-local side record outside a block commit (the daemon's one-time
    /// rebuild of it from the stored blocks). Not consensus.
    pub fn put_side(&self, side: &[u8]) -> Result<(), String> {
        self.tree.insert(K_SIDE, side).map_err(|e| format!("shield-v2 store: side record: {}", e))?;
        self.tree.flush().map_err(|e| format!("shield-v2 store: flush: {}", e))?;
        Ok(())
    }

    /// The node-local record of the last accepted block's report, `None` if never written.
    pub fn accepted(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(self.tree.get(K_ACCEPTED).map_err(|e| e.to_string())?.map(|v| v.to_vec()))
    }

    /// Records the report of the last ACCEPTED block (the daemon calls this after the block was
    /// stored on its chain, never during a speculative apply). Not consensus.
    pub fn put_accepted(&self, record: &[u8]) -> Result<(), String> {
        self.tree.insert(K_ACCEPTED, record).map_err(|e| format!("shield-v2 store: accepted record: {}", e))?;
        self.tree.flush().map_err(|e| format!("shield-v2 store: flush: {}", e))?;
        Ok(())
    }

    fn counters(&self) -> Result<(u64, u64), String> {
        match self.tree.get(K_COUNTERS).map_err(|e| e.to_string())? {
            Some(v) => Ok((u64_at(&v, 0)?, u64_at(&v, 8)?)),
            None => Ok((0, 0)),
        }
    }

    /// Number of nullifiers ever inserted (= length of the insertion log).
    pub fn nullifier_count(&self) -> Result<u64, String> {
        Ok(self.counters()?.0)
    }

    /// Number of leaves written (= the tree's `note_count`).
    pub fn leaf_count(&self) -> Result<u64, String> {
        Ok(self.counters()?.1)
    }

    pub fn contains_nullifier(&self, nf: &[u8; 32]) -> Result<bool, String> {
        self.tree.contains_key(key(P_NF_SET, nf)).map_err(|e| e.to_string())
    }

    /// Nullifiers in insertion order, from index `from`, at most `limit`.
    pub fn nullifiers_from(&self, from: u64, limit: usize) -> Result<Vec<[u8; 32]>, String> {
        let mut out = Vec::new();
        let start = key(P_NF_LOG, &from.to_be_bytes());
        for item in self.tree.range(start..key(P_NF_LOG + 1, &[])).take(limit) {
            let (_, v) = item.map_err(|e| e.to_string())?;
            out.push(bytes32(&v)?);
        }
        Ok(out)
    }

    pub fn leaf(&self, position: u64) -> Result<Option<[u8; 32]>, String> {
        match self.tree.get(key(P_LEAF, &position.to_be_bytes())).map_err(|e| e.to_string())? {
            Some(v) => Ok(Some(bytes32(&v)?)),
            None => Ok(None),
        }
    }

    /// Leaves by position, from `from`, at most `limit`.
    pub fn leaves_from(&self, from: u64, limit: usize) -> Result<Vec<[u8; 32]>, String> {
        let mut out = Vec::new();
        let start = key(P_LEAF, &from.to_be_bytes());
        for item in self.tree.range(start..key(P_LEAF + 1, &[])).take(limit) {
            let (_, v) = item.map_err(|e| e.to_string())?;
            out.push(bytes32(&v)?);
        }
        Ok(out)
    }

    /// `(first_leaf, leaf_count_after)` of the block applied at `height`, if recorded.
    pub fn block_leaf_range(&self, height: u64) -> Result<Option<(u64, u64)>, String> {
        match self.tree.get(key(P_HEIGHT, &height.to_be_bytes())).map_err(|e| e.to_string())? {
            Some(v) => Ok(Some((u64_at(&v, 0)?, u64_at(&v, 8)?))),
            None => Ok(None),
        }
    }

    fn max_height_record(&self) -> Result<Option<u64>, String> {
        match self.tree.range(key(P_HEIGHT, &[])..key(P_HEIGHT + 1, &[])).next_back() {
            Some(item) => {
                let (k, _) = item.map_err(|e| e.to_string())?;
                Ok(Some(u64_at(&k, 1)?))
            }
            None => Ok(None),
        }
    }

    /// Store one applied block atomically: the new metadata record, the nullifiers it inserts (in
    /// order, appended to the log), the leaves it appends (which must start exactly at the current
    /// leaf count) and, when `height` is given, the block's leaf range. Refused — with nothing
    /// written — if a nullifier is already stored or repeated, or the leaves do not continue the
    /// tree.
    pub fn commit(
        &self,
        height: Option<u64>,
        meta: &[u8],
        nullifiers: &[[u8; 32]],
        first_leaf: u64,
        leaves: &[[u8; 32]],
    ) -> Result<(), String> {
        self.commit_with_side(height, meta, nullifiers, first_leaf, leaves, None)
    }

    /// [`ShieldV2Store::commit`] that also writes the node-local side record in the same atomic
    /// batch (`None`: the side record is left as it is).
    pub fn commit_with_side(
        &self,
        height: Option<u64>,
        meta: &[u8],
        nullifiers: &[[u8; 32]],
        first_leaf: u64,
        leaves: &[[u8; 32]],
        side: Option<&[u8]>,
    ) -> Result<(), String> {
        let (mut nf_count, leaf_count) = self.counters()?;
        if first_leaf != leaf_count {
            return Err(format!("shield-v2 store: leaves start at {} but the tree has {} leaves", first_leaf, leaf_count));
        }
        let mut batch = sled::Batch::default();
        let mut seen: std::collections::HashSet<&[u8; 32]> = std::collections::HashSet::new();
        for nf in nullifiers {
            if !seen.insert(nf) || self.contains_nullifier(nf)? {
                return Err("shield-v2 store: nullifier already stored".to_string());
            }
            batch.insert(key(P_NF_SET, nf), &nf_count.to_be_bytes()[..]);
            batch.insert(key(P_NF_LOG, &nf_count.to_be_bytes()), &nf[..]);
            nf_count = nf_count.checked_add(1).ok_or("shield-v2 store: nullifier count overflow")?;
        }
        let mut pos = first_leaf;
        for leaf in leaves {
            batch.insert(key(P_LEAF, &pos.to_be_bytes()), &leaf[..]);
            pos = pos.checked_add(1).ok_or("shield-v2 store: leaf position overflow")?;
        }
        if let Some(h) = height {
            let mut v = Vec::with_capacity(16);
            v.extend_from_slice(&first_leaf.to_be_bytes());
            v.extend_from_slice(&pos.to_be_bytes());
            batch.insert(key(P_HEIGHT, &h.to_be_bytes()), v);
        }
        let mut c = Vec::with_capacity(16);
        c.extend_from_slice(&nf_count.to_be_bytes());
        c.extend_from_slice(&pos.to_be_bytes());
        batch.insert(K_COUNTERS, c);
        batch.insert(K_META, meta);
        if let Some(side) = side {
            batch.insert(K_SIDE, side);
        }
        self.tree.apply_batch(batch).map_err(|e| format!("shield-v2 store: commit: {}", e))?;
        self.tree.flush().map_err(|e| format!("shield-v2 store: flush: {}", e))?;
        Ok(())
    }

    /// The rollback point: the metadata record and the two counters. O(1).
    pub fn snapshot(&self) -> Result<ShieldV2Snapshot, String> {
        let (nullifier_count, leaf_count) = self.counters()?;
        Ok(ShieldV2Snapshot {
            meta: self.meta()?,
            nullifier_count,
            leaf_count,
            max_height_record: self.max_height_record()?,
            side: self.side()?,
            accepted: self.accepted()?,
        })
    }

    /// Undo everything committed since `snap` was taken, atomically: nullifiers with an insertion
    /// index at or above the snapshot's count leave the set and the log, leaves at or above its
    /// leaf count are removed, later per-block records are removed, and the metadata record is
    /// put back (removed if it did not exist). Afterwards the store holds exactly what it held at
    /// the snapshot.
    pub fn restore(&self, snap: &ShieldV2Snapshot) -> Result<(), String> {
        let (nf_count, leaf_count) = self.counters()?;
        let mut batch = sled::Batch::default();
        for idx in snap.nullifier_count..nf_count {
            if let Some(nf) = self.tree.get(key(P_NF_LOG, &idx.to_be_bytes())).map_err(|e| e.to_string())? {
                batch.remove(key(P_NF_SET, &nf));
            }
            batch.remove(key(P_NF_LOG, &idx.to_be_bytes()));
        }
        for pos in snap.leaf_count..leaf_count {
            batch.remove(key(P_LEAF, &pos.to_be_bytes()));
        }
        // per-block records after the snapshot's newest one (a range scan from there, not a walk
        // over every record since activation)
        let from = snap.max_height_record.map_or(0, |m| m.saturating_add(1));
        for item in self.tree.range(key(P_HEIGHT, &from.to_be_bytes())..key(P_HEIGHT + 1, &[])) {
            let (k, _) = item.map_err(|e| e.to_string())?;
            batch.remove(k.to_vec());
        }
        match &snap.meta {
            Some(m) => batch.insert(K_META, m.as_slice()),
            None => batch.remove(K_META),
        }
        for (k, v) in [(K_SIDE, &snap.side), (K_ACCEPTED, &snap.accepted)] {
            match v {
                Some(v) => batch.insert(k, v.as_slice()),
                None => batch.remove(k),
            }
        }
        if snap.meta.is_none() && snap.nullifier_count == 0 && snap.leaf_count == 0 {
            batch.remove(K_COUNTERS);
        } else {
            let mut c = Vec::with_capacity(16);
            c.extend_from_slice(&snap.nullifier_count.to_be_bytes());
            c.extend_from_slice(&snap.leaf_count.to_be_bytes());
            batch.insert(K_COUNTERS, c);
        }
        self.tree.apply_batch(batch).map_err(|e| format!("shield-v2 store: restore: {}", e))?;
        self.tree.flush().map_err(|e| format!("shield-v2 store: flush: {}", e))?;
        Ok(())
    }

    /// Remove everything (deterministic recovery re-imports the chain from genesis).
    pub fn clear(&self) -> Result<(), String> {
        self.tree.clear().map_err(|e| format!("shield-v2 store: clear: {}", e))?;
        self.tree.flush().map_err(|e| format!("shield-v2 store: flush: {}", e))?;
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.tree.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (std::path::PathBuf, ShieldV2Store) {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("shield-v2-store-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let s = ShieldV2Store::new(&dir).unwrap();
        (dir, s)
    }

    fn b(x: u8) -> [u8; 32] {
        [x; 32]
    }

    #[test]
    fn commit_is_append_only_and_atomic() {
        let (dir, s) = store();
        assert!(s.is_empty());
        assert_eq!(s.meta().unwrap(), None);
        assert_eq!((s.nullifier_count().unwrap(), s.leaf_count().unwrap()), (0, 0));
        s.commit(Some(10), b"meta-10", &[b(1), b(2)], 0, &[b(0xa), b(0xb)]).unwrap();
        assert_eq!(s.meta().unwrap(), Some(b"meta-10".to_vec()));
        assert_eq!((s.nullifier_count().unwrap(), s.leaf_count().unwrap()), (2, 2));
        assert!(s.contains_nullifier(&b(1)).unwrap() && s.contains_nullifier(&b(2)).unwrap());
        assert!(!s.contains_nullifier(&b(3)).unwrap());
        assert_eq!(s.leaf(0).unwrap(), Some(b(0xa)));
        assert_eq!(s.leaf(1).unwrap(), Some(b(0xb)));
        assert_eq!(s.leaf(2).unwrap(), None);
        assert_eq!(s.block_leaf_range(10).unwrap(), Some((0, 2)));
        // a repeated nullifier refuses the whole commit, nothing written
        let before = s.snapshot().unwrap();
        assert!(s.commit(Some(11), b"meta-11", &[b(3), b(1)], 2, &[b(0xc), b(0xd)]).is_err());
        assert_eq!(s.snapshot().unwrap(), before);
        assert!(!s.contains_nullifier(&b(3)).unwrap());
        assert_eq!(s.leaf(2).unwrap(), None);
        // a repeat inside one commit, too
        assert!(s.commit(Some(11), b"meta-11", &[b(3), b(3)], 2, &[]).is_err());
        // leaves must continue the tree
        assert!(s.commit(Some(11), b"meta-11", &[], 3, &[b(0xc)]).is_err());
        assert!(s.commit(Some(11), b"meta-11", &[], 1, &[b(0xc)]).is_err());
        // an empty block still advances the metadata
        s.commit(Some(11), b"meta-11", &[], 2, &[]).unwrap();
        assert_eq!(s.meta().unwrap(), Some(b"meta-11".to_vec()));
        assert_eq!(s.block_leaf_range(11).unwrap(), Some((2, 2)));
        assert_eq!(s.nullifiers_from(0, 10).unwrap(), vec![b(1), b(2)]);
        assert_eq!(s.nullifiers_from(1, 10).unwrap(), vec![b(2)]);
        assert_eq!(s.leaves_from(0, 1).unwrap(), vec![b(0xa)]);
        assert_eq!(s.leaves_from(1, 10).unwrap(), vec![b(0xb)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_undoes_exactly_the_blocks_after_the_snapshot() {
        let (dir, s) = store();
        let empty = s.snapshot().unwrap();
        s.commit(Some(5), b"m5", &[b(1), b(2)], 0, &[b(0xa), b(0xb)]).unwrap();
        let after5 = s.snapshot().unwrap();
        s.commit(Some(6), b"m6", &[b(3), b(4)], 2, &[b(0xc), b(0xd)]).unwrap();
        s.commit(Some(7), b"m7", &[b(5), b(6), b(7), b(8)], 4, &[b(0xe), b(0xf), b(0x10), b(0x11)]).unwrap();
        assert_eq!((s.nullifier_count().unwrap(), s.leaf_count().unwrap()), (8, 8));
        s.restore(&after5).unwrap();
        assert_eq!(s.snapshot().unwrap(), after5);
        assert_eq!(s.meta().unwrap(), Some(b"m5".to_vec()));
        assert_eq!((s.nullifier_count().unwrap(), s.leaf_count().unwrap()), (2, 2));
        for x in 3..=8 { assert!(!s.contains_nullifier(&b(x)).unwrap(), "nf {x} removed"); }
        assert!(s.contains_nullifier(&b(1)).unwrap() && s.contains_nullifier(&b(2)).unwrap());
        for p in 2..8 { assert_eq!(s.leaf(p).unwrap(), None, "leaf {p} removed"); }
        assert_eq!(s.block_leaf_range(6).unwrap(), None);
        assert_eq!(s.block_leaf_range(7).unwrap(), None);
        assert_eq!(s.block_leaf_range(5).unwrap(), Some((0, 2)));
        assert_eq!(s.nullifiers_from(0, 10).unwrap(), vec![b(1), b(2)]);
        // the undone nullifiers can be inserted again (a reorg's other fork)
        s.commit(Some(6), b"m6b", &[b(3)], 2, &[b(0x20), b(0x21)]).unwrap();
        assert_eq!((s.nullifier_count().unwrap(), s.leaf_count().unwrap()), (3, 4));
        // the node-local records: written with a commit or on their own, rolled back with it
        let before = s.snapshot().unwrap();
        assert_eq!((s.side().unwrap(), s.accepted().unwrap()), (None, None));
        s.commit_with_side(Some(7), b"m7c", &[], 4, &[b(0x30)], Some(b"side-7")).unwrap();
        s.put_accepted(b"accepted-7").unwrap();
        assert_eq!((s.side().unwrap(), s.accepted().unwrap()), (Some(b"side-7".to_vec()), Some(b"accepted-7".to_vec())));
        let with_side = s.snapshot().unwrap();
        s.commit(Some(8), b"m8", &[], 5, &[]).unwrap();
        assert_eq!(s.side().unwrap(), Some(b"side-7".to_vec()), "a commit without a side record leaves it");
        s.commit_with_side(Some(9), b"m9", &[], 5, &[], Some(b"side-9")).unwrap();
        s.put_accepted(b"accepted-9").unwrap();
        s.restore(&with_side).unwrap();
        assert_eq!(s.snapshot().unwrap(), with_side);
        assert_eq!((s.side().unwrap(), s.accepted().unwrap()), (Some(b"side-7".to_vec()), Some(b"accepted-7".to_vec())));
        s.restore(&before).unwrap();
        assert_eq!((s.side().unwrap(), s.accepted().unwrap()), (None, None));
        assert_eq!(s.snapshot().unwrap(), before);
        // back to nothing
        s.restore(&empty).unwrap();
        assert!(s.is_empty(), "restore to the pre-init snapshot leaves an empty tree");
        assert_eq!(s.snapshot().unwrap(), empty);
        let _ = std::fs::remove_dir_all(dir);
    }
}
