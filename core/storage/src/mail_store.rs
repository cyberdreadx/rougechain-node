use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailMessage {
    pub id: String,
    pub from_wallet_id: String,
    pub to_wallet_ids: Vec<String>,
    pub subject_encrypted: String,
    pub body_encrypted: String,
    pub signature: String,
    pub created_at: String,
    pub reply_to_id: Option<String>,
    pub has_attachment: bool,
    pub attachment_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MailFolder {
    Inbox,
    Sent,
    Trash,
    Starred,
    Drafts,
}

impl MailFolder {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Trash => "trash",
            Self::Starred => "starred",
            Self::Drafts => "drafts",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "inbox" => Some(Self::Inbox),
            "sent" => Some(Self::Sent),
            "trash" => Some(Self::Trash),
            "starred" => Some(Self::Starred),
            "drafts" => Some(Self::Drafts),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailLabel {
    pub message_id: String,
    pub wallet_id: String,
    pub folder: String,
    pub is_read: bool,
}

#[derive(Clone)]
pub struct MailStore {
    db: Arc<sled::Db>,
}

impl MailStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let db_path = data_dir.as_ref().join("mail-db");
        let db = sled::open(&db_path)
            .map_err(|e| format!("Failed to open mail DB: {}", e))?;
        Ok(Self { db: Arc::new(db) })
    }

    fn messages_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("messages").map_err(|e| e.to_string())
    }

    fn labels_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("labels").map_err(|e| e.to_string())
    }

    fn label_key(wallet_id: &str, message_id: &str) -> String {
        format!("{}:{}", wallet_id, message_id)
    }

    pub fn store_message(&self, msg: MailMessage) -> Result<MailMessage, String> {
        let tree = self.messages_tree()?;
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        tree.insert(msg.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;

        let labels_tree = self.labels_tree()?;

        // Label for sender: "sent"
        let sender_label = MailLabel {
            message_id: msg.id.clone(),
            wallet_id: msg.from_wallet_id.clone(),
            folder: MailFolder::Sent.as_str().to_string(),
            is_read: true,
        };
        let sl_key = Self::label_key(&msg.from_wallet_id, &msg.id);
        let sl_bytes = serde_json::to_vec(&sender_label).map_err(|e| e.to_string())?;
        labels_tree.insert(sl_key.as_bytes(), sl_bytes.as_slice()).map_err(|e| e.to_string())?;

        // Label for each recipient: "inbox"
        for recipient_id in &msg.to_wallet_ids {
            let label = MailLabel {
                message_id: msg.id.clone(),
                wallet_id: recipient_id.clone(),
                folder: MailFolder::Inbox.as_str().to_string(),
                is_read: false,
            };
            let key = Self::label_key(recipient_id, &msg.id);
            let bytes = serde_json::to_vec(&label).map_err(|e| e.to_string())?;
            labels_tree.insert(key.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        }

        self.db.flush().map_err(|e| e.to_string())?;
        Ok(msg)
    }

    pub fn get_message(&self, message_id: &str) -> Result<Option<MailMessage>, String> {
        let tree = self.messages_tree()?;
        match tree.get(message_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(bytes) => {
                let msg: MailMessage = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                Ok(Some(msg))
            }
            None => Ok(None),
        }
    }

    pub fn list_folder(&self, wallet_id: &str, folder: &str) -> Result<Vec<(MailMessage, MailLabel)>, String> {
        let labels_tree = self.labels_tree()?;
        let messages_tree = self.messages_tree()?;
        let prefix = format!("{}:", wallet_id);
        let mut results = Vec::new();

        for item in labels_tree.scan_prefix(prefix.as_bytes()) {
            let (_, val) = item.map_err(|e| e.to_string())?;
            let label: MailLabel = serde_json::from_slice(&val).map_err(|e| e.to_string())?;
            if label.folder != folder {
                continue;
            }
            if let Some(msg_bytes) = messages_tree.get(label.message_id.as_bytes()).map_err(|e| e.to_string())? {
                let msg: MailMessage = serde_json::from_slice(&msg_bytes).map_err(|e| e.to_string())?;
                results.push((msg, label));
            }
        }

        results.sort_by(|a, b| b.0.created_at.cmp(&a.0.created_at));
        Ok(results)
    }

    pub fn move_to_folder(&self, wallet_id: &str, message_id: &str, folder: &str) -> Result<(), String> {
        let labels_tree = self.labels_tree()?;
        let key = Self::label_key(wallet_id, message_id);
        match labels_tree.get(key.as_bytes()).map_err(|e| e.to_string())? {
            Some(bytes) => {
                let mut label: MailLabel = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                label.folder = folder.to_string();
                let updated = serde_json::to_vec(&label).map_err(|e| e.to_string())?;
                labels_tree.insert(key.as_bytes(), updated.as_slice()).map_err(|e| e.to_string())?;
                self.db.flush().map_err(|e| e.to_string())?;
                Ok(())
            }
            None => Err("Mail label not found".into()),
        }
    }

    pub fn mark_read(&self, wallet_id: &str, message_id: &str) -> Result<(), String> {
        let labels_tree = self.labels_tree()?;
        let key = Self::label_key(wallet_id, message_id);
        match labels_tree.get(key.as_bytes()).map_err(|e| e.to_string())? {
            Some(bytes) => {
                let mut label: MailLabel = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                label.is_read = true;
                let updated = serde_json::to_vec(&label).map_err(|e| e.to_string())?;
                labels_tree.insert(key.as_bytes(), updated.as_slice()).map_err(|e| e.to_string())?;
                self.db.flush().map_err(|e| e.to_string())?;
                Ok(())
            }
            None => Err("Mail label not found".into()),
        }
    }

    pub fn delete_message(&self, wallet_id: &str, message_id: &str) -> Result<(), String> {
        let labels_tree = self.labels_tree()?;
        let key = Self::label_key(wallet_id, message_id);
        labels_tree.remove(key.as_bytes()).map_err(|e| e.to_string())?;
        self.db.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}
