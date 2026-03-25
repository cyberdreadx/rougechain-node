use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

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
    }
}
