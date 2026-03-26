use clap::{Parser, Subcommand};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_RPC: &str = "https://rougechain.rougee.app";

/// RougeChain CLI Wallet — Post-Quantum Secure
#[derive(Parser)]
#[command(name = "rougechain", version, about)]
struct Cli {
    /// RPC endpoint (default: mainnet)
    #[arg(long, default_value = DEFAULT_RPC, global = true)]
    rpc: String,

    /// Wallet directory (default: ~/.rougechain)
    #[arg(long, global = true)]
    wallet_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Generate a new ML-DSA-65 keypair
    KeyGen {
        /// Optional label for the key
        #[arg(long)]
        label: Option<String>,
    },
    /// List all saved keys
    Keys,
    /// Show the active key's public key and rouge1 address
    Whoami,
    /// Query chain balance for a public key
    Balance {
        /// Public key hex (omit to use active key)
        pubkey: Option<String>,
    },
    /// Query token balances
    TokenBalances {
        /// Public key hex (omit to use active key)
        pubkey: Option<String>,
    },
    /// Send a transfer transaction
    Transfer {
        /// Recipient public key hex
        to: String,
        /// Amount in XRGE
        amount: u64,
        /// Fee
        #[arg(long, default_value = "1")]
        fee: u64,
    },
    /// Stake XRGE to become a validator
    Stake {
        /// Amount to stake
        amount: u64,
    },
    /// Unstake XRGE (enters unbonding queue)
    Unstake {
        /// Amount to unstake
        amount: u64,
    },
    /// Get validator set
    Validators,
    /// Get chain stats
    Stats,
    /// Get block by height
    Block {
        /// Block height
        height: u64,
    },
    /// Get transaction receipt
    Receipt {
        /// Transaction hash
        hash: String,
    },
    /// Get governance proposals
    Proposals,
    /// Cast a governance vote
    Vote {
        /// Proposal ID
        proposal_id: String,
        /// Vote option: yes, no, abstain
        option: String,
    },
    /// Delegate voting power
    Delegate {
        /// Delegate's public key
        to: String,
    },
    /// List all tokens
    Tokens,
    /// List liquidity pools
    Pools,
    /// Get finality status
    Finality,
    /// Query indexer events by address
    History {
        /// Public key (omit to use active key)
        pubkey: Option<String>,
        /// Max results
        #[arg(long, default_value = "20")]
        limit: usize,
    },
    /// JSON-RPC 2.0 raw call
    Rpc {
        /// Method name
        method: String,
        /// JSON params (optional)
        params: Option<String>,
    },

    // ── Mail & Messenger ──

    /// Register a mail name (e.g., alice@rouge.quant)
    RegisterName {
        /// Name to register (e.g., "alice")
        name: String,
    },
    /// Release a mail name
    ReleaseName {
        /// Name to release
        name: String,
    },
    /// Resolve a name to wallet info
    ResolveName {
        /// Name to look up
        name: String,
    },
    /// Reverse lookup: wallet → name
    ReverseLookup {
        /// Public key (omit to use active key)
        pubkey: Option<String>,
    },
    /// Send encrypted mail
    SendMail {
        /// Recipient name (e.g., "bob") or public key
        to: String,
        /// Subject line
        #[arg(long)]
        subject: String,
        /// Message body
        #[arg(long)]
        body: String,
    },
    /// Get mail inbox
    Inbox,
    /// Get sent mail
    SentMail,
    /// Register messenger wallet on the node
    RegisterMessenger {
        /// Display name
        #[arg(long)]
        display_name: String,
    },
    /// List messenger conversations
    Conversations,
    /// Create a messenger conversation
    CreateConversation {
        /// Participant public keys (comma-separated)
        participants: String,
    },
    /// List messages in a conversation
    Messages {
        /// Conversation ID
        conversation_id: String,
    },
}

#[derive(Serialize, Deserialize)]
struct SavedKey {
    label: Option<String>,
    public_key_hex: String,
    secret_key_hex: String,
    created_at: String,
}

