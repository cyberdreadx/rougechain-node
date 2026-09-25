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
    /// Optional avatar shared via the directory (base64 data URI) so peers can render it.
    /// Absent for wallets registered before this field existed.
    #[serde(default)]
    pub avatar_url: Option<String>,
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
    /// Per-participant soft delete: canonical participant id -> RFC3339 time the participant deleted
    /// ("moved to trash") the conversation. Only that participant's view is affected. Absent for
    /// records written before this field existed.
    #[serde(default)]
    pub deleted_by: std::collections::BTreeMap<String, String>,
    /// Participants who asked for an immediate purge (skips the retention window for their share).
    #[serde(default)]
    pub purged_by: Vec<String>,
}

/// How long a soft-deleted conversation / message stays recoverable before the sweep removes it.
pub const SOFT_DELETE_RETENTION_SECS: i64 = 30 * 24 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Folder { Inbox, Trash, All }
impl Folder {
    pub fn parse(s: Option<&str>) -> Folder {
        match s.map(|x| x.trim().to_ascii_lowercase()).as_deref() { Some("trash") => Folder::Trash, Some("all") => Folder::All, _ => Folder::Inbox }
    }
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
    /// Soft delete (sender-initiated): hidden from listings, recoverable until the sweep.
    #[serde(default)]
    pub deleted_at: Option<String>,
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
        self.list_conversations_in_folder(wallet_id, extra_keys, Folder::Inbox)
    }

    /// Canonical identity of a participant: the registered wallet id when `pid` is a wallet id,
    /// signing key or encryption key of a registered wallet; otherwise the raw string.
    pub fn canonical_participant(&self, pid: &str) -> String {
        if let Ok(wallets) = self.list_wallets() {
            for w in &wallets {
                if w.id == pid || (!w.signing_public_key.is_empty() && w.signing_public_key == pid) || (!w.encryption_public_key.is_empty() && w.encryption_public_key == pid) {
                    return w.id.clone();
                }
            }
        }
        pid.to_string()
    }

    /// Deterministic id for a 1:1 conversation: `dm_` + hex(sha256(sorted canonical ids joined by "\n")).
    /// Order-independent, so either side creating the thread resolves to the same id. `None` for
    /// groups or anything that is not exactly two distinct participants.
    pub fn dm_conversation_id(&self, participant_ids: &[String], is_group: bool) -> Option<String> {
        if is_group { return None; }
        let mut ids: Vec<String> = participant_ids.iter().filter(|p| !p.is_empty()).map(|p| self.canonical_participant(p)).collect();
        ids.sort(); ids.dedup();
        if ids.len() != 2 { return None; }
        use sha2::Digest;
        Some(format!("dm_{}", hex::encode(sha2::Sha256::digest(ids.join("\n").as_bytes()))))
    }

    fn my_canonical_ids(&self, my_keys: &[String]) -> Vec<String> {
        let mut v: Vec<String> = my_keys.iter().map(|k| self.canonical_participant(k)).collect(); v.sort(); v.dedup(); v
    }
    fn deleted_for(&self, conv: &Conversation, my_keys: &[String]) -> bool {
        let mine = self.my_canonical_ids(my_keys);
        conv.deleted_by.keys().any(|k| mine.iter().any(|m| m == k) || my_keys.iter().any(|m| m == k))
    }

    /// `Inbox` = not deleted by me, `Trash` = deleted by me (still within retention), `All` = both.
    pub fn list_conversations_in_folder(&self, wallet_id: &str, extra_keys: &[&str], folder: Folder) -> Result<Vec<Conversation>, String> {
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
                let deleted = self.deleted_for(&conv, &my_keys);
                let keep = match folder { Folder::Inbox => !deleted, Folder::Trash => deleted, Folder::All => true };
                if keep { result.push(conv); }
            }
        }
        Ok(result)
    }

    /// Does this conversation include the caller (any of their identities), regardless of folder?
    pub fn conversation_has_participant(&self, conversation_id: &str, wallet_id: &str, extra_keys: &[&str]) -> Result<bool, String> {
        Ok(self.list_conversations_in_folder(wallet_id, extra_keys, Folder::All)?.iter().any(|c| c.id == conversation_id))
    }

    pub fn create_conversation(
        &self,
        created_by: &str,
        participant_ids: Vec<String>,
        name: Option<String>,
        is_group: bool,
    ) -> Result<Conversation, String> {
        self.create_or_get_conversation(created_by, participant_ids, name, is_group).map(|(c, _)| c)
    }

    /// Create a conversation. For a 1:1 (not a group, exactly two distinct participants) the id is
    /// deterministic and creation is an UPSERT: an existing thread for the pair is returned with
    /// `existing = true` (and un-trashed for the creator) instead of minting a duplicate. Groups keep
    /// random ids. Returns `(conversation, existing)`.
    pub fn create_or_get_conversation(
        &self,
        created_by: &str,
        participant_ids: Vec<String>,
        name: Option<String>,
        is_group: bool,
    ) -> Result<(Conversation, bool), String> {
        let tree = self.conversations_tree()?;
        let part_idx = self.participant_index_tree()?;
        if let Some(dm_id) = self.dm_conversation_id(&participant_ids, is_group) {
            if let Some(v) = tree.get(dm_id.as_bytes()).map_err(|e| e.to_string())? {
                let mut conv: Conversation = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
                // re-creating a thread you had trashed brings it back for you; the other side is untouched
                let me = self.canonical_participant(created_by);
                let before = conv.deleted_by.len();
                conv.deleted_by.retain(|k, _| *k != me && *k != created_by);
                conv.purged_by.retain(|k| *k != me && *k != created_by);
                // any participant key form not yet indexed (e.g. the other side used a different key form)
                for pid in &participant_ids {
                    if pid.is_empty() { continue; }
                    let key = format!("{}:{}", pid, conv.id);
                    if part_idx.get(key.as_bytes()).map_err(|e| e.to_string())?.is_none() { part_idx.insert(key.as_bytes(), b"").map_err(|e| e.to_string())?; }
                    if !conv.participant_ids.iter().any(|x| x == pid) && !conv.participant_ids.iter().any(|x| self.canonical_participant(x) == self.canonical_participant(pid)) { conv.participant_ids.push(pid.clone()); }
                }
                if before != conv.deleted_by.len() || true { let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?; tree.insert(conv.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?; }
                return Ok((conv, true));
            }
        }
        let conv = Conversation {
            id: self.dm_conversation_id(&participant_ids, is_group).unwrap_or_else(|| Uuid::new_v4().to_string()),
            created_by: created_by.to_string(),
            participant_ids: participant_ids.clone(),
            name,
            is_group,
            created_at: chrono::Utc::now().to_rfc3339(),
            deleted_by: Default::default(),
            purged_by: Vec::new(),
        };
        let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
        tree.insert(conv.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        for pid in &participant_ids {
            let key = format!("{}:{}", pid, conv.id);
            part_idx.insert(key.as_bytes(), b"").map_err(|e| e.to_string())?;
        }
        Ok((conv, false))
    }

    /// Soft delete for the CALLER only ("move to trash"). The other participants keep their copy.
    /// `purge` skips the retention window for the caller's share; the record and its messages are
    /// hard-removed only once every participant has deleted it (and each share is purged or expired).
    pub fn soft_delete_conversation(&self, conversation_id: &str, wallet_id: &str, extra_keys: &[&str], purge: bool) -> Result<Conversation, String> {
        let tree = self.conversations_tree()?;
        let mut conv: Conversation = match tree.get(conversation_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map_err(|e| e.to_string())?,
            None => return Err("Conversation not found".to_string()),
        };
        let my_keys = self.get_all_matching_ids(wallet_id, extra_keys);
        if !conv.participant_ids.iter().any(|p| my_keys.contains(p) || my_keys.contains(&self.canonical_participant(p))) { return Err("Not a participant".to_string()); }
        let me = self.canonical_participant(wallet_id);
        conv.deleted_by.entry(me.clone()).or_insert_with(|| chrono::Utc::now().to_rfc3339());
        if purge && !conv.purged_by.contains(&me) { conv.purged_by.push(me.clone()); }
        let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
        tree.insert(conversation_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        if self.ready_for_hard_delete(&conv, chrono::Utc::now()) { self.delete_conversation(conversation_id)?; }
        Ok(conv)
    }

    /// Restore a conversation the caller had soft-deleted. Only the caller's view changes.
    pub fn restore_conversation(&self, conversation_id: &str, wallet_id: &str, extra_keys: &[&str]) -> Result<Conversation, String> {
        let tree = self.conversations_tree()?;
        let mut conv: Conversation = match tree.get(conversation_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map_err(|e| e.to_string())?,
            None => return Err("Conversation not found (already purged?)".to_string()),
        };
        let my_keys = self.get_all_matching_ids(wallet_id, extra_keys);
        let mine = self.my_canonical_ids(&my_keys);
        let before = conv.deleted_by.len();
        conv.deleted_by.retain(|k, _| !mine.contains(k) && !my_keys.contains(k));
        conv.purged_by.retain(|k| !mine.contains(k) && !my_keys.contains(k));
        if before == conv.deleted_by.len() { return Err("Conversation is not in your trash".to_string()); }
        let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
        tree.insert(conversation_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        Ok(conv)
    }

    /// All participants deleted, and every share is purged or older than the retention window.
    fn ready_for_hard_delete(&self, conv: &Conversation, now: chrono::DateTime<chrono::Utc>) -> bool {
        let mut parts: Vec<String> = conv.participant_ids.iter().map(|p| self.canonical_participant(p)).collect(); parts.sort(); parts.dedup();
        if parts.is_empty() { return false; }
        parts.iter().all(|p| match conv.deleted_by.get(p) {
            None => false,
            Some(ts) => conv.purged_by.contains(p) || chrono::DateTime::parse_from_rfc3339(ts).map(|t| now - t.with_timezone(&chrono::Utc) >= chrono::Duration::seconds(SOFT_DELETE_RETENTION_SECS)).unwrap_or(false),
        })
    }

    /// Periodic sweep: hard-delete conversations whose every participant deleted them past the
    /// retention window (or purged), and messages soft-deleted past the window. Returns (conversations, messages).
    pub fn sweep_soft_deleted(&self, now: chrono::DateTime<chrono::Utc>) -> Result<(usize, usize), String> {
        let tree = self.conversations_tree()?;
        let mut convs = Vec::new();
        for entry in tree.iter() {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let conv: Conversation = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            if !conv.deleted_by.is_empty() && self.ready_for_hard_delete(&conv, now) { convs.push(conv.id.clone()); }
        }
        for id in &convs { self.delete_conversation(id)?; }
        let msg_tree = self.messages_tree()?; let conv_msg_idx = self.conv_msg_index_tree()?;
        let mut msgs = Vec::new();
        for entry in msg_tree.iter() {
            let (k, v) = entry.map_err(|e| e.to_string())?;
            let msg: MessengerMessage = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
            if let Some(ts) = &msg.deleted_at {
                if chrono::DateTime::parse_from_rfc3339(ts).map(|t| now - t.with_timezone(&chrono::Utc) >= chrono::Duration::seconds(SOFT_DELETE_RETENTION_SECS)).unwrap_or(false) {
                    msgs.push((k.to_vec(), format!("{}:{}", msg.conversation_id, msg.created_at)));
                }
            }
        }
        for (k, idx) in &msgs { let _ = msg_tree.remove(k); let _ = conv_msg_idx.remove(idx.as_bytes()); }
        Ok((convs.len(), msgs.len()))
    }

    /// Fetch a single conversation by id (for e.g. resolving push-notification recipients).
    pub fn get_conversation(&self, conversation_id: &str) -> Result<Option<Conversation>, String> {
        let tree = self.conversations_tree()?;
        match tree.get(conversation_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => Ok(Some(serde_json::from_slice(&v).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    /// Set (or clear, with `None`) a conversation's name. Returns the updated conversation,
    /// or `None` if it doesn't exist.
    pub fn rename_conversation(&self, conversation_id: &str, name: Option<String>) -> Result<Option<Conversation>, String> {
        let tree = self.conversations_tree()?;
        let mut conv: Conversation = match tree.get(conversation_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map_err(|e| e.to_string())?,
            None => return Ok(None),
        };
        conv.name = name;
        let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
        tree.insert(conversation_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        Ok(Some(conv))
    }

    /// Add participants to a conversation (deduped, skips existing). CRUCIAL: also writes the
    /// participant index (`{pid}:{conv_id}`) so the new members' conversation lists include this
    /// chat — membership is driven by that index, not by `participant_ids` alone. Returns the
    /// updated conversation, or `None` if it doesn't exist.
    pub fn add_participants(&self, conversation_id: &str, new_ids: &[String]) -> Result<Option<Conversation>, String> {
        let tree = self.conversations_tree()?;
        let mut conv: Conversation = match tree.get(conversation_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map_err(|e| e.to_string())?,
            None => return Ok(None),
        };
        let part_idx = self.participant_index_tree()?;
        for pid in new_ids {
            if pid.is_empty() || conv.participant_ids.iter().any(|x| x == pid) {
                continue;
            }
            conv.participant_ids.push(pid.clone());
            let key = format!("{}:{}", pid, conversation_id);
            part_idx.insert(key.as_bytes(), b"").map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec(&conv).map_err(|e| e.to_string())?;
        tree.insert(conversation_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        Ok(Some(conv))
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
        self.list_messages_in_folder(conversation_id, Folder::Inbox)
    }

    pub fn list_messages_in_folder(&self, conversation_id: &str, folder: Folder) -> Result<Vec<MessengerMessage>, String> {
        let conv_msg_idx = self.conv_msg_index_tree()?;
        let msg_tree = self.messages_tree()?;
        let prefix = format!("{}:", conversation_id);
        let mut messages = Vec::new();
        for entry in conv_msg_idx.scan_prefix(prefix.as_bytes()) {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let mid = String::from_utf8_lossy(&v);
            if let Some(msg_bytes) = msg_tree.get(mid.as_bytes()).map_err(|e| e.to_string())? {
                let msg: MessengerMessage = serde_json::from_slice(&msg_bytes).map_err(|e| e.to_string())?;
                let deleted = msg.deleted_at.is_some();
                let keep = match folder { Folder::Inbox => !deleted, Folder::Trash => deleted, Folder::All => true };
                if keep { messages.push(msg); }
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

    /// Soft delete: the message is hidden from listings and recoverable until the sweep.
    pub fn delete_message(&self, message_id: &str) -> Result<(), String> {
        let msg_tree = self.messages_tree()?;
        let mut msg: MessengerMessage = match msg_tree.get(message_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map_err(|e| e.to_string())?,
            None => return Err("Message not found".to_string()),
        };
        if msg.deleted_at.is_none() { msg.deleted_at = Some(chrono::Utc::now().to_rfc3339()); }
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        msg_tree.insert(message_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn restore_message(&self, message_id: &str) -> Result<MessengerMessage, String> {
        let msg_tree = self.messages_tree()?;
        let mut msg: MessengerMessage = match msg_tree.get(message_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map_err(|e| e.to_string())?,
            None => return Err("Message not found (already purged?)".to_string()),
        };
        if msg.deleted_at.is_none() { return Err("Message is not deleted".to_string()); }
        msg.deleted_at = None;
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        msg_tree.insert(message_id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        Ok(msg)
    }

    /// Immediate, irreversible removal of one message (kept for the sweep and admin paths).
    pub fn hard_delete_message(&self, message_id: &str) -> Result<(), String> {
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
        self.list_conversations_with_activity_in(wallet_id, extra_keys, Folder::Inbox)
    }

    pub fn list_conversations_with_activity_in(
        &self,
        wallet_id: &str,
        extra_keys: &[&str],
        folder: Folder,
    ) -> Result<Vec<serde_json::Value>, String> {
        let my_keys = self.get_all_matching_ids(wallet_id, extra_keys);
        let conversations = self.list_conversations_in_folder(wallet_id, extra_keys, folder)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> MessengerStore {
        static C: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("qv-msg-{}-{}-{}", std::process::id(), C.fetch_add(1, std::sync::atomic::Ordering::SeqCst), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let s = MessengerStore::new(&dir); s.init().unwrap(); s
    }
    fn wallet(s: &MessengerStore, id: &str) -> MessengerWallet {
        s.register_wallet(MessengerWallet { id: id.into(), display_name: id.into(), signing_public_key: format!("sig-{id}"), encryption_public_key: format!("enc-{id}"), created_at: "2026-09-25T00:00:00Z".into(), discoverable: true, avatar_url: None }).unwrap()
    }
    fn msg(conv: &str, sender: &str, at: &str) -> MessengerMessage {
        MessengerMessage { id: Uuid::new_v4().to_string(), conversation_id: conv.into(), sender_wallet_id: sender.into(), encrypted_content: "x".into(), signature: "s".into(), self_destruct: false, destruct_after_seconds: None, created_at: at.into(), is_read: false, read_at: None, message_type: "text".into(), spoiler: false, deleted_at: None }
    }

    #[test]
    fn one_to_one_ids_are_deterministic_order_independent_and_key_form_independent() {
        let s = store(); wallet(&s, "alice"); wallet(&s, "bob");
        let (a, e1) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], None, false).unwrap();
        let (b, e2) = s.create_or_get_conversation("bob", vec!["bob".into(), "alice".into()], None, false).unwrap();
        let (c, e3) = s.create_or_get_conversation("bob", vec!["sig-bob".into(), "enc-alice".into()], None, false).unwrap();
        assert!(a.id.starts_with("dm_") && a.id.len() == 3 + 64);
        assert_eq!(a.id, b.id); assert_eq!(a.id, c.id); assert!(!e1 && e2 && e3, "first create, then upserts");
        assert_eq!(s.conversations_tree().unwrap().len(), 1, "exactly one record");
        assert_eq!(s.list_conversations("alice").unwrap().len(), 1); assert_eq!(s.list_conversations("sig-bob").unwrap().len(), 1);
        // a different pair gets a different id; a group keeps a random id and is never deduped
        let (d, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "carol".into()], None, false).unwrap(); assert_ne!(d.id, a.id);
        let (g1, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], Some("grp".into()), true).unwrap();
        let (g2, e) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], Some("grp".into()), true).unwrap();
        assert_ne!(g1.id, g2.id); assert!(!e); assert!(!g1.id.starts_with("dm_"));
        let (t, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into(), "carol".into()], None, false).unwrap(); assert!(!t.id.starts_with("dm_"), "three participants is not a 1:1");
    }

    #[test]
    fn soft_delete_affects_only_the_caller_and_is_restorable() {
        let s = store(); wallet(&s, "alice"); wallet(&s, "bob");
        let (c, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], None, false).unwrap();
        s.add_message(msg(&c.id, "alice", "2026-09-25T00:00:01Z")).unwrap(); s.add_message(msg(&c.id, "bob", "2026-09-25T00:00:02Z")).unwrap();
        s.soft_delete_conversation(&c.id, "alice", &[], false).unwrap();
        assert!(s.list_conversations("alice").unwrap().is_empty(), "gone from alice's inbox");
        assert_eq!(s.list_conversations_in_folder("alice", &[], Folder::Trash).unwrap().len(), 1, "in alice's trash");
        assert_eq!(s.list_conversations("bob").unwrap().len(), 1, "bob still has it");
        assert_eq!(s.list_messages(&c.id).unwrap().len(), 2, "messages untouched");
        assert!(s.conversation_has_participant(&c.id, "alice", &[]).unwrap());
        // bob cannot restore alice's share; alice can
        assert!(s.restore_conversation(&c.id, "bob", &[]).is_err());
        s.restore_conversation(&c.id, "alice", &["sig-alice"]).unwrap();
        assert_eq!(s.list_conversations("alice").unwrap().len(), 1);
        // re-creating a trashed 1:1 also brings it back for the creator
        s.soft_delete_conversation(&c.id, "alice", &[], false).unwrap();
        let (again, existing) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], None, false).unwrap();
        assert!(existing && again.id == c.id && s.list_conversations("alice").unwrap().len() == 1);
    }

    #[test]
    fn hard_removal_only_after_everyone_deleted_and_retention_or_purge() {
        let s = store(); wallet(&s, "alice"); wallet(&s, "bob");
        let (c, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], None, false).unwrap();
        s.add_message(msg(&c.id, "alice", "2026-09-25T00:00:01Z")).unwrap();
        s.soft_delete_conversation(&c.id, "alice", &[], true).unwrap(); // alice purges her share
        assert!(s.get_conversation(&c.id).unwrap().is_some(), "bob has not deleted: record stays");
        let now = chrono::Utc::now();
        assert_eq!(s.sweep_soft_deleted(now).unwrap(), (0, 0));
        s.soft_delete_conversation(&c.id, "bob", &[], false).unwrap();
        assert!(s.get_conversation(&c.id).unwrap().is_some(), "bob's share is within retention");
        assert_eq!(s.sweep_soft_deleted(now).unwrap(), (0, 0));
        assert_eq!(s.sweep_soft_deleted(now + chrono::Duration::seconds(SOFT_DELETE_RETENTION_SECS + 1)).unwrap(), (1, 0));
        assert!(s.get_conversation(&c.id).unwrap().is_none()); assert!(s.list_messages_in_folder(&c.id, Folder::All).unwrap().is_empty(), "messages removed with the thread");
        // both purge ⇒ immediate
        let (d, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], None, false).unwrap();
        s.soft_delete_conversation(&d.id, "alice", &[], true).unwrap(); s.soft_delete_conversation(&d.id, "bob", &[], true).unwrap();
        assert!(s.get_conversation(&d.id).unwrap().is_none());
    }

    #[test]
    fn message_soft_delete_restore_and_sweep() {
        let s = store(); wallet(&s, "alice"); wallet(&s, "bob");
        let (c, _) = s.create_or_get_conversation("alice", vec!["alice".into(), "bob".into()], None, false).unwrap();
        let m = s.add_message(msg(&c.id, "alice", "2026-09-25T00:00:01Z")).unwrap();
        s.delete_message(&m.id).unwrap();
        assert!(s.list_messages(&c.id).unwrap().is_empty()); assert_eq!(s.list_messages_in_folder(&c.id, Folder::Trash).unwrap().len(), 1);
        s.restore_message(&m.id).unwrap(); assert_eq!(s.list_messages(&c.id).unwrap().len(), 1);
        s.delete_message(&m.id).unwrap();
        assert_eq!(s.sweep_soft_deleted(chrono::Utc::now()).unwrap(), (0, 0));
        assert_eq!(s.sweep_soft_deleted(chrono::Utc::now() + chrono::Duration::seconds(SOFT_DELETE_RETENTION_SECS + 1)).unwrap(), (0, 1));
        assert!(s.restore_message(&m.id).is_err(), "purged");
    }

    #[test]
    fn legacy_records_without_the_new_fields_still_load() {
        let s = store();
        let legacy = r#"{"id":"old-uuid","created_by":"alice","participant_ids":["alice","bob"],"name":null,"is_group":false,"created_at":"2026-01-01T00:00:00Z"}"#;
        s.conversations_tree().unwrap().insert(b"old-uuid", legacy.as_bytes()).unwrap();
        s.participant_index_tree().unwrap().insert(b"alice:old-uuid", b"").unwrap();
        let c = s.get_conversation("old-uuid").unwrap().unwrap(); assert!(c.deleted_by.is_empty() && c.purged_by.is_empty());
        assert_eq!(s.list_conversations("alice").unwrap().len(), 1);
        let m = r#"{"id":"m1","conversation_id":"old-uuid","sender_wallet_id":"alice","encrypted_content":"x","signature":"s","self_destruct":false,"destruct_after_seconds":null,"created_at":"2026-01-01T00:00:01Z","is_read":false}"#;
        s.messages_tree().unwrap().insert(b"m1", m.as_bytes()).unwrap(); s.conv_msg_index_tree().unwrap().insert(b"old-uuid:2026-01-01T00:00:01Z", b"m1").unwrap();
        assert_eq!(s.list_messages("old-uuid").unwrap().len(), 1);
    }
}
