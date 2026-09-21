//! Bitcoin bridge verification: BTC → qBTC (deposit) and qBTC → BTC payout verification.
//!
//! Unlike the EVM bridges, Bitcoin has no event logs and no EVM signatures, so none of the
//! `eth_getLogs` / ECDSA machinery applies. Two design choices make the BTC path safe:
//!
//!   1. **Recipient binding via OP_RETURN.** A depositor writes their RougeChain (ML-DSA)
//!      recipient address into an `OP_RETURN` output of the very transaction that funds
//!      custody. The binding is therefore baked into a signed Bitcoin transaction — a third
//!      party who merely learns the txid cannot redirect the mint. This adds no new key
//!      material (no xpub, no HD derivation), which also keeps the quantum attack surface
//!      minimal: the only post-quantum-relevant identity on the wire is the RougeChain
//!      address, written in the clear.
//!
//!   2. **Two-provider cross-check.** Every deposit is verified against TWO independent
//!      Esplora providers (mempool.space + blockstream.info by default). Both must agree on
//!      the custody amount and the recipient and both must show the required confirmation
//!      depth, so no single compromised/rate-limited API can fabricate a deposit and mint
//!      unbacked qBTC. If a provider is unreachable we fail CLOSED (the claim is idempotent
//!      and pollable, so a provider outage only delays, never loses funds).
//!
//! The daemon holds NO Bitcoin private key for deposits — custody is watch-only here. The hot
//! key lives only in the external BTC relayer, which pays withdrawals out; the daemon then
//! verifies that payout on the Bitcoin chain before marking a withdrawal fulfilled.

use serde::Deserialize;

/// qBTC uses 8 decimals: one on-chain unit == one satoshi (Bitcoin's own precision).
pub const QBTC_SYMBOL: &str = "qBTC";

/// A verified BTC deposit into custody, derived from on-chain data.
#[derive(Debug, Clone)]
pub struct BtcDeposit {
    /// Total satoshis paid to the custody address in this transaction.
    pub sats: u64,
    /// Raw recipient string decoded from the deposit's OP_RETURN (not yet normalized).
    pub recipient: String,
    /// Confirmation depth as reported by the primary provider.
    pub confirmations: u64,
}

// ── Esplora response shapes (mempool.space & blockstream.info share this schema) ──

#[derive(Deserialize)]
struct EsploraVout {
    scriptpubkey: String,
    #[serde(default)]
    scriptpubkey_address: Option<String>,
    #[serde(default)]
    scriptpubkey_type: Option<String>,
    value: u64,
}

#[derive(Deserialize)]
struct EsploraPrevout {
    #[serde(default)]
    scriptpubkey_address: Option<String>,
}

#[derive(Deserialize)]
struct EsploraVin {
    #[serde(default)]
    prevout: Option<EsploraPrevout>,
}

#[derive(Deserialize)]
struct EsploraStatus {
    #[serde(default)]
    confirmed: bool,
    #[serde(default)]
    block_height: Option<u64>,
}

#[derive(Deserialize)]
struct EsploraTx {
    #[serde(default)]
    txid: String,
    #[serde(default)]
    vin: Vec<EsploraVin>,
    #[serde(default)]
    vout: Vec<EsploraVout>,
    status: EsploraStatus,
}

/// A deposit output paying a watched HD deposit address.
#[derive(Debug, Clone)]
pub struct AddressDeposit {
    pub txid: String,
    pub vout: u32,
    pub sats: u64,
    pub confirmations: u64,
}

// ── Configuration ──

/// Custody BTC address to watch for deposits. From `QV_BRIDGE_BTC_CUSTODY`. Empty/unset
/// disables the BTC bridge (fail-closed). This is a *watch-only* address here — the daemon
/// never needs its private key.
pub fn btc_custody_address() -> Option<String> {
    let a = std::env::var("QV_BRIDGE_BTC_CUSTODY").ok()?.trim().to_string();
    if a.is_empty() {
        None
    } else {
        Some(a)
    }
}

