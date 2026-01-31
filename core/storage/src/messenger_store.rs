use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessengerWallet {
    pub id: String,
    pub display_name: String,
    pub signing_public_key: String,
    pub encryption_public_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub created_by: String,
    pub participant_ids: Vec<String>,
    pub name: Option<String>,
    pub is_group: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessengerMessage {
    pub id: String,
    pub conversation_id: String,
    pub sender_wallet_id: String,
    pub encrypted_content: String,
    pub signature: String,
    pub self_destruct: bool,
    pub destruct_after_seconds: Option<u64>,
    pub created_at: String,
    pub is_read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MessengerState {
    wallets: Vec<MessengerWallet>,
    conversations: Vec<Conversation>,
    messages: Vec<MessengerMessage>,
}

#[derive(Clone)]
pub struct MessengerStore {
    path: PathBuf,
}

impl MessengerStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        let path = data_dir.as_ref().join("messenger.json");
        Self { path }
    }

    pub fn init(&self) -> Result<(), String> {
        if !self.path.exists() {
            let state = MessengerState::default();
            self.save_state(&state)?;
        }
        Ok(())
    }

    pub fn list_wallets(&self) -> Result<Vec<MessengerWallet>, String> {
        Ok(self.load_state()?.wallets)
    }

    pub fn register_wallet(&self, wallet: MessengerWallet) -> Result<MessengerWallet, String> {
        let mut state = self.load_state()?;
        state.wallets.retain(|w| w.id != wallet.id);
        state.wallets.push(wallet.clone());
        self.save_state(&state)?;
        Ok(wallet)
    }

    pub fn list_conversations(&self, wallet_id: &str) -> Result<Vec<Conversation>, String> {
        let state = self.load_state()?;
        Ok(state
            .conversations
            .into_iter()
            .filter(|c| c.participant_ids.iter().any(|id| id == wallet_id))
            .collect())
    }

    pub fn create_conversation(
        &self,
        created_by: &str,
        participant_ids: Vec<String>,
        name: Option<String>,
        is_group: bool,
    ) -> Result<Conversation, String> {
        let mut state = self.load_state()?;
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            created_by: created_by.to_string(),
            participant_ids,
            name,
            is_group,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        state.conversations.push(conversation.clone());
        self.save_state(&state)?;
        Ok(conversation)
    }

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<MessengerMessage>, String> {
        let state = self.load_state()?;
        Ok(state
            .messages
            .into_iter()
            .filter(|m| m.conversation_id == conversation_id)
            .collect())
    }

    pub fn add_message(&self, message: MessengerMessage) -> Result<MessengerMessage, String> {
        let mut state = self.load_state()?;
        state.messages.push(message.clone());
        self.save_state(&state)?;
        Ok(message)
    }

    pub fn mark_message_read(&self, message_id: &str) -> Result<MessengerMessage, String> {
        let mut state = self.load_state()?;
        let mut updated = None;
        for message in state.messages.iter_mut() {
            if message.id == message_id {
                message.is_read = true;
                updated = Some(message.clone());
                break;
            }
        }
        if let Some(message) = updated.clone() {
            self.save_state(&state)?;
            return Ok(message);
        }
        Err("message not found".to_string())
    }


    fn load_state(&self) -> Result<MessengerState, String> {
        let raw = fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        serde_json::from_str::<MessengerState>(&raw).map_err(|e| e.to_string())
    }

    fn save_state(&self, state: &MessengerState) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        fs::write(&self.path, raw).map_err(|e| e.to_string())
    }
}
