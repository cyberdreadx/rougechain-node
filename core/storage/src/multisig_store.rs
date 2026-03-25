// ============================================================================
// multisig_store — M-of-N multi-signature wallets (PQC-safe)
//
// Multi-sig wallets store N ML-DSA-65 public keys and require M signatures
// for any transaction. Proposals are submitted, co-signers approve, and
// the transaction auto-executes when the threshold is reached.
// ============================================================================

use serde::{Deserialize, Serialize};
use sled::Db;

/// An M-of-N multi-signature wallet
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultisigWallet {
    pub wallet_id: String,           // Unique wallet identifier
    pub creator: String,             // Creator's public key
    pub signers: Vec<String>,        // N public keys (ordered)
    pub threshold: u32,              // M — minimum signatures required
    pub created_at_height: u64,      // Block height when created
    pub label: Option<String>,       // Optional human-readable label
}

/// A pending multisig transaction proposal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultisigProposal {
    pub proposal_id: String,         // Unique proposal identifier
    pub wallet_id: String,           // Which multisig wallet this belongs to
    pub tx_type: String,             // Underlying tx type: "transfer", "token_transfer", etc.
    pub proposer: String,            // Who proposed this
    pub payload: serde_json::Value,  // The full TxPayload of the proposed tx
    pub fee: f64,                    // Fee for the transaction
    pub approvals: Vec<String>,      // Public keys that have approved (signed)
    pub signatures: Vec<String>,     // Corresponding signatures
    pub executed: bool,              // Whether this has been executed
    pub created_at_height: u64,
    pub executed_at_height: Option<u64>,
}

#[derive(Clone)]
pub struct MultisigStore {
    wallets_db: Db,
    proposals_db: Db,
}

impl MultisigStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let wallets_path = data_dir.as_ref().join("multisig-wallets-db");
        let proposals_path = data_dir.as_ref().join("multisig-proposals-db");
        let wallets_db = sled::open(&wallets_path)
            .map_err(|e| format!("Failed to open multisig wallets store: {}", e))?;
        let proposals_db = sled::open(&proposals_path)
            .map_err(|e| format!("Failed to open multisig proposals store: {}", e))?;
        Ok(Self { wallets_db, proposals_db })
    }

    // ── Wallet CRUD ──

    pub fn create_wallet(&self, wallet: &MultisigWallet) -> Result<(), String> {
        let value = serde_json::to_vec(wallet).map_err(|e| format!("Serialize wallet: {}", e))?;
        self.wallets_db.insert(wallet.wallet_id.as_bytes(), value)
            .map_err(|e| format!("Insert wallet: {}", e))?;
        self.wallets_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_wallet(&self, wallet_id: &str) -> Result<Option<MultisigWallet>, String> {
        match self.wallets_db.get(wallet_id.as_bytes()).map_err(|e| format!("Get wallet: {}", e))? {
            Some(bytes) => {
                let w: MultisigWallet = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Deserialize wallet: {}", e))?;
                Ok(Some(w))
            }
            None => Ok(None),
        }
    }

    pub fn get_wallets_by_signer(&self, pub_key: &str) -> Result<Vec<MultisigWallet>, String> {
        let mut wallets = Vec::new();
        for entry in self.wallets_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter wallet: {}", e))?;
            if let Ok(w) = serde_json::from_slice::<MultisigWallet>(&val) {
                if w.signers.iter().any(|s| s == pub_key) {
                    wallets.push(w);
                }
            }
        }
        Ok(wallets)
    }

    pub fn list_wallets(&self) -> Result<Vec<MultisigWallet>, String> {
        let mut wallets = Vec::new();
        for entry in self.wallets_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter wallet: {}", e))?;
            if let Ok(w) = serde_json::from_slice::<MultisigWallet>(&val) {
                wallets.push(w);
            }
        }
        Ok(wallets)
    }

    // ── Proposal CRUD ──

    pub fn create_proposal(&self, proposal: &MultisigProposal) -> Result<(), String> {
        let value = serde_json::to_vec(proposal).map_err(|e| format!("Serialize proposal: {}", e))?;
        self.proposals_db.insert(proposal.proposal_id.as_bytes(), value)
            .map_err(|e| format!("Insert proposal: {}", e))?;
        self.proposals_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_proposal(&self, proposal_id: &str) -> Result<Option<MultisigProposal>, String> {
        match self.proposals_db.get(proposal_id.as_bytes()).map_err(|e| format!("Get proposal: {}", e))? {
            Some(bytes) => {
                let p: MultisigProposal = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Deserialize proposal: {}", e))?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    pub fn update_proposal(&self, proposal: &MultisigProposal) -> Result<(), String> {
        self.create_proposal(proposal) // Same as create — overwrites
    }

    pub fn get_proposals_by_wallet(&self, wallet_id: &str) -> Result<Vec<MultisigProposal>, String> {
        let mut proposals = Vec::new();
        for entry in self.proposals_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter proposal: {}", e))?;
            if let Ok(p) = serde_json::from_slice::<MultisigProposal>(&val) {
                if p.wallet_id == wallet_id {
                    proposals.push(p);
                }
            }
        }
        Ok(proposals)
    }
}