/// Bitcoin network: "mainnet" (default) or "testnet". From `QV_BRIDGE_BTC_NETWORK`.
pub fn btc_network() -> String {
    std::env::var("QV_BRIDGE_BTC_NETWORK")
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s == "mainnet" || s == "testnet")
        .unwrap_or_else(|| "mainnet".to_string())
}

/// Minimum Bitcoin confirmations before a deposit or payout is honored. From
/// `QV_BRIDGE_BTC_MIN_CONFIRMATIONS`, default 2 (~20 min). Raise for larger flows.
pub fn btc_min_confirmations() -> u64 {
    std::env::var("QV_BRIDGE_BTC_MIN_CONFIRMATIONS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(2)
}

/// When true, a deposit may be honored on the primary provider alone if the secondary is
/// unreachable. Default false (safer). From `QV_BTC_ALLOW_SINGLE_PROVIDER`.
fn allow_single_provider() -> bool {
    std::env::var("QV_BTC_ALLOW_SINGLE_PROVIDER").map(|v| v == "true").unwrap_or(false)
}

/// The Esplora API bases to cross-check, primary first. Overridable via
/// `QV_BTC_ESPLORA_PRIMARY` / `QV_BTC_ESPLORA_SECONDARY`; network-aware defaults otherwise.
fn esplora_bases() -> Vec<String> {
    let (d1, d2) = if btc_network() == "testnet" {
        ("https://mempool.space/testnet/api", "https://blockstream.info/testnet/api")
    } else {
        ("https://mempool.space/api", "https://blockstream.info/api")
    };
    let clean = |s: String| s.trim().trim_end_matches('/').to_string();
    let primary = std::env::var("QV_BTC_ESPLORA_PRIMARY")
        .ok()
        .map(clean)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| d1.to_string());
    let secondary = std::env::var("QV_BTC_ESPLORA_SECONDARY")
        .ok()
        .map(clean)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| d2.to_string());
    vec![primary, secondary]
}

// ── HTTP ──

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        // A real UA avoids the default-agent rate-limiting some public Esplora hosts apply.
        .user_agent("RougeChain-bridge/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn fetch_tx(client: &reqwest::Client, base: &str, txid: &str) -> Result<EsploraTx, String> {
    let url = format!("{}/tx/{}", base, txid);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("esplora {} unreachable: {}", base, e))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("transaction not yet seen by {} (not broadcast/indexed?)", base));
    }
    if !resp.status().is_success() {
        return Err(format!("esplora {} returned HTTP {}", base, resp.status()));
    }
    resp.json::<EsploraTx>()
        .await
        .map_err(|e| format!("bad tx JSON from {}: {}", base, e))
}

async fn fetch_tip(client: &reqwest::Client, base: &str) -> Result<u64, String> {
    let url = format!("{}/blocks/tip/height", base);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("esplora {} unreachable: {}", base, e))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    text.trim()
        .parse::<u64>()
        .map_err(|e| format!("bad tip height from {}: {}", base, e))
}

async fn fetch_address_txs(
    client: &reqwest::Client,
    base: &str,
    address: &str,
) -> Result<Vec<EsploraTx>, String> {
    let url = format!("{}/address/{}/txs", base, address);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("esplora {} unreachable: {}", base, e))?;
    if !resp.status().is_success() {
        return Err(format!("esplora {} returned HTTP {}", base, resp.status()));
    }
    resp.json::<Vec<EsploraTx>>()
        .await
        .map_err(|e| format!("bad address-txs JSON from {}: {}", base, e))
}

/// Collect the confirmed deposit outputs paying `address` from one provider's tx list.
fn address_deposits_from(txs: &[EsploraTx], address: &str, tip: u64) -> Vec<AddressDeposit> {
    let mut out = Vec::new();
    for tx in txs {
        if !tx.status.confirmed {
            continue;
        }
        let bh = match tx.status.block_height {
            Some(b) => b,
            None => continue,
        };
        let confirmations = tip.saturating_sub(bh).saturating_add(1);
        for (i, v) in tx.vout.iter().enumerate() {
            if v.scriptpubkey_address.as_deref() == Some(address) && v.value > 0 {
                out.push(AddressDeposit {
                    txid: tx.txid.clone(),
                    vout: i as u32,
                    sats: v.value,
                    confirmations,
                });
            }
        }
    }
    out
}