fn wallet_dir(custom: Option<PathBuf>) -> PathBuf {
    custom.unwrap_or_else(|| {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".rougechain")
    })
}

fn load_keys(dir: &PathBuf) -> Vec<SavedKey> {
    let path = dir.join("keys.json");
    if path.exists() {
        let data = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    }
}

fn save_keys(dir: &PathBuf, keys: &[SavedKey]) {
    std::fs::create_dir_all(dir).ok();
    let json = serde_json::to_string_pretty(keys).unwrap();
    std::fs::write(dir.join("keys.json"), json).ok();
}

fn active_key(dir: &PathBuf) -> Option<SavedKey> {
    let keys = load_keys(dir);
    keys.into_iter().next()
}

fn rpc_call(rpc: &str, method: &str, params: Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    });
    let resp = client.post(&format!("{}/rpc", rpc))
        .json(&body)
        .send()
        .map_err(|e| format!("RPC error: {}", e))?;
    let json: Value = resp.json().map_err(|e| format!("Parse error: {}", e))?;
    if let Some(err) = json.get("error") {
        Err(format!("RPC error: {}", err))
    } else {
        Ok(json.get("result").cloned().unwrap_or(Value::Null))
    }
}

fn api_get(rpc: &str, path: &str) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client.get(&format!("{}{}", rpc, path))
        .send()
        .map_err(|e| format!("API error: {}", e))?;
    resp.json().map_err(|e| format!("Parse error: {}", e))
}

fn api_post(rpc: &str, path: &str, body: Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client.post(&format!("{}{}", rpc, path))
        .json(&body)
        .send()
        .map_err(|e| format!("API error: {}", e))?;
    resp.json().map_err(|e| format!("Parse error: {}", e))
}

fn submit_tx(rpc: &str, dir: &PathBuf, tx_type: &str, payload: Value, fee: u64) -> Result<(), String> {
    let key = active_key(dir).ok_or("No keys found. Run: rougechain keygen")?;

    // Get nonce
    let nonce_result = rpc_call(rpc, "eth_getTransactionCount", serde_json::json!([&key.public_key_hex]))?;
    let nonce: u64 = if let Some(s) = nonce_result.as_str() {
        if let Some(hex) = s.strip_prefix("0x") {
            u64::from_str_radix(hex, 16).unwrap_or(0) + 1
        } else {
            s.parse().unwrap_or(1)
        }
    } else {
        1
    };

    // Build signed payload
    let mut tx_payload = payload.as_object().cloned().unwrap_or_default();
    let signed_data = serde_json::json!({
        "tx_type": tx_type,
        "from": key.public_key_hex,
        "nonce": nonce,
        "fee": fee,
        "payload": tx_payload,
    });
    let canonical = serde_json::to_string(&signed_data).unwrap();
    let sig = quantum_vault_crypto::pqc_sign(&key.secret_key_hex, canonical.as_bytes())
        .map_err(|e| format!("Sign error: {}", e))?;

    // Submit
    tx_payload.insert("signed_payload".to_string(), Value::String(canonical));
    let tx = serde_json::json!({
        "version": 1,
        "tx_type": tx_type,
        "from_pub_key": key.public_key_hex,
        "nonce": nonce,
        "payload": tx_payload,
        "fee": fee,
        "sig": sig,
    });

    let result = api_post(rpc, "/api/tx/v2/submit", tx)?;
    if result.get("error").is_some() {
        eprintln!("❌ {}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        println!("✅ Transaction submitted");
        if let Some(hash) = result.get("tx_hash") {
            println!("   Hash: {}", hash);
        }
    }
    Ok(())
}

fn generate_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn build_signed_request(key: &SavedKey, mut payload: serde_json::Map<String, Value>) -> Result<Value, String> {
    payload.insert("from".to_string(), Value::String(key.public_key_hex.clone()));
    payload.insert("timestamp".to_string(), serde_json::json!(timestamp_ms()));
    payload.insert("nonce".to_string(), Value::String(generate_nonce()));

    let payload_value = Value::Object(payload);
    let canonical = sorted_json(&payload_value);
    let sig = quantum_vault_crypto::pqc_sign(&key.secret_key_hex, canonical.as_bytes())
        .map_err(|e| format!("Sign error: {}", e))?;

    Ok(serde_json::json!({
        "payload": payload_value,
        "signature": sig,
        "public_key": key.public_key_hex,
    }))
}

fn sorted_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let entries: Vec<String> = keys.iter().map(|k| {
                format!("{}:{}", serde_json::to_string(*k).unwrap(), sorted_json(&map[*k]))
            }).collect();
            format!("{{{}}}", entries.join(","))
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(|v| sorted_json(v)).collect();
            format!("[{}]", items.join(","))
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}

