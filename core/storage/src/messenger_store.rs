use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessengerWallet {
    pub id: String,
    pub display_name: String,
    pub signing_public_key: String,
    pub encryption_public_key: String,
    pub created_at: String,
    #[serde(default = "default_discoverable")]
    pub discoverable: bool,
}

fn default_discoverable() -> bool {
    true
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
    pub message_type: String,
    #[serde(default)]
    pub spoiler: bool,
}

fn default_message_type() -> String {
    "text".to_string()
}

#[derive(Clone)]
pub struct MessengerStore {
    db: Arc<sled::Db>,
}

impl MessengerStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        let db_path = data_dir.as_ref().join("messenger-db");
        let db = sled::open(&db_path).expect("Failed to open messenger sled DB");
        let store = Self { db: Arc::new(db) };

        // Migrate from legacy JSON file if it exists
        let json_path = data_dir.as_ref().join("messenger.json");
        if json_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&json_path) {
                #[derive(Deserialize)]
                struct LegacyState {
                    #[serde(default)]
                    wallets: Vec<MessengerWallet>,
                    #[serde(default)]
                    conversations: Vec<Conversation>,
                    #[serde(default)]
                    messages: Vec<MessengerMessage>,
                }
                if let Ok(state) = serde_json::from_str::<LegacyState>(&raw) {
                    let wallets = store.wallets_tree().unwrap();
                    let signing_idx = store.signing_key_index_tree().unwrap();
                    let enc_idx = store.enc_key_index_tree().unwrap();
                    for w in &state.wallets {
                        let bytes = serde_json::to_vec(w).unwrap();
                        let _ = wallets.insert(w.id.as_bytes(), bytes.as_slice());
                        if !w.signing_public_key.is_empty() {
                            let _ = signing_idx.insert(w.signing_public_key.as_bytes(), w.id.as_bytes());
                        }
                        if !w.encryption_public_key.is_empty() {
                            let _ = enc_idx.insert(w.encryption_public_key.as_bytes(), w.id.as_bytes());
                        }
                    }
                    let convos = store.conversations_tree().unwrap();
                    let participant_idx = store.participant_index_tree().unwrap();
                    for c in &state.conversations {
                        let bytes = serde_json::to_vec(c).unwrap();
                        let _ = convos.insert(c.id.as_bytes(), bytes.as_slice());
                        for pid in &c.participant_ids {
                            let key = format!("{}:{}", pid, c.id);
                            let _ = participant_idx.insert(key.as_bytes(), b"");
                        }
                    }
                    let msgs = store.messages_tree().unwrap();
                    let conv_msg_idx = store.conv_msg_index_tree().unwrap();
                    for m in &state.messages {
                        let bytes = serde_json::to_vec(m).unwrap();
                        let _ = msgs.insert(m.id.as_bytes(), bytes.as_slice());
                        let idx_key = format!("{}:{}", m.conversation_id, m.created_at);
                        let _ = conv_msg_idx.insert(idx_key.as_bytes(), m.id.as_bytes());
                    }
                    let _ = store.db.flush();
                    let backup = data_dir.as_ref().join("messenger.json.migrated");
                    let _ = std::fs::rename(&json_path, &backup);
                }
            }
        }

        store
    }

    pub fn init(&self) -> Result<(), String> {
        Ok(())
    }

    // --- Tree accessors ---

    fn wallets_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_wallets").map_err(|e| e.to_string())
    }

    fn signing_key_index_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_signing_idx").map_err(|e| e.to_string())
    }

    fn enc_key_index_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_enc_idx").map_err(|e| e.to_string())
    }

    fn conversations_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_conversations").map_err(|e| e.to_string())
    }

    fn participant_index_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_participant_idx").map_err(|e| e.to_string())
    }

    fn messages_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_messages").map_err(|e| e.to_string())
    }

    fn conv_msg_index_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("msg_conv_msg_idx").map_err(|e| e.to_string())
    }

    // --- Wallets ---

    pub fn list_wallets(&self) -> Result<Vec<MessengerWallet>, String> {
        let tree = self.wallets_tree()?;
        let mut wallets = Vec::new();
        for entry in tree.iter() {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let w: MessengerWallet = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            wallets.push(w);
        }
        Ok(wallets)
    }

    pub fn list_discoverable_wallets(&self) -> Result<Vec<MessengerWallet>, String> {
        Ok(self.list_wallets()?.into_iter().filter(|w| w.discoverable).collect())
    }

    pub fn register_wallet(&self, wallet: MessengerWallet) -> Result<MessengerWallet, String> {
        let tree = self.wallets_tree()?;
        let signing_idx = self.signing_key_index_tree()?;
        let enc_idx = self.enc_key_index_tree()?;
        let conv_tree = self.conversations_tree()?;
        let part_idx = self.participant_index_tree()?;

        // Find and remove old wallets with matching keys
        let mut old_ids: Vec<String> = Vec::new();
        let all_wallets = self.list_wallets()?;
        for w in &all_wallets {
            let same_id = w.id == wallet.id;
            let same_signing = !wallet.signing_public_key.is_empty() && w.signing_public_key == wallet.signing_public_key;
            let same_enc = !wallet.encryption_public_key.is_empty() && w.encryption_public_key == wallet.encryption_public_key;
            if same_id || same_signing || same_enc {
                if w.id != wallet.id {
                    old_ids.push(w.id.clone());
                }
                let _ = tree.remove(w.id.as_bytes());
                if !w.signing_public_key.is_empty() {
                    let _ = signing_idx.remove(w.signing_public_key.as_bytes());
                }
                if !w.encryption_public_key.is_empty() {
                    let _ = enc_idx.remove(w.encryption_public_key.as_bytes());
                }
            }
        }

        // Update stale participant_ids in conversations
        if !old_ids.is_empty() {
            for entry in conv_tree.iter() {
                let (k, v) = entry.map_err(|e| e.to_string())?;
                let mut conv: Conversation = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
                let mut changed = false;
                for pid in &mut conv.participant_ids {
                    if old_ids.contains(pid) {
                        // Update participant index
                        let old_key = format!("{}:{}", pid, conv.id);
                        let _ = part_idx.remove(old_key.as_bytes());
                        let new_key = format!("{}:{}", wallet.id, conv.id);
                        let _ = part_idx.insert(new_key.as_bytes(), b"");
                        *pid = wallet.id.clone();
                        changed = true;
                    }
                }
                if changed {
                    let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
                    let _ = conv_tree.insert(&k, bytes.as_slice());
                }
            }
        }

        // Insert the new wallet
        let bytes = serde_json::to_vec(&wallet).map_err(|e| e.to_string())?;
        tree.insert(wallet.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        if !wallet.signing_public_key.is_empty() {
            signing_idx.insert(wallet.signing_public_key.as_bytes(), wallet.id.as_bytes()).map_err(|e| e.to_string())?;
        }
        if !wallet.encryption_public_key.is_empty() {
            enc_idx.insert(wallet.encryption_public_key.as_bytes(), wallet.id.as_bytes()).map_err(|e| e.to_string())?;
        }

        Ok(wallet)
    }

    // --- Conversations ---

    fn get_all_matching_ids(&self, wallet_id: &str, extra_keys: &[&str]) -> Vec<String> {
        let mut ids = vec![wallet_id.to_string()];
        for key in extra_keys {
            if !key.is_empty() { ids.push(key.to_string()); }
        }
        if let Ok(wallets) = self.list_wallets() {
            for w in &wallets {
                let is_match = w.id == wallet_id
                    || w.signing_public_key == wallet_id
                    || w.encryption_public_key == wallet_id
                    || extra_keys.iter().any(|k| !k.is_empty() && (w.signing_public_key == *k || w.encryption_public_key == *k));
                if is_match {
                    ids.push(w.id.clone());
                    if !w.signing_public_key.is_empty() { ids.push(w.signing_public_key.clone()); }
                    if !w.encryption_public_key.is_empty() { ids.push(w.encryption_public_key.clone()); }
                }
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn list_conversations(&self, wallet_id: &str) -> Result<Vec<Conversation>, String> {
        self.list_conversations_extended(wallet_id, &[])
    }

    pub fn list_conversations_extended(&self, wallet_id: &str, extra_keys: &[&str]) -> Result<Vec<Conversation>, String> {
        let my_keys = self.get_all_matching_ids(wallet_id, extra_keys);
        let part_idx = self.participant_index_tree()?;
        let conv_tree = self.conversations_tree()?;

        let mut conv_ids = std::collections::HashSet::new();
        for key in &my_keys {
            let prefix = format!("{}:", key);
            for entry in part_idx.scan_prefix(prefix.as_bytes()) {
                let (k, _) = entry.map_err(|e| e.to_string())?;
                let key_str = String::from_utf8_lossy(&k);
                if let Some(cid) = key_str.split(':').nth(1) {
                    conv_ids.insert(cid.to_string());
                }
            }
        }

        // Also scan all conversations and check participant resolution through wallets
        let all_wallets = self.list_wallets().unwrap_or_default();
        for entry in conv_tree.iter() {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let conv: Conversation = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            for pid in &conv.participant_ids {
                if my_keys.contains(pid) {
                    conv_ids.insert(conv.id.clone());
                    break;
                }
                for w in &all_wallets {
                    if (w.id == *pid || w.signing_public_key == *pid || w.encryption_public_key == *pid)
                        && (my_keys.contains(&w.id) || my_keys.contains(&w.signing_public_key) || my_keys.contains(&w.encryption_public_key))
                    {
                        conv_ids.insert(conv.id.clone());
                        break;
                    }
                }
            }
        }

        let mut result = Vec::new();
        for cid in conv_ids {
            if let Some(v) = conv_tree.get(cid.as_bytes()).map_err(|e| e.to_string())? {
                let conv: Conversation = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
                result.push(conv);
            }
        }
        Ok(result)
    }

    pub fn create_conversation(
        &self,
        created_by: &str,
        participant_ids: Vec<String>,
        name: Option<String>,
        is_group: bool,
    ) -> Result<Conversation, String> {
        let conv = Conversation {
            id: Uuid::new_v4().to_string(),
            created_by: created_by.to_string(),
            participant_ids: participant_ids.clone(),
            name,
            is_group,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let tree = self.conversations_tree()?;
        let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
        tree.insert(conv.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;

        let part_idx = self.participant_index_tree()?;
        for pid in &participant_ids {
            let key = format!("{}:{}", pid, conv.id);
            part_idx.insert(key.as_bytes(), b"").map_err(|e| e.to_string())?;
        }

        Ok(conv)
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), String> {
        let conv_tree = self.conversations_tree()?;
        let part_idx = self.participant_index_tree()?;

        // Remove participant index entries
        if let Some(v) = conv_tree.get(conversation_id.as_bytes()).map_err(|e| e.to_string())? {
            let conv: Conversation = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            for pid in &conv.participant_ids {
                let key = format!("{}:{}", pid, conversation_id);
                let _ = part_idx.remove(key.as_bytes());
            }
        }
        conv_tree.remove(conversation_id.as_bytes()).map_err(|e| e.to_string())?;

        // Remove all messages in this conversation
        let msg_tree = self.messages_tree()?;
        let conv_msg_idx = self.conv_msg_index_tree()?;
        let prefix = format!("{}:", conversation_id);
        let mut msg_ids = Vec::new();
        for entry in conv_msg_idx.scan_prefix(prefix.as_bytes()) {
            let (k, v) = entry.map_err(|e| e.to_string())?;
            let mid = String::from_utf8_lossy(&v).to_string();
            msg_ids.push((k.to_vec(), mid));
        }
        for (idx_key, mid) in msg_ids {
            let _ = msg_tree.remove(mid.as_bytes());
            let _ = conv_msg_idx.remove(&idx_key);
        }

        Ok(())
    }

    // --- Messages ---

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<MessengerMessage>, String> {
        let conv_msg_idx = self.conv_msg_index_tree()?;
        let msg_tree = self.messages_tree()?;
        let prefix = format!("{}:", conversation_id);
        let mut messages = Vec::new();
        for entry in conv_msg_idx.scan_prefix(prefix.as_bytes()) {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let mid = String::from_utf8_lossy(&v);
            if let Some(msg_bytes) = msg_tree.get(mid.as_bytes()).map_err(|e| e.to_string())? {
                let msg: MessengerMessage = serde_json::from_slice(&msg_bytes).map_err(|e| e.to_string())?;
                messages.push(msg);
            }
        }
        messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(messages)
    }

    pub fn add_message(&self, message: MessengerMessage) -> Result<MessengerMessage, String> {
        let msg_tree = self.messages_tree()?;
        let conv_msg_idx = self.conv_msg_index_tree()?;
        let bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        msg_tree.insert(message.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        let idx_key = format!("{}:{}", message.conversation_id, message.created_at);
        conv_msg_idx.insert(idx_key.as_bytes(), message.id.as_bytes()).map_err(|e| e.to_string())?;
        Ok(message)
    }

    pub fn delete_message(&self, message_id: &str) -> Result<(), String> {
        let msg_tree = self.messages_tree()?;
        let conv_msg_idx = self.conv_msg_index_tree()?;

        if let Some(v) = msg_tree.get(message_id.as_bytes()).map_err(|e| e.to_string())? {
            let msg: MessengerMessage = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            let idx_key = format!("{}:{}", msg.conversation_id, msg.created_at);
            let _ = conv_msg_idx.remove(idx_key.as_bytes());
        } else {
            return Err("Message not found".to_string());
        }
        msg_tree.remove(message_id.as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_message_read(&self, message_id: &str) -> Result<MessengerMessage, String> {
        let msg_tree = self.messages_tree()?;
        if let Some(v) = msg_tree.get(message_id.as_bytes()).map_err(|e| e.to_string())? {
            let mut msg: MessengerMessage = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            msg.is_read = true;
            if msg.read_at.is_none() {
                msg.read_at = Some(chrono::Utc::now().to_rfc3339());
            }
            let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
            msg_tree.insert(message_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
            Ok(msg)
        } else {
            Err("message not found".to_string())
        }
    }

    pub fn cleanup_expired_messages(&self) -> Result<usize, String> {
        let msg_tree = self.messages_tree()?;
        let conv_msg_idx = self.conv_msg_index_tree()?;
        let now = chrono::Utc::now();
        let mut to_remove = Vec::new();

        for entry in msg_tree.iter() {
            let (k, v) = entry.map_err(|e| e.to_string())?;
            let msg: MessengerMessage = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            if !msg.self_destruct { continue; }
            let read_at = match &msg.read_at {
                Some(ts) => ts.clone(),
                None => continue,
            };
            let parsed = match chrono::DateTime::parse_from_rfc3339(&read_at) {
                Ok(dt) => dt.with_timezone(&chrono::Utc),
                Err(_) => continue,
            };
            let ttl_secs = msg.destruct_after_seconds.unwrap_or(30);
            let deadline = parsed + chrono::Duration::seconds(ttl_secs as i64);
            if now >= deadline {
                let idx_key = format!("{}:{}", msg.conversation_id, msg.created_at);
                to_remove.push((k.to_vec(), idx_key));
            }
        }

        let count = to_remove.len();
        for (msg_key, idx_key) in to_remove {
            let _ = msg_tree.remove(&msg_key);
            let _ = conv_msg_idx.remove(idx_key.as_bytes());
        }
        Ok(count)
    }

    pub fn list_conversations_with_activity(
        &self,
        wallet_id: &str,
        extra_keys: &[&str],
    ) -> Result<Vec<serde_json::Value>, String> {
        let my_keys = self.get_all_matching_ids(wallet_id, extra_keys);
        let conversations = self.list_conversations_extended(wallet_id, extra_keys)?;

        let result: Vec<serde_json::Value> = conversations
            .iter()
            .map(|c| {
                let msgs = self.list_messages(&c.id).unwrap_or_default();
                let last_msg = msgs.iter().max_by(|a, b| a.created_at.cmp(&b.created_at));
                let unread: u64 = msgs.iter()
                    .filter(|m| !m.is_read && !my_keys.contains(&m.sender_wallet_id))
                    .count() as u64;

                let mut val = serde_json::to_value(c).unwrap_or_default();
                if let Some(msg) = last_msg {
                    val["last_message_at"] = serde_json::json!(msg.created_at);
                    val["last_sender_id"] = serde_json::json!(msg.sender_wallet_id);
                    let preview = match msg.message_type.as_str() {
                        "image" => "[Image]".to_string(),
                        "video" => "[Video]".to_string(),
                        _ => "[Encrypted message]".to_string(),
                    };
                    val["last_message_preview"] = serde_json::json!(preview);
                }
                val["unread_count"] = serde_json::json!(unread);
                val
            })
            .collect();

        Ok(result)
    }
}