/// Scan a watched HD deposit address for confirmed deposits, cross-checked across two providers.
/// A deposit is returned only if BOTH providers report the same (txid, vout, value) AND it meets
/// the confirmation depth. Fails closed if the second provider is unreachable (unless
/// QV_BTC_ALLOW_SINGLE_PROVIDER=true) — the watcher simply retries next cycle, so a provider
/// outage delays credit but never mints on a single unverified source.
pub async fn scan_btc_address_deposits(address: &str) -> Result<Vec<AddressDeposit>, String> {
    let min_conf = btc_min_confirmations();
    let bases = esplora_bases();
    let client = http_client();

    let tip1 = fetch_tip(&client, &bases[0]).await?;
    let txs1 = fetch_address_txs(&client, &bases[0], address).await?;
    let primary = address_deposits_from(&txs1, address, tip1);
    if primary.is_empty() {
        return Ok(vec![]);
    }

    // Set of (txid, vout, value) the secondary provider also confirms.
    let agreed: std::collections::HashSet<(String, u32, u64)> = if let Some(sec) = bases.get(1) {
        match async {
            let tip2 = fetch_tip(&client, sec).await?;
            let txs2 = fetch_address_txs(&client, sec, address).await?;
            Ok::<_, String>(address_deposits_from(&txs2, address, tip2))
        }
        .await
        {
            Ok(sec_deps) => sec_deps.into_iter().map(|d| (d.txid, d.vout, d.sats)).collect(),
            Err(_) => {
                if allow_single_provider() {
                    primary.iter().map(|d| (d.txid.clone(), d.vout, d.sats)).collect()
                } else {
                    return Err("second Esplora provider unavailable for address scan".to_string());
                }
            }
        }
    } else {
        primary.iter().map(|d| (d.txid.clone(), d.vout, d.sats)).collect()
    };

    Ok(primary
        .into_iter()
        .filter(|d| {
            d.confirmations >= min_conf && agreed.contains(&(d.txid.clone(), d.vout, d.sats))
        })
        .collect())
}

// ── Script parsing ──

fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    let s = s.trim().trim_start_matches("0x");
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Extract the pushed data bytes from an `OP_RETURN` scriptPubKey (hex). Returns None if the
/// script is not an OP_RETURN. Handles direct pushes (0x01–0x4b), OP_PUSHDATA1 (0x4c) and
/// OP_PUSHDATA2 (0x4d) — more than enough for the ≤80-byte OP_RETURN relay limit.
fn parse_op_return(scriptpubkey_hex: &str) -> Option<Vec<u8>> {
    let bytes = hex_to_bytes(scriptpubkey_hex)?;
    if bytes.first() != Some(&0x6a) {
        return None;
    }
    let mut i = 1usize;
    let op = *bytes.get(i)?;
    i += 1;
    let len = if op <= 0x4b {
        op as usize
    } else if op == 0x4c {
        let l = *bytes.get(i)? as usize;
        i += 1;
        l
    } else if op == 0x4d {
        let lo = *bytes.get(i)? as usize;
        let hi = *bytes.get(i + 1)? as usize;
        i += 2;
        lo | (hi << 8)
    } else {
        return None;
    };
    let end = i.checked_add(len)?;
    if end > bytes.len() {
        return None;
    }
    Some(bytes[i..end].to_vec())
}

