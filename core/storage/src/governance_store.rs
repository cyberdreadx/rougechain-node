// ============================================================================
// governance_store — On-chain governance proposals and votes
//
// Token holders can create proposals and vote on them.
// Voting power = token balance at proposal creation time.
// ============================================================================

use serde::{Deserialize, Serialize};
use sled::Db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub proposal_id: String,
    pub token_symbol: String,         // Which token's governance
    pub creator: String,
    pub title: String,
    pub description: String,
    pub end_height: u64,              // Block height when voting ends
    pub created_at_height: u64,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub abstain_votes: u64,
    pub executed: bool,
    // ── Enhanced fields ──
    #[serde(default)]
    pub proposal_type: String,        // "text" | "param_change" | "treasury_spend"
    #[serde(default)]
    pub action_payload: Option<serde_json::Value>,  // Type-specific payload
    #[serde(default = "default_quorum")]
    pub quorum: u64,                  // Min total votes required (default: 1000)
    #[serde(default = "default_threshold")]
    pub pass_threshold_pct: u32,      // % yes votes needed to pass (default: 50)
    #[serde(default)]
    pub timelock_blocks: u64,         // Blocks to wait after voting ends before execution
    #[serde(default)]
    pub executable_after: u64,        // end_height + timelock_blocks (computed at creation)
}

fn default_quorum() -> u64 { 1000 }
fn default_threshold() -> u32 { 50 }

