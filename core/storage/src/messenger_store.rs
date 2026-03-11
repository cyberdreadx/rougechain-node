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
    #[serde(default)]
    pub read_at: Option<String>,
    #[serde(default = "default_message_type")]
    pub message_type: String, // "text", "image", "video"
    #[serde(default)]
    pub spoiler: bool,
}

fn default_message_type() -> String {
    "text".to_string()
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
        // Remove any existing wallet with same id OR same signing key (prevents duplicates)
        state.wallets.retain(|w| {
            w.id != wallet.id && 
            (wallet.signing_public_key.is_empty() || w.signing_public_key != wallet.signing_public_key) &&
            (wallet.encryption_public_key.is_empty() || w.encryption_public_key != wallet.encryption_public_key)
        });
        state.wallets.push(wallet.clone());
        self.save_state(&state)?;
        Ok(wallet)
    }

    pub fn list_conversations(&self, wallet_id: &str) -> Result<Vec<Conversation>, String> {
        self.list_conversations_extended(wallet_id, &[])
    }

    pub fn list_conversations_extended(&self, wallet_id: &str, extra_keys: &[&str]) -> Result<Vec<Conversation>, String> {
        let state = self.load_state()?;
        let mut matching_ids: Vec<String> = vec![wallet_id.to_string()];
        for key in extra_keys {
            if !key.is_empty() {
                matching_ids.push(key.to_string());
            }
        }
        // Find ALL wallets that match by id, signing key, or encryption key
        for w in &state.wallets {
            let is_match = w.id == wallet_id
                || w.signing_public_key == wallet_id
                || w.encryption_public_key == wallet_id
                || extra_keys.iter().any(|k| !k.is_empty() && (w.signing_public_key == *k || w.encryption_public_key == *k));
            if is_match {
                matching_ids.push(w.id.clone());
                if !w.signing_public_key.is_empty() {
                    matching_ids.push(w.signing_public_key.clone());
                }
                if !w.encryption_public_key.is_empty() {
                    matching_ids.push(w.encryption_public_key.clone());
                }
            }
        }
        // Also resolve each conversation participant through the wallet store
        // to catch ID changes (e.g., wallet re-registered with different UUID)
        let my_keys: Vec<String> = matching_ids.clone();
        Ok(state
            .conversations
            .into_iter()
            .filter(|c| {
                c.participant_ids.iter().any(|pid| {
                    if my_keys.contains(pid) {
                        return true;
                    }
                    // Check if this participant_id resolves to a wallet with our keys
                    for w in &state.wallets {
                        if w.id == *pid || w.signing_public_key == *pid || w.encryption_public_key == *pid {
                            if my_keys.contains(&w.id)
                                || my_keys.contains(&w.signing_public_key)
                                || my_keys.contains(&w.encryption_public_key)
                            {
                                return true;
                            }
                        }
                    }
                    false
                })
            })
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

    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), String> {
        let mut state = self.load_state()?;
        // Remove conversation
        state.conversations.retain(|c| c.id != conversation_id);
        // Also remove all messages in this conversation
        state.messages.retain(|m| m.conversation_id != conversation_id);
        self.save_state(&state)?;
        Ok(())
    }

    pub fn delete_message(&self, message_id: &str) -> Result<(), String> {
        let mut state = self.load_state()?;
        let before = state.messages.len();
        state.messages.retain(|m| m.id != message_id);
        if state.messages.len() == before {
            return Err("Message not found".to_string());
        }
        self.save_state(&state)?;
        Ok(())
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
        let now = chrono::Utc::now().to_rfc3339();
        for message in state.messages.iter_mut() {
            if message.id == message_id {
                message.is_read = true;
                if message.read_at.is_none() {
                    message.read_at = Some(now);
                }
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

    /// Remove self-destruct messages that have been read and whose timer has expired.
    /// Returns the number of messages deleted.
    pub fn cleanup_expired_messages(&self) -> Result<usize, String> {
        let mut state = self.load_state()?;
        let now = chrono::Utc::now();
        let before = state.messages.len();

        state.messages.retain(|m| {
            if !m.self_destruct {
                return true; // keep non-self-destruct messages
            }
            let read_at = match &m.read_at {
                Some(ts) => ts,
                None => return true, // not read yet — keep
            };
            let parsed = match chrono::DateTime::parse_from_rfc3339(read_at) {
                Ok(dt) => dt.with_timezone(&chrono::Utc),
                Err(_) => return true, // unparseable timestamp — keep to be safe
            };
            let ttl_secs = m.destruct_after_seconds.unwrap_or(30);
            let deadline = parsed + chrono::Duration::seconds(ttl_secs as i64);
            if now >= deadline {
                false // expired — delete
            } else {
                true // still within TTL — keep
            }
        });

        let removed = before - state.messages.len();
        if removed > 0 {
            self.save_state(&state)?;
        }
        Ok(removed)
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