/// Reduce one Esplora transaction to (custody sats, OP_RETURN recipient, confirmations).
fn parse_deposit(tx: &EsploraTx, custody: &str, tip: u64) -> Result<BtcDeposit, String> {
    if !tx.status.confirmed {
        return Err("deposit is still unconfirmed (0 confirmations)".to_string());
    }
    let block_height = tx
        .status
        .block_height
        .ok_or("confirmed deposit is missing a block height")?;
    let confirmations = tip.saturating_sub(block_height).saturating_add(1);

    let mut sats: u64 = 0;
    let mut recipient: Option<String> = None;
    for vout in &tx.vout {
        if vout.scriptpubkey_address.as_deref() == Some(custody) {
            sats = sats.saturating_add(vout.value);
        }
        if recipient.is_none() {
            let is_op_return = vout.scriptpubkey_type.as_deref() == Some("op_return")
                || vout.scriptpubkey.starts_with("6a");
            if is_op_return {
                if let Some(data) = parse_op_return(&vout.scriptpubkey) {
                    if let Ok(s) = String::from_utf8(data) {
                        let s = s.trim().to_string();
                        if !s.is_empty() {
                            recipient = Some(s);
                        }
                    }
                }
            }
        }
    }
    if sats == 0 {
        return Err(format!("no output pays the custody address {}", custody));
    }
    let recipient = recipient
        .ok_or("deposit has no OP_RETURN carrying a RougeChain recipient address")?;
    Ok(BtcDeposit { sats, recipient, confirmations })
}

// ── Public verification entry points ──

fn valid_txid(txid: &str) -> bool {
    txid.len() == 64 && txid.chars().all(|c| c.is_ascii_hexdigit())
}

/// Verify a BTC → qBTC deposit. Cross-checks two Esplora providers: the primary must fully
/// verify (custody output, OP_RETURN recipient, confirmation depth); the secondary must AGREE
/// on amount + recipient and also meet the depth. Fails closed when a provider is unreachable
/// (unless `QV_BTC_ALLOW_SINGLE_PROVIDER=true`). Returns the amount + recipient to mint.
pub async fn verify_btc_deposit(txid: &str, custody: &str) -> Result<BtcDeposit, String> {
    let txid = txid.trim().trim_start_matches("0x").to_lowercase();
    if !valid_txid(&txid) {
        return Err("invalid BTC txid (expected 64 hex chars)".to_string());
    }
    let min_conf = btc_min_confirmations();
    let bases = esplora_bases();
    let client = http_client();

    // Primary provider — must fully verify.
    let primary = &bases[0];
    let tip1 = fetch_tip(&client, primary).await?;
    let tx1 = fetch_tx(&client, primary, &txid).await?;
    let dep1 = parse_deposit(&tx1, custody, tip1)?;
    if dep1.confirmations < min_conf {
        return Err(format!(
            "deposit has {} confirmation(s); {} required",
            dep1.confirmations, min_conf
        ));
    }

    // Secondary provider — cross-check to defeat a single lying/stale source.
    if let Some(secondary) = bases.get(1) {
        let second = async {
            let tip2 = fetch_tip(&client, secondary).await?;
            let tx2 = fetch_tx(&client, secondary, &txid).await?;
            parse_deposit(&tx2, custody, tip2)
        }
        .await;
        match second {
            Ok(dep2) => {
                if dep2.sats != dep1.sats {
                    return Err(format!(
                        "provider disagreement on amount ({} vs {} sats) — refusing to mint",
                        dep1.sats, dep2.sats
                    ));
                }
                if dep2.recipient.trim() != dep1.recipient.trim() {
                    return Err("provider disagreement on recipient — refusing to mint".to_string());
                }
                if dep2.confirmations < min_conf {
                    return Err(format!(
                        "second provider shows only {} confirmation(s); {} required",
                        dep2.confirmations, min_conf
                    ));
                }
            }
            Err(e) => {
                if !allow_single_provider() {
                    return Err(format!(
                        "second Esplora provider could not confirm the deposit ({}). \
                         Refusing to mint on a single source — retry shortly, or set \
                         QV_BTC_ALLOW_SINGLE_PROVIDER=true to accept one provider.",
                        e
                    ));
                }
            }
        }
    }

    Ok(dep1)
}

