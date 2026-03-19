// ============================================================================
// State Root — SHA-256 Merkle tree of account balances
//
// Computes a deterministic state root from a map of (address → balance).
// Addresses are sorted lexicographically for determinism.
// The Merkle tree is built bottom-up from leaf hashes.
// ============================================================================

use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Compute the state root from a map of account balances.
///
/// leaf[i] = SHA-256("ROUGECHAIN_STATE_V1" || address_bytes || balance_le_bytes)
/// Leaves are sorted by address for determinism.
/// The Merkle root is built by repeatedly hashing pairs.
pub fn compute_state_root(balances: &HashMap<String, u64>) -> [u8; 32] {
    if balances.is_empty() {
        // Empty state = hash of empty string with domain separator
        let mut hasher = Sha256::new();
        hasher.update(b"ROUGECHAIN_STATE_V1_EMPTY");
        let result = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&result);
        return out;
    }

    // Sort addresses for deterministic ordering
    let mut entries: Vec<(&String, &u64)> = balances.iter().collect();
    entries.sort_by_key(|(addr, _)| *addr);

    // Compute leaf hashes
    let mut leaves: Vec<[u8; 32]> = entries
        .iter()
        .map(|(addr, balance)| {
            let mut hasher = Sha256::new();
            hasher.update(b"ROUGECHAIN_STATE_V1");
            hasher.update(addr.as_bytes());
            hasher.update(balance.to_le_bytes());
            let result = hasher.finalize();
            let mut out = [0u8; 32];
            out.copy_from_slice(&result);
            out
        })
        .collect();

    // Build Merkle tree bottom-up
    merkle_root(&mut leaves)
}

/// Compute the Merkle root from a list of leaf hashes.
/// Pads with zero-hashes if the count is not a power of 2.
fn merkle_root(leaves: &mut Vec<[u8; 32]>) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    if leaves.len() == 1 {
        return leaves[0];
    }

    // Pad to even count
    while leaves.len() % 2 != 0 {
        leaves.push([0u8; 32]);
    }

    // Hash pairs
    let mut next_level: Vec<[u8; 32]> = Vec::with_capacity(leaves.len() / 2);
    for chunk in leaves.chunks(2) {
        let mut hasher = Sha256::new();
        hasher.update(b"ROUGECHAIN_NODE_V1");
        hasher.update(chunk[0]);
        hasher.update(chunk[1]);
        let result = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&result);
        next_level.push(out);
    }

    merkle_root(&mut next_level)
}

/// Compute the state root after applying a set of balance changes.
///
/// This is used by the rollup accumulator to compute the post-batch state root.
pub fn apply_transfers_and_compute_root(
    balances: &mut HashMap<String, u64>,
    transfers: &[(String, String, u64, u64)], // (sender, receiver, amount, fee)
) -> [u8; 32] {
    for (sender, receiver, amount, fee) in transfers {
        let total_debit = amount + fee;
        let sender_bal = balances.entry(sender.clone()).or_insert(0);
        *sender_bal = sender_bal.saturating_sub(total_debit);

        let receiver_bal = balances.entry(receiver.clone()).or_insert(0);
        *receiver_bal += amount;
    }

    compute_state_root(balances)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_state_root() {
        let balances = HashMap::new();
        let root = compute_state_root(&balances);
        assert_ne!(root, [0u8; 32], "empty state root should not be all zeros");
    }

    #[test]
    fn test_state_root_deterministic() {
        let mut balances = HashMap::new();
        balances.insert("alice".to_string(), 1000);
        balances.insert("bob".to_string(), 500);

        let root1 = compute_state_root(&balances);
        let root2 = compute_state_root(&balances);
        assert_eq!(root1, root2, "same balances should produce same root");
    }

    #[test]
    fn test_state_root_changes_with_balance() {
        let mut balances = HashMap::new();
        balances.insert("alice".to_string(), 1000);
        let root1 = compute_state_root(&balances);

        balances.insert("alice".to_string(), 999);
        let root2 = compute_state_root(&balances);
        assert_ne!(root1, root2, "different balances should produce different roots");
    }

    #[test]
    fn test_apply_transfers() {
        let mut balances = HashMap::new();
        balances.insert("alice".to_string(), 1000);
        balances.insert("bob".to_string(), 500);

        let pre_root = compute_state_root(&balances);

        let transfers = vec![
            ("alice".to_string(), "bob".to_string(), 200u64, 10u64),
        ];
        let post_root = apply_transfers_and_compute_root(&mut balances, &transfers);

        assert_ne!(pre_root, post_root, "root should change after transfer");
        assert_eq!(*balances.get("alice").unwrap(), 790);
        assert_eq!(*balances.get("bob").unwrap(), 700);
    }

    #[test]
    fn test_single_account_root() {
        let mut balances = HashMap::new();
        balances.insert("solo".to_string(), 42);
        let root = compute_state_root(&balances);
        assert_ne!(root, [0u8; 32]);
    }
}