impl Proposal {
    /// Compute the current status of a proposal given current block height
    pub fn status(&self, current_height: u64) -> &'static str {
        if self.executed {
            return "executed";
        }
        if current_height < self.end_height {
            return "active";
        }
        // Voting has ended — check results
        let total = self.yes_votes + self.no_votes + self.abstain_votes;
        let quorum_met = total >= self.quorum;
        let threshold_met = if total > 0 {
            (self.yes_votes * 100 / total) >= self.pass_threshold_pct as u64
        } else {
            false
        };
        if !quorum_met || !threshold_met {
            return "failed";
        }
        // Passed — check timelock
        let exec_after = if self.executable_after > 0 {
            self.executable_after
        } else {
            self.end_height + self.timelock_blocks
        };
        if current_height < exec_after {
            return "queued"; // In timelock period
        }
        "passed" // Ready to execute
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vote {
    pub voter: String,
    pub proposal_id: String,
    pub option: String,               // "yes" | "no" | "abstain"
    pub weight: u64,                  // Token balance = voting power
}

#[derive(Clone)]
pub struct GovernanceStore {
    proposals_db: Db,
    votes_db: Db,
    delegations_db: Db,
}

impl GovernanceStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let prop_path = data_dir.as_ref().join("governance-proposals-db");
        let vote_path = data_dir.as_ref().join("governance-votes-db");
        let deleg_path = data_dir.as_ref().join("governance-delegations-db");
        let proposals_db = sled::open(&prop_path).map_err(|e| format!("Open proposals: {}", e))?;
        let votes_db = sled::open(&vote_path).map_err(|e| format!("Open votes: {}", e))?;
        let delegations_db = sled::open(&deleg_path).map_err(|e| format!("Open delegations: {}", e))?;
        Ok(Self { proposals_db, votes_db, delegations_db })
    }

    pub fn save_proposal(&self, proposal: &Proposal) -> Result<(), String> {
        let value = serde_json::to_vec(proposal).map_err(|e| format!("Serialize proposal: {}", e))?;
        self.proposals_db.insert(proposal.proposal_id.as_bytes(), value)
            .map_err(|e| format!("Insert proposal: {}", e))?;
        self.proposals_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_proposal(&self, proposal_id: &str) -> Result<Option<Proposal>, String> {
        match self.proposals_db.get(proposal_id.as_bytes()).map_err(|e| format!("Get proposal: {}", e))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| format!("Deser proposal: {}", e))?)),
            None => Ok(None),
        }
    }

    pub fn list_proposals(&self) -> Result<Vec<Proposal>, String> {
        let mut proposals = Vec::new();
        for entry in self.proposals_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter proposal: {}", e))?;
            if let Ok(p) = serde_json::from_slice::<Proposal>(&val) {
                proposals.push(p);
            }
        }
        Ok(proposals)
    }

    pub fn list_proposals_by_token(&self, token_symbol: &str) -> Result<Vec<Proposal>, String> {
        let mut proposals = Vec::new();
        for entry in self.proposals_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter proposal: {}", e))?;
            if let Ok(p) = serde_json::from_slice::<Proposal>(&val) {
                if p.token_symbol == token_symbol {
                    proposals.push(p);
                }
            }
        }
        Ok(proposals)
    }

    // Vote methods
    fn vote_key(voter: &str, proposal_id: &str) -> String {
        format!("{}:{}", voter, proposal_id)
    }

    pub fn save_vote(&self, vote: &Vote) -> Result<(), String> {
        let key = Self::vote_key(&vote.voter, &vote.proposal_id);
        let value = serde_json::to_vec(vote).map_err(|e| format!("Serialize vote: {}", e))?;
        self.votes_db.insert(key.as_bytes(), value)
            .map_err(|e| format!("Insert vote: {}", e))?;
        self.votes_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_vote(&self, voter: &str, proposal_id: &str) -> Result<Option<Vote>, String> {
        let key = Self::vote_key(voter, proposal_id);
        match self.votes_db.get(key.as_bytes()).map_err(|e| format!("Get vote: {}", e))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| format!("Deser vote: {}", e))?)),
            None => Ok(None),
        }
    }

    pub fn get_votes_for_proposal(&self, proposal_id: &str) -> Result<Vec<Vote>, String> {
        let mut votes = Vec::new();
        for entry in self.votes_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter vote: {}", e))?;
            if let Ok(v) = serde_json::from_slice::<Vote>(&val) {
                if v.proposal_id == proposal_id {
                    votes.push(v);
                }
            }
        }
        Ok(votes)
    }

    // ── Delegation methods ──

    /// Delegate voting power from `delegator` to `delegate`
    pub fn set_delegation(&self, delegator: &str, delegate: &str) -> Result<(), String> {
        self.delegations_db.insert(delegator.as_bytes(), delegate.as_bytes())
            .map_err(|e| format!("Set delegation: {}", e))?;
        self.delegations_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    /// Remove delegation for `delegator`
    pub fn remove_delegation(&self, delegator: &str) -> Result<(), String> {
        self.delegations_db.remove(delegator.as_bytes())
            .map_err(|e| format!("Remove delegation: {}", e))?;
        self.delegations_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    /// Get who `delegator` has delegated to
    pub fn get_delegation(&self, delegator: &str) -> Result<Option<String>, String> {
        match self.delegations_db.get(delegator.as_bytes()).map_err(|e| format!("Get delegation: {}", e))? {
            Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
            None => Ok(None),
        }
    }

    /// Get all delegators who have delegated to `delegate`
    pub fn get_delegators_for(&self, delegate: &str) -> Result<Vec<String>, String> {
        let mut delegators = Vec::new();
        for entry in self.delegations_db.iter() {
            let (key, val) = entry.map_err(|e| format!("Iter delegation: {}", e))?;
            let target = String::from_utf8_lossy(&val).to_string();
            if target == delegate {
                delegators.push(String::from_utf8_lossy(&key).to_string());
            }
        }
        Ok(delegators)
    }

    /// Get all delegations as (delegator, delegate) pairs
    pub fn get_all_delegations(&self) -> Result<Vec<(String, String)>, String> {
        let mut pairs = Vec::new();
        for entry in self.delegations_db.iter() {
            let (key, val) = entry.map_err(|e| format!("Iter delegation: {}", e))?;
            pairs.push((
                String::from_utf8_lossy(&key).to_string(),
                String::from_utf8_lossy(&val).to_string(),
            ));
        }
        Ok(pairs)
    }
}