/// Verify a qBTC → BTC payout before marking a withdrawal fulfilled. Requires: an output that
/// pays `dest` at least `min_sats`, at least one input funded by the `custody` address (so the
/// relayer cannot pass off an unrelated payment as a fulfillment), and the required confirmation
/// depth. Uses the primary provider only — this runs after the relayer already broadcast, and
/// the payout is additionally bounded by the burn that preceded it.
pub async fn verify_btc_payout(
    txid: &str,
    custody: &str,
    dest: &str,
    min_sats: u64,
) -> Result<(), String> {
    let txid = txid.trim().trim_start_matches("0x").to_lowercase();
    if !valid_txid(&txid) {
        return Err("invalid BTC payout txid (expected 64 hex chars)".to_string());
    }
    let min_conf = btc_min_confirmations();
    let bases = esplora_bases();
    let client = http_client();
    let base = &bases[0];

    let tip = fetch_tip(&client, base).await?;
    let tx = fetch_tx(&client, base, &txid).await?;
    if !tx.status.confirmed {
        return Err("payout is still unconfirmed".to_string());
    }
    let block_height = tx.status.block_height.ok_or("payout is missing a block height")?;
    let confs = tip.saturating_sub(block_height).saturating_add(1);
    if confs < min_conf {
        return Err(format!("payout has {} confirmation(s); {} required", confs, min_conf));
    }

    let paid: u64 = tx
        .vout
        .iter()
        .filter(|v| v.scriptpubkey_address.as_deref() == Some(dest))
        .map(|v| v.value)
        .sum();
    if paid < min_sats {
        return Err(format!(
            "payout paid {} sats to {}, less than the {} owed",
            paid, dest, min_sats
        ));
    }

    let from_custody = tx.vin.iter().any(|v| {
        v.prevout.as_ref().and_then(|p| p.scriptpubkey_address.as_deref()) == Some(custody)
    });
    if !from_custody {
        return Err("payout was not funded by the custody address".to_string());
    }
    Ok(())
}

/// Structural validation of a destination BTC address for a qBTC withdrawal. This is a
/// prefix/charset/length check (not a full checksum verify — that would require pulling in a
/// bech32/base58check dependency); it mirrors the rigor of the EVM path's hex+length check.
/// A structurally-valid-but-wrong address is the user's responsibility exactly as an EVM typo
/// is, and the relayer + on-chain payout verification bound any real loss.
pub fn validate_btc_address(addr: &str, network: &str) -> Result<(), String> {
    let a = addr.trim();
    if a.is_empty() {
        return Err("empty BTC address".to_string());
    }
    let mainnet = network != "testnet";

    // Bech32 / bech32m (native SegWit / Taproot): bc1… (mainnet) or tb1… (testnet), single-case.
    let lower = a.to_lowercase();
    let hrp = if mainnet { "bc1" } else { "tb1" };
    if lower.starts_with(hrp) {
        if a != a.to_lowercase() && a != a.to_uppercase() {
            return Err("bech32 address must not be mixed-case".to_string());
        }
        if a.len() < 14 || a.len() > 90 {
            return Err("bech32 address length is out of range".to_string());
        }
        const CHARSET: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        if !lower[hrp.len()..].chars().all(|c| CHARSET.contains(c)) {
            return Err("bech32 address has invalid characters".to_string());
        }
        return Ok(());
    }

    // Base58Check (legacy P2PKH / P2SH): case-sensitive — never lowercase it.
    let first = a.chars().next().unwrap();
    let prefix_ok = if mainnet {
        first == '1' || first == '3'
    } else {
        first == 'm' || first == 'n' || first == '2'
    };
    if prefix_ok {
        if a.len() < 26 || a.len() > 35 {
            return Err("base58 address length is out of range".to_string());
        }
        const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        if !a.chars().all(|c| B58.contains(c)) {
            return Err("base58 address has invalid characters".to_string());
        }
        return Ok(());
    }

    Err(format!("unrecognized BTC address format for {}", network))
}
