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
}

impl GovernanceStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let prop_path = data_dir.as_ref().join("governance-proposals-db");
        let vote_path = data_dir.as_ref().join("governance-votes-db");
        let proposals_db = sled::open(&prop_path).map_err(|e| format!("Open proposals: {}", e))?;
        let votes_db = sled::open(&vote_path).map_err(|e| format!("Open votes: {}", e))?;
        Ok(Self { proposals_db, votes_db })
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
}
