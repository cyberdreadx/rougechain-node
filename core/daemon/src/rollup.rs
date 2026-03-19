// ============================================================================
// Rollup Accumulator — Batches transactions and produces STARK proofs
//
// The RollupAccumulator collects pending transactions into batches.
// When a batch is full (or timeout expires), it:
//   1. Executes all transfers off-chain (dry run)
//   2. Computes the new state root
//   3. Generates a zk-STARK proof of the batch validity
//   4. Stores the batch result for inclusion in the next L1 block
// ============================================================================

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use serde::Serialize;

use quantum_vault_crypto::stark::{
    prove_rollup_batch, verify_rollup_batch,
    RollupTransfer, RollupBatchInputs,
};
use quantum_vault_storage::state_root::{compute_state_root, apply_transfers_and_compute_root};

/// Maximum number of transfers in a single rollup batch.
pub const MAX_BATCH_SIZE: usize = 32;

/// Maximum time to wait before flushing an incomplete batch.
pub const BATCH_TIMEOUT_SECS: u64 = 5;

// ============================================================================
// PENDING TRANSFER
// ============================================================================

/// A pending transfer waiting to be included in a rollup batch.
#[derive(Debug, Clone, Serialize)]
pub struct PendingTransfer {
    pub sender: String,
    pub receiver: String,
    pub amount: u64,
    pub fee: u64,
    pub timestamp: u64,
}

// ============================================================================
// BATCH RESULT
// ============================================================================

/// The result of processing a rollup batch.
#[derive(Debug, Clone, Serialize)]
pub struct RollupBatchResult {
    pub batch_id: u64,
    pub transfer_count: usize,
    pub total_fees: u64,
    pub pre_state_root: String,
    pub post_state_root: String,
    pub proof_size_bytes: usize,
    pub proof_time_ms: u128,
    pub verified: bool,
}

// ============================================================================
// ACCUMULATOR
// ============================================================================

/// The rollup accumulator collects transfers and produces batched proofs.
pub struct RollupAccumulator {
    /// Pending transfers waiting to be batched.
    pending: Vec<PendingTransfer>,
    /// Current batch ID counter.
    next_batch_id: u64,
    /// Time when the current batch started accumulating.
    batch_start: Option<Instant>,
    /// Completed batch results.
    pub completed_batches: Vec<RollupBatchResult>,
    /// Current state: map of address → balance (for state root computation).
    /// In production, this would be loaded from the chain state.
    state_balances: HashMap<String, u64>,
}

impl RollupAccumulator {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            next_batch_id: 1,
            batch_start: None,
            completed_batches: Vec::new(),
            state_balances: HashMap::new(),
        }
    }

    /// Initialize the accumulator with existing account balances.
    pub fn load_balances(&mut self, balances: HashMap<String, u64>) {
        self.state_balances = balances;
    }

    /// Add a transfer to the pending batch.
    /// Returns Some(batch_result) if the batch is now full and was processed.
    pub fn add_transfer(&mut self, transfer: PendingTransfer) -> Option<RollupBatchResult> {
        if self.batch_start.is_none() {
            self.batch_start = Some(Instant::now());
        }
        self.pending.push(transfer);

        if self.pending.len() >= MAX_BATCH_SIZE {
            Some(self.flush_batch())
        } else {
            None
        }
    }

    /// Check if the batch timeout has expired and flush if so.
    pub fn check_timeout(&mut self) -> Option<RollupBatchResult> {
        if let Some(start) = self.batch_start {
            if !self.pending.is_empty()
                && start.elapsed() >= Duration::from_secs(BATCH_TIMEOUT_SECS)
            {
                return Some(self.flush_batch());
            }
        }
        None
    }

    /// Process the current pending batch: execute, compute roots, prove.
    fn flush_batch(&mut self) -> RollupBatchResult {
        let transfers = std::mem::take(&mut self.pending);
        self.batch_start = None;

        let batch_id = self.next_batch_id;
        self.next_batch_id += 1;

        // Compute pre-state root
        let pre_state_root = compute_state_root(&self.state_balances);

        // Build rollup transfer descriptors with current balances
        let rollup_transfers: Vec<RollupTransfer> = transfers
            .iter()
            .map(|t| {
                let sender_before = *self.state_balances.get(&t.sender).unwrap_or(&0);
                let receiver_before = *self.state_balances.get(&t.receiver).unwrap_or(&0);
                RollupTransfer {
                    sender_before,
                    receiver_before,
                    amount: t.amount,
                    fee: t.fee,
                }
            })
            .collect();

        // Apply transfers to state (mutates balances)
        let transfer_tuples: Vec<(String, String, u64, u64)> = transfers
            .iter()
            .map(|t| (t.sender.clone(), t.receiver.clone(), t.amount, t.fee))
            .collect();
        let post_state_root =
            apply_transfers_and_compute_root(&mut self.state_balances, &transfer_tuples);

        // Generate STARK proof
        let prove_start = Instant::now();
        let proof_result = prove_rollup_batch(&rollup_transfers, &pre_state_root, &post_state_root);
        let proof_time_ms = prove_start.elapsed().as_millis();

        let total_fees: u64 = transfers.iter().map(|t| t.fee).sum();

        let batch_result = match proof_result {
            Ok((proof, pub_inputs)) => {
                let proof_bytes = proof.to_bytes();
                let proof_size = proof_bytes.len();

                // Verify the proof we just generated
                let verified = verify_rollup_batch(proof, pub_inputs).is_ok();

                RollupBatchResult {
                    batch_id,
                    transfer_count: transfers.len(),
                    total_fees,
                    pre_state_root: hex::encode(pre_state_root),
                    post_state_root: hex::encode(post_state_root),
                    proof_size_bytes: proof_size,
                    proof_time_ms,
                    verified,
                }
            }
            Err(e) => {
                eprintln!("[Rollup] Batch {} proof generation failed: {}", batch_id, e);
                RollupBatchResult {
                    batch_id,
                    transfer_count: transfers.len(),
                    total_fees,
                    pre_state_root: hex::encode(pre_state_root),
                    post_state_root: hex::encode(post_state_root),
                    proof_size_bytes: 0,
                    proof_time_ms,
                    verified: false,
                }
            }
        };

        self.completed_batches.push(batch_result.clone());
        batch_result
    }

    /// Get the current status of the accumulator.
    pub fn status(&self) -> RollupStatus {
        RollupStatus {
            pending_transfers: self.pending.len(),
            completed_batches: self.completed_batches.len(),
            next_batch_id: self.next_batch_id,
            max_batch_size: MAX_BATCH_SIZE,
            batch_timeout_secs: BATCH_TIMEOUT_SECS,
            current_state_root: hex::encode(compute_state_root(&self.state_balances)),
            accounts_tracked: self.state_balances.len(),
        }
    }

    /// Get a completed batch by ID.
    pub fn get_batch(&self, batch_id: u64) -> Option<&RollupBatchResult> {
        self.completed_batches.iter().find(|b| b.batch_id == batch_id)
    }
}

/// Status of the rollup accumulator.
#[derive(Debug, Serialize)]
pub struct RollupStatus {
    pub pending_transfers: usize,
    pub completed_batches: usize,
    pub next_batch_id: u64,
    pub max_batch_size: usize,
    pub batch_timeout_secs: u64,
    pub current_state_root: String,
    pub accounts_tracked: usize,
}