fn submit_signed(rpc: &str, path: &str, req: Value) -> Result<Value, String> {
    let result = api_post(rpc, path, req)?;
    if let Some(err) = result.get("error") {
        Err(format!("{}", err.as_str().unwrap_or(&err.to_string())))
    } else {
        Ok(result)
    }
}

fn main() {
    let cli = Cli::parse();
    let dir = wallet_dir(cli.wallet_dir.clone());
    let rpc = &cli.rpc;

    match cli.command {
        Commands::KeyGen { label } => {
            let keypair = quantum_vault_crypto::pqc_keygen();
            let key = SavedKey {
                label: label.clone(),
                public_key_hex: keypair.public_key_hex.clone(),
                secret_key_hex: keypair.secret_key_hex,
                created_at: "now".to_string(),
            };
            let mut keys = load_keys(&dir);
            keys.push(key);
            save_keys(&dir, &keys);
            println!("🔐 New ML-DSA-65 keypair generated");
            println!("   Label:  {}", label.unwrap_or("(none)".into()));
            println!("   PubKey: {}...{}", &keypair.public_key_hex[..16], &keypair.public_key_hex[keypair.public_key_hex.len()-16..]);
            println!("   Saved to: {}", dir.display());
        }

        Commands::Keys => {
            let keys = load_keys(&dir);
            if keys.is_empty() {
                println!("No keys found. Run: rougechain keygen");
                return;
            }
            for (i, k) in keys.iter().enumerate() {
                println!("#{} {} — {}...{}", i, k.label.as_deref().unwrap_or("(unlabeled)"),
                    &k.public_key_hex[..16], &k.public_key_hex[k.public_key_hex.len()-16..]);
            }
        }

        Commands::Whoami => {
            match active_key(&dir) {
                Some(k) => {
                    println!("PubKey:  {}...{}", &k.public_key_hex[..16], &k.public_key_hex[k.public_key_hex.len()-16..]);
                    println!("Label:   {}", k.label.as_deref().unwrap_or("(none)"));
                    let hash_bytes = quantum_vault_crypto::sha256(k.public_key_hex.as_bytes());
                    let hash = hex::encode(&hash_bytes);
                    println!("Address: rouge1{}", &hash[..40]);
                }
                None => println!("No keys found. Run: rougechain keygen"),
            }
        }

        Commands::Balance { pubkey } => {
            let pk = pubkey.unwrap_or_else(|| active_key(&dir).map(|k| k.public_key_hex).unwrap_or_default());
            if pk.is_empty() { eprintln!("No key specified"); return; }
            match rpc_call(rpc, "eth_getBalance", serde_json::json!([pk])) {
                Ok(v) => println!("Balance: {} (raw hex)", v),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::TokenBalances { pubkey } => {
            let pk = pubkey.unwrap_or_else(|| active_key(&dir).map(|k| k.public_key_hex).unwrap_or_default());
            match rpc_call(rpc, "rouge_getAllTokenBalances", serde_json::json!([pk])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Transfer { to, amount, fee } => {
            let payload = serde_json::json!({
                "to_pub_key_hex": to,
                "amount": amount,
            });
            if let Err(e) = submit_tx(rpc, &dir, "transfer", payload, fee) {
                eprintln!("Error: {}", e);
            }
        }

        Commands::Stake { amount } => {
            let payload = serde_json::json!({"amount": amount});
            if let Err(e) = submit_tx(rpc, &dir, "stake", payload, 1) {
                eprintln!("Error: {}", e);
            }
        }

        Commands::Unstake { amount } => {
            let payload = serde_json::json!({"amount": amount});
            if let Err(e) = submit_tx(rpc, &dir, "unstake", payload, 1) {
                eprintln!("Error: {}", e);
            }
        }

        Commands::Validators => {
            match rpc_call(rpc, "rouge_getValidators", Value::Array(vec![])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Stats => {
            match rpc_call(rpc, "rouge_getStats", Value::Array(vec![])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Block { height } => {
            match rpc_call(rpc, "eth_getBlockByNumber", serde_json::json!([height])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Receipt { hash } => {
            match rpc_call(rpc, "eth_getTransactionReceipt", serde_json::json!([hash])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Proposals => {
            match rpc_call(rpc, "rouge_getProposals", Value::Array(vec![])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Vote { proposal_id, option } => {
            let payload = serde_json::json!({
                "proposal_id": proposal_id,
                "vote_option": option,
            });
            if let Err(e) = submit_tx(rpc, &dir, "cast_vote", payload, 1) {
                eprintln!("Error: {}", e);
            }
        }

        Commands::Delegate { to } => {
            let payload = serde_json::json!({"to_pub_key_hex": to});
            if let Err(e) = submit_tx(rpc, &dir, "delegate", payload, 1) {
                eprintln!("Error: {}", e);
            }
        }

        Commands::Tokens => {
            match rpc_call(rpc, "rouge_getTokens", Value::Array(vec![])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Pools => {
            match rpc_call(rpc, "rouge_getPools", Value::Array(vec![])) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Finality => {
            match api_get(rpc, "/api/finality/0") {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::History { pubkey, limit } => {
            let pk = pubkey.unwrap_or_else(|| active_key(&dir).map(|k| k.public_key_hex).unwrap_or_default());
            match api_get(rpc, &format!("/api/indexer/address/{}?limit={}", pk, limit)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Rpc { method, params } => {
            let p: Value = params.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Array(vec![]));
            match rpc_call(rpc, &method, p) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        // ── Name Registry ──

        Commands::RegisterName { name } => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("name".to_string(), Value::String(name.clone()));
            payload.insert("walletId".to_string(), Value::String(key.public_key_hex.clone()));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/names/register", req)) {
                Ok(v) => {
                    println!("Registered: {}@rouge.quant", name);
                    if let Some(entry) = v.get("entry") {
                        println!("{}", serde_json::to_string_pretty(entry).unwrap());
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::ReleaseName { name } => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("name".to_string(), Value::String(name.clone()));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/names/release", req)) {
                Ok(_) => println!("Released: {}", name),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::ResolveName { name } => {
            match api_get(rpc, &format!("/api/names/resolve/{}", name)) {
                Ok(v) => {
                    if v.get("success").and_then(|s| s.as_bool()) == Some(true) {
                        if let Some(entry) = v.get("entry") {
                            println!("Name:      {}", entry.get("name").and_then(|n| n.as_str()).unwrap_or("?"));
                            println!("Wallet:    {}", entry.get("wallet_id").and_then(|w| w.as_str()).unwrap_or("?"));
                        }
                        if let Some(wallet) = v.get("wallet") {
                            if let Some(enc) = wallet.get("encryption_public_key").and_then(|e| e.as_str()) {
                                println!("Enc Key:   {}...{}", &enc[..16], &enc[enc.len()-16..]);
                            }
                        }
                    } else {
                        println!("Name '{}' not found", name);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::ReverseLookup { pubkey } => {
            let pk = pubkey.unwrap_or_else(|| active_key(&dir).map(|k| k.public_key_hex).unwrap_or_default());
            if pk.is_empty() { eprintln!("No key specified"); return; }
            match api_get(rpc, &format!("/api/names/reverse/{}", pk)) {
                Ok(v) => {
                    if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                        println!("{}@rouge.quant", name);
                    } else {
                        println!("No name registered for this wallet");
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        // ── Mail ──

        Commands::SendMail { to, subject, body } => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("to".to_string(), Value::String(to.clone()));
            payload.insert("subject".to_string(), Value::String(subject));
            payload.insert("body".to_string(), Value::String(body));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/mail/send", req)) {
                Ok(v) => {
                    println!("Mail sent to {}", to);
                    if let Some(id) = v.get("id") {
                        println!("   ID: {}", id);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Inbox => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("folder".to_string(), Value::String("inbox".to_string()));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/mail/folder", req)) {
                Ok(v) => {
                    if let Some(mail) = v.get("mail").and_then(|m| m.as_array()) {
                        if mail.is_empty() {
                            println!("Inbox empty");
                        } else {
                            for m in mail {
                                let from = m.get("from").and_then(|f| f.as_str()).unwrap_or("?");
                                let ts = m.get("timestamp").and_then(|t| t.as_u64()).unwrap_or(0);
                                let read = m.get("read").and_then(|r| r.as_bool()).unwrap_or(false);
                                let id = m.get("id").and_then(|i| i.as_str()).unwrap_or("?");
                                println!("{} {} from: {} ({})", if read { " " } else { "*" }, id, from, ts);
                            }
                        }
                    } else {
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::SentMail => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("folder".to_string(), Value::String("sent".to_string()));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/mail/folder", req)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        // ── Messenger ──

        Commands::RegisterMessenger { display_name } => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("id".to_string(), Value::String(key.public_key_hex.clone()));
            payload.insert("displayName".to_string(), Value::String(display_name.clone()));
            payload.insert("signingPublicKey".to_string(), Value::String(key.public_key_hex.clone()));
            payload.insert("encryptionPublicKey".to_string(), Value::String(String::new()));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/messenger/wallets/register", req)) {
                Ok(_) => println!("Messenger wallet registered as '{}'", display_name),
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Conversations => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let payload = serde_json::Map::new();
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/messenger/conversations/list", req)) {
                Ok(v) => {
                    if let Some(convos) = v.get("conversations").and_then(|c| c.as_array()) {
                        if convos.is_empty() {
                            println!("No conversations");
                        } else {
                            for c in convos {
                                let id = c.get("conversationId").and_then(|i| i.as_str()).unwrap_or("?");
                                let participants: Vec<&str> = c.get("participants")
                                    .and_then(|p| p.as_array())
                                    .map(|arr| arr.iter().filter_map(|p| p.get("displayName").and_then(|n| n.as_str())).collect())
                                    .unwrap_or_default();
                                println!("{} — {}", id, participants.join(", "));
                            }
                        }
                    } else {
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::CreateConversation { participants } => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let parts: Vec<Value> = participants.split(',').map(|s| Value::String(s.trim().to_string())).collect();
            let mut payload = serde_json::Map::new();
            payload.insert("participants".to_string(), Value::Array(parts));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/messenger/conversations", req)) {
                Ok(v) => {
                    if let Some(id) = v.get("conversationId").and_then(|i| i.as_str()) {
                        println!("Conversation created: {}", id);
                    } else {
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }

        Commands::Messages { conversation_id } => {
            let key = match active_key(&dir) { Some(k) => k, None => { eprintln!("No keys found. Run: rougechain keygen"); return; } };
            let mut payload = serde_json::Map::new();
            payload.insert("conversationId".to_string(), Value::String(conversation_id));
            match build_signed_request(&key, payload).and_then(|req| submit_signed(rpc, "/api/v2/messenger/messages/list", req)) {
                Ok(v) => {
                    if let Some(msgs) = v.get("messages").and_then(|m| m.as_array()) {
                        if msgs.is_empty() {
                            println!("No messages");
                        } else {
                            for m in msgs {
                                let sender = m.get("senderDisplayName").and_then(|s| s.as_str()).unwrap_or("?");
                                let ts = m.get("timestamp").and_then(|t| t.as_u64()).unwrap_or(0);
                                let encrypted = m.get("encrypted").is_some();
                                println!("[{}] {} — {}", ts, sender, if encrypted { "(encrypted)" } else { "(empty)" });
                            }
                        }
                    } else {
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
    }
}
