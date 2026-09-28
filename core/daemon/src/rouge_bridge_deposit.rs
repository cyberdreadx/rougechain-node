//! Dedicated verifier for RougeBridge deposits (Base → RougeChain qETH / qUSDC auto-claim).
//!
//! The relayer's deposit watcher only supplies a Base tx hash. EVERYTHING that decides the mint —
//! asset, amount and the RougeChain recipient — is taken from the on-chain receipt of that tx:
//!
//! * the receipt must be successful;
//! * the deposit event must be emitted by the CONFIGURED RougeBridge contract;
//! * `BridgeDepositETH(address indexed sender, uint256 amount, string rougechainPubkey)` → qETH,
//!   units = amountWei / 10^12 exactly (sub-unit dust is rejected, never rounded);
//! * `BridgeDepositERC20(address indexed sender, address indexed token, uint256 amount, string
//!   rougechainPubkey)` → qUSDC 1:1 in USDC base units, only when `token` is the configured Base
//!   USDC AND the same receipt carries a USDC `Transfer(sender → RougeBridge, amount)` emitted by
//!   that USDC contract;
//! * exactly one matching deposit event per tx (the claim key is the tx hash);
//! * the caller-supplied recipient/amount are never used.
//!
//! Confirmation depth and dedupe are separate, equally fail-closed steps (`require_confirmations`,
//! `reserve_then_mint`). Nothing here touches XRGE (BridgeVault) auto-claim or withdrawals.
use quantum_vault_bridge_exec::{bytes_to_hex, keccak256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepositAsset { Eth, Usdc }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedDeposit {
    pub asset: DepositAsset,
    pub mint_symbol: &'static str,
    /// exact L1 units to mint (qETH: wei / 10^12; qUSDC: USDC base units 1:1)
    pub l1_units: u64,
    /// raw on-chain amount (wei for ETH, base units for USDC)
    pub amount_base: u128,
    pub sender: String,
    /// RougeChain recipient exactly as bound in the on-chain event
    pub rougechain_pubkey: String,
    pub block: u64,
}

pub const WEI_PER_QETH_UNIT: u128 = 1_000_000_000_000;

fn topic(sig: &str) -> String { format!("0x{}", bytes_to_hex(&keccak256(sig.as_bytes()))) }
pub fn topic_deposit_eth() -> String { topic("BridgeDepositETH(address,uint256,string)") }
pub fn topic_deposit_erc20() -> String { topic("BridgeDepositERC20(address,address,uint256,string)") }
pub fn topic_erc20_transfer() -> String { topic("Transfer(address,address,uint256)") }

fn lc(v: Option<&serde_json::Value>) -> String { v.and_then(|x| x.as_str()).unwrap_or("").to_lowercase() }
fn topic_addr(t: &str) -> String { let h = t.trim_start_matches("0x"); if h.len() == 64 { format!("0x{}", &h[24..]) } else { String::new() } }
fn word_u128(data: &[u8], word: usize) -> Result<u128, String> {
    let s = word * 32;
    if data.len() < s + 32 { return Err("event data too short".into()); }
    if data[s..s + 16].iter().any(|&b| b != 0) { return Err("amount exceeds u128".into()); }
    let mut a = [0u8; 16]; a.copy_from_slice(&data[s + 16..s + 32]); Ok(u128::from_be_bytes(a))
}
/// abi.encode(uint256 amount, string s) → (amount, s)
fn decode_amount_string(data_hex: &str) -> Result<(u128, String), String> {
    let data = hex::decode(data_hex.trim_start_matches("0x")).map_err(|e| format!("bad event data: {}", e))?;
    let amount = word_u128(&data, 0)?;
    let off = word_u128(&data, 1)? as usize;
    if off.checked_add(32).map(|e| e > data.len()).unwrap_or(true) { return Err("string offset out of range".into()); }
    let mut lb = [0u8; 8]; lb.copy_from_slice(&data[off + 24..off + 32]);
    if data[off..off + 24].iter().any(|&b| b != 0) { return Err("string length out of range".into()); }
    let len = u64::from_be_bytes(lb) as usize;
    let start = off + 32;
    if start.checked_add(len).map(|e| e > data.len()).unwrap_or(true) { return Err("string length out of range".into()); }
    let s = String::from_utf8(data[start..start + len].to_vec()).map_err(|_| "pubkey not valid UTF-8".to_string())?;
    Ok((amount, s))
}

/// Verify a Base receipt (`eth_getTransactionReceipt.result`) as a RougeBridge deposit of `expect`.
pub fn verify_rouge_bridge_deposit(receipt: &serde_json::Value, expect: DepositAsset, rouge_bridge: &str, usdc: &str) -> Result<VerifiedDeposit, String> {
    let bridge = rouge_bridge.trim().to_lowercase();
    let usdc = usdc.trim().to_lowercase();
    if bridge.len() != 42 { return Err("RougeBridge address not configured".into()); }
    if receipt.is_null() { return Err("transaction not found or not yet mined".into()); }
    if receipt.get("status").and_then(|v| v.as_str()).unwrap_or("0x0") != "0x1" { return Err("deposit transaction reverted".into()); }
    let block = receipt.get("blockNumber").and_then(|v| v.as_str())
        .and_then(|h| u64::from_str_radix(h.trim_start_matches("0x"), 16).ok()).ok_or("deposit block missing")?;
    let logs = receipt.get("logs").and_then(|v| v.as_array()).ok_or("no logs in receipt")?;
    let want_topic = match expect { DepositAsset::Eth => topic_deposit_eth(), DepositAsset::Usdc => topic_deposit_erc20() };

    // The claim is deduped by Base tx hash, so a claimable tx must carry EXACTLY ONE supported
    // RougeBridge deposit in total (BridgeDepositETH + supported-USDC BridgeDepositERC20). Two
    // deposits in one tx would mint one and strand the other forever behind the dedupe key.
    let (t_eth, t_erc) = (topic_deposit_eth(), topic_deposit_erc20());
    let supported_total = logs.iter().filter(|l| {
        if lc(l.get("address")) != bridge { return false; }
        let tp: Vec<String> = l.get("topics").and_then(|v| v.as_array()).map(|t| t.iter().map(|x| lc(Some(x))).collect()).unwrap_or_default();
        match tp.first() {
            Some(t0) if *t0 == t_eth => true,
            Some(t0) if *t0 == t_erc => tp.len() == 3 && topic_addr(&tp[2]) == usdc,
            _ => false,
        }
    }).count();
    if supported_total > 1 {
        return Err(format!("{} supported RougeBridge deposit events in one transaction — ambiguous, refusing to credit any of them", supported_total));
    }

    let mut found: Vec<VerifiedDeposit> = Vec::new();
    let mut unsupported_token: Option<String> = None;
    for log in logs {
        let topics: Vec<String> = log.get("topics").and_then(|v| v.as_array()).map(|t| t.iter().map(|x| lc(Some(x))).collect()).unwrap_or_default();
        if topics.first().map(|t| t != &want_topic).unwrap_or(true) { continue; }
        // emitter MUST be the configured RougeBridge — an identical event from any other contract is ignored
        if lc(log.get("address")) != bridge { continue; }
        let (amount, pubkey) = decode_amount_string(log.get("data").and_then(|v| v.as_str()).unwrap_or(""))?;
        if amount == 0 { return Err("deposit amount is zero".into()); }
        if pubkey.trim().is_empty() { return Err("deposit has an empty RougeChain pubkey".into()); }
        match expect {
            DepositAsset::Eth => {
                if topics.len() != 2 { return Err("malformed BridgeDepositETH topics".into()); }
                if amount % WEI_PER_QETH_UNIT != 0 { return Err(format!("ETH deposit {} wei is not a whole number of qETH units (10^12 wei) — sub-unit dust rejected", amount)); }
                let units = u64::try_from(amount / WEI_PER_QETH_UNIT).map_err(|_| "qETH amount exceeds u64".to_string())?;
                found.push(VerifiedDeposit { asset: expect, mint_symbol: "qETH", l1_units: units, amount_base: amount, sender: topic_addr(&topics[1]), rougechain_pubkey: pubkey, block });
            }
            DepositAsset::Usdc => {
                if topics.len() != 3 { return Err("malformed BridgeDepositERC20 topics".into()); }
                if usdc.len() != 42 { return Err("Base USDC address not configured".into()); }
                let (sender, token) = (topic_addr(&topics[1]), topic_addr(&topics[2]));
                // an ERC20 deposit of any other token is not a supported deposit: never claimable, and
                // unrelated to a genuine USDC deposit elsewhere in the receipt
                if token != usdc { unsupported_token = Some(token); continue; }
                // the USDC contract itself must show the matching value moving sender → RougeBridge
                let t_transfer = topic_erc20_transfer();
                let matched = logs.iter().any(|l| {
                    let tp: Vec<String> = l.get("topics").and_then(|v| v.as_array()).map(|t| t.iter().map(|x| lc(Some(x))).collect()).unwrap_or_default();
                    lc(l.get("address")) == usdc && tp.len() == 3 && tp[0] == t_transfer && topic_addr(&tp[1]) == sender && topic_addr(&tp[2]) == bridge
                        && hex::decode(l.get("data").and_then(|v| v.as_str()).unwrap_or("").trim_start_matches("0x")).ok().and_then(|d| word_u128(&d, 0).ok()) == Some(amount)
                });
                if !matched { return Err("no matching USDC Transfer(sender → RougeBridge, amount) in this receipt".into()); }
                let units = u64::try_from(amount).map_err(|_| "qUSDC amount exceeds u64".to_string())?;
                found.push(VerifiedDeposit { asset: expect, mint_symbol: "qUSDC", l1_units: units, amount_base: amount, sender, rougechain_pubkey: pubkey, block });
            }
        }
    }
    match found.len() {
        0 if unsupported_token.is_some() => Err(format!("deposit token {} is not the configured Base USDC {}", unsupported_token.unwrap(), usdc)),
        0 => Err(format!("no {} event from the configured RougeBridge in this transaction", match expect { DepositAsset::Eth => "BridgeDepositETH", DepositAsset::Usdc => "BridgeDepositERC20" })),
        1 => Ok(found.remove(0)),
        n => Err(format!("{} deposit events in one transaction — ambiguous, refusing to credit", n)),
    }
}

/// Expected EVM chain for bridge deposits: `QV_BRIDGE_CHAIN_ID`, default 8453 (Base mainnet) when
/// unset. A value that is set but unparseable is a configuration error ⇒ no credit.
pub fn expected_bridge_chain_id(env_value: Option<&str>) -> Result<u64, String> {
    match env_value.map(|v| v.trim()).filter(|v| !v.is_empty()) {
        None => Ok(8453),
        Some(v) => v.parse::<u64>().map_err(|_| format!("QV_BRIDGE_CHAIN_ID '{}' is not a valid chain id — refusing to credit", v)),
    }
}
/// Bind the auto-claim to the configured chain using the DAEMON's own RPC (`eth_chainId` JSON-RPC
/// response, or the transport error). RPC failure, missing/malformed result or mismatch ⇒ Err.
pub fn require_chain_id(rpc_response: Result<&serde_json::Value, &str>, expected: u64) -> Result<(), String> {
    let v = rpc_response.map_err(|e| format!("could not verify EVM chain id (RPC unavailable: {}) — refusing to credit", e))?;
    let hex_id = v.get("result").and_then(|r| r.as_str())
        .ok_or_else(|| "could not verify EVM chain id (missing eth_chainId result) — refusing to credit".to_string())?;
    let digits = hex_id.strip_prefix("0x").ok_or_else(|| format!("malformed eth_chainId result '{}' — refusing to credit", hex_id))?;
    if digits.is_empty() { return Err("malformed eth_chainId result '0x' — refusing to credit".into()); }
    let got = u64::from_str_radix(digits, 16).map_err(|_| format!("malformed eth_chainId result '{}' — refusing to credit", hex_id))?;
    if got != expected { return Err(format!("EVM chain mismatch: daemon RPC reports {} but the bridge is configured for {} — refusing to credit", got, expected)); }
    Ok(())
}

/// Fail-closed confirmation gate: an unknown head is NOT "deep enough".
pub fn require_confirmations(deposit_block: u64, latest: Option<u64>, min_conf: u64) -> Result<(), String> {
    match latest {
        None => Err("could not verify confirmations (Base RPC unavailable) — refusing to credit".into()),
        Some(l) => match deposit_block.checked_add(min_conf) {
            Some(need) if l >= need => Ok(()),
            // too shallow — or an overflowing block number, which can never be proven deep enough
            _ => Err(format!("Need {} confirmations (tx block {}, latest {})", min_conf, deposit_block, l)),
        },
    }
}

/// Atomically reserve the Base tx BEFORE minting; release the reservation only if the mint fails.
pub async fn reserve_then_mint<F, T>(store: &quantum_vault_storage::bridge_claim_store::BridgeClaimStore, claim_key: &str, mint: F) -> Result<T, String>
where F: FnOnce() -> Result<T, String> {
    match store.insert_if_absent(claim_key.to_string()).await {
        Ok(true) => {}
        Ok(false) => return Err("Transaction already claimed".into()),
        Err(e) => return Err(format!("Failed to persist claim: {}", e)),
    }
    match mint() {
        Ok(v) => Ok(v),
        Err(e) => { let _ = store.remove(claim_key).await; Err(e) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const BRIDGE: &str = "0x0c09c764adc024497729cd452ecfee8869d35d83";
    const USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const SENDER: &str = "0x6776cdaa2b24950ba15cffbbce983be73aeb7275";
    const PUBKEY: &str = "8ccf7878003b2668d3c38f906b01cf751d54516be19583d0c93cf5bfb3f45a2e";

    fn pad_addr(a: &str) -> String { format!("0x{}{}", "0".repeat(24), a.trim_start_matches("0x")) }
    fn word(n: u128) -> String { format!("{:064x}", n) }
    fn enc_amount_string(amount: u128, s: &str) -> String {
        let b = s.as_bytes(); let mut h = format!("{}{}{}", word(amount), word(64), word(b.len() as u128));
        h.push_str(&hex::encode(b)); while (h.len() / 2) % 32 != 0 { h.push_str("00"); } format!("0x{}", h)
    }
    fn eth_log(emitter: &str, amount: u128, pk: &str) -> serde_json::Value {
        serde_json::json!({ "address": emitter, "topics": [topic_deposit_eth(), pad_addr(SENDER)], "data": enc_amount_string(amount, pk) })
    }
    fn erc_log(emitter: &str, token: &str, amount: u128, pk: &str) -> serde_json::Value {
        serde_json::json!({ "address": emitter, "topics": [topic_deposit_erc20(), pad_addr(SENDER), pad_addr(token)], "data": enc_amount_string(amount, pk) })
    }
    fn transfer_log(token: &str, from: &str, to: &str, amount: u128) -> serde_json::Value {
        serde_json::json!({ "address": token, "topics": [topic_erc20_transfer(), pad_addr(from), pad_addr(to)], "data": format!("0x{}", word(amount)) })
    }
    fn receipt(status: &str, logs: Vec<serde_json::Value>) -> serde_json::Value { serde_json::json!({ "status": status, "blockNumber": "0x64", "logs": logs }) }

    #[test]
    fn qeth_deposit_credits_the_event_bound_pubkey_with_exact_wei_conversion() {
        let d = verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, 100_000_000_000_000, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap();
        assert_eq!((d.mint_symbol, d.l1_units, d.amount_base, d.block), ("qETH", 100, 100_000_000_000_000, 100)); // 0.0001 ETH → 100 units
        assert_eq!(d.rougechain_pubkey, PUBKEY); assert_eq!(d.sender, SENDER);
        let one = verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap();
        assert_eq!(one.l1_units, 1);
        // mixed-case configured address still matches
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, "0x0c09C764AdC024497729cd452ECfeE8869d35d83", USDC).is_ok());
    }

    #[test]
    fn eth_sub_unit_dust_and_zero_are_rejected_never_rounded() {
        let e = verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT + 1, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap_err();
        assert!(e.contains("sub-unit dust"), "{e}");
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT - 1, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).is_err());
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, 0, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("zero"));
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, "")]), DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("empty"));
    }

    #[test]
    fn qusdc_is_one_to_one_in_base_units_and_requires_the_matching_usdc_transfer() {
        let good = receipt("0x1", vec![transfer_log(USDC, SENDER, BRIDGE, 1_000_000), erc_log(BRIDGE, USDC, 1_000_000, PUBKEY)]);
        let d = verify_rouge_bridge_deposit(&good, DepositAsset::Usdc, BRIDGE, USDC).unwrap();
        assert_eq!((d.mint_symbol, d.l1_units, d.amount_base), ("qUSDC", 1_000_000, 1_000_000)); // NO 10^12 scaling
        assert_eq!(d.rougechain_pubkey, PUBKEY);
        let no_transfer = receipt("0x1", vec![erc_log(BRIDGE, USDC, 1_000_000, PUBKEY)]);
        assert!(verify_rouge_bridge_deposit(&no_transfer, DepositAsset::Usdc, BRIDGE, USDC).unwrap_err().contains("no matching USDC Transfer"));
        for bad in [
            transfer_log(USDC, SENDER, BRIDGE, 999_999),                                   // wrong amount
            transfer_log(USDC, SENDER, "0x1111111111111111111111111111111111111111", 1_000_000), // not to the bridge
            transfer_log(USDC, "0x2222222222222222222222222222222222222222", BRIDGE, 1_000_000), // not from the depositor
            transfer_log("0x3333333333333333333333333333333333333333", SENDER, BRIDGE, 1_000_000), // emitted by another token
        ] {
            let r = receipt("0x1", vec![bad, erc_log(BRIDGE, USDC, 1_000_000, PUBKEY)]);
            assert!(verify_rouge_bridge_deposit(&r, DepositAsset::Usdc, BRIDGE, USDC).is_err());
        }
    }

    #[test]
    fn wrong_emitter_wrong_token_failed_receipt_and_wrong_asset_are_rejected() {
        let evil = "0x9999999999999999999999999999999999999999";
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(evil, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("no BridgeDepositETH event from the configured RougeBridge"));
        let fake_token = receipt("0x1", vec![transfer_log(evil, SENDER, BRIDGE, 1_000_000), erc_log(BRIDGE, evil, 1_000_000, PUBKEY)]);
        assert!(verify_rouge_bridge_deposit(&fake_token, DepositAsset::Usdc, BRIDGE, USDC).unwrap_err().contains("not the configured Base USDC"));
        assert!(verify_rouge_bridge_deposit(&receipt("0x0", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("reverted"));
        assert!(verify_rouge_bridge_deposit(&serde_json::Value::Null, DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("not found"));
        // an ETH deposit cannot be claimed as USDC and vice versa
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Usdc, BRIDGE, USDC).is_err());
        // two deposit events in one tx are ambiguous (the claim key is the tx hash)
        let two = receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY), eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]);
        assert!(verify_rouge_bridge_deposit(&two, DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("ambiguous"));
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, "", USDC).is_err());
    }

    #[test]
    fn the_verifier_takes_no_caller_recipient_or_amount() {
        // The function signature has no recipient/amount input at all: the ONLY sources are the receipt
        // and the configured addresses. A caller asking for a different recipient cannot influence it.
        let d = verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, 5 * WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).unwrap();
        assert_eq!(d.rougechain_pubkey, PUBKEY); assert_eq!(d.l1_units, 5);
    }

    #[test]
    fn no_credit_before_the_required_confirmations_and_none_when_the_head_is_unknown() {
        assert!(require_confirmations(100, Some(101), 6).unwrap_err().contains("Need 6 confirmations")); // depth 2
        assert!(require_confirmations(100, Some(105), 6).is_err());
        assert!(require_confirmations(100, Some(106), 6).is_ok());
        assert!(require_confirmations(100, None, 6).unwrap_err().contains("refusing to credit")); // RPC/head failure ⇒ no credit
        assert!(require_confirmations(u64::MAX, Some(u64::MAX), 6).is_err()); // no overflow
    }

    #[test]
    fn xrge_vault_auto_claim_is_a_separate_unchanged_path() {
        // The XRGE path keeps its own parser keyed on the BridgeVault event — pinned here so this
        // module can never silently change it …
        assert_eq!(topic("BridgeDeposit(address,uint256,string,uint256)"), "0x5787c7cf7a782a3836f23db1ed28764f1ae993eab4bf9602720553ac954249e2");
        // … and a vault XRGE BridgeDeposit (even if it were emitted by the RougeBridge address) is
        // never accepted as a qETH or qUSDC deposit: the topics differ.
        let xrge = serde_json::json!({ "address": BRIDGE, "topics": [topic("BridgeDeposit(address,uint256,string,uint256)"), pad_addr(SENDER)], "data": enc_amount_string(10u128.pow(18), PUBKEY) });
        for asset in [DepositAsset::Eth, DepositAsset::Usdc] {
            assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![xrge.clone()]), asset, BRIDGE, USDC).is_err());
        }
        assert_ne!(topic_deposit_eth(), topic_deposit_erc20());
    }

    #[test]
    fn auto_claim_is_bound_to_the_configured_evm_chain() {
        assert_eq!(expected_bridge_chain_id(None), Ok(8453));
        assert_eq!(expected_bridge_chain_id(Some("")), Ok(8453));
        assert_eq!(expected_bridge_chain_id(Some(" 84532 ")), Ok(84532));
        assert!(expected_bridge_chain_id(Some("base")).unwrap_err().contains("refusing to credit"));
        let ok = serde_json::json!({"jsonrpc":"2.0","id":1,"result":"0x2105"}); // 8453
        assert!(require_chain_id(Ok(&ok), 8453).is_ok());
        // wrong chain (Base Sepolia RPC while configured for mainnet, and vice versa)
        let sepolia = serde_json::json!({"result":"0x14a34"});
        assert!(require_chain_id(Ok(&sepolia), 8453).unwrap_err().contains("chain mismatch"));
        assert!(require_chain_id(Ok(&ok), 84532).unwrap_err().contains("chain mismatch"));
        // malformed / missing
        for bad in [serde_json::json!({"result":"8453"}), serde_json::json!({"result":"0x"}), serde_json::json!({"result":"0xzz"}), serde_json::json!({"result":8453}),
                    serde_json::json!({"result":null}), serde_json::json!({"error":{"code":-32000,"message":"rate limited"}}), serde_json::json!({})] {
            assert!(require_chain_id(Ok(&bad), 8453).unwrap_err().contains("refusing to credit"), "{bad}");
        }
        // unavailable RPC
        assert!(require_chain_id(Err("connection refused"), 8453).unwrap_err().contains("RPC unavailable"));
    }

    #[test]
    fn a_claimable_tx_carries_exactly_one_supported_deposit_event_in_total() {
        let usdc_pair = || vec![transfer_log(USDC, SENDER, BRIDGE, 1_000_000), erc_log(BRIDGE, USDC, 1_000_000, PUBKEY)];
        // one ETH event = accepted; one USDC event = accepted
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY)]), DepositAsset::Eth, BRIDGE, USDC).is_ok());
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", usdc_pair()), DepositAsset::Usdc, BRIDGE, USDC).is_ok());
        // two ETH events = rejected
        let two_eth = receipt("0x1", vec![eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY), eth_log(BRIDGE, 2 * WEI_PER_QETH_UNIT, PUBKEY)]);
        assert!(verify_rouge_bridge_deposit(&two_eth, DepositAsset::Eth, BRIDGE, USDC).unwrap_err().contains("ambiguous"));
        // two USDC events = rejected
        let mut two_usdc = usdc_pair(); two_usdc.extend(usdc_pair());
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", two_usdc), DepositAsset::Usdc, BRIDGE, USDC).unwrap_err().contains("ambiguous"));
        // one ETH + one USDC = rejected, whichever asset is being claimed
        let mut mixed = usdc_pair(); mixed.push(eth_log(BRIDGE, WEI_PER_QETH_UNIT, PUBKEY));
        for asset in [DepositAsset::Eth, DepositAsset::Usdc] {
            assert!(verify_rouge_bridge_deposit(&receipt("0x1", mixed.clone()), asset, BRIDGE, USDC).unwrap_err().contains("ambiguous"));
        }
        // unrelated events do not affect the count: other contracts' look-alike deposits, plain USDC
        // transfers, an unsupported-token ERC20 deposit event, and arbitrary logs
        let evil = "0x9999999999999999999999999999999999999999";
        let noise = vec![
            eth_log(evil, WEI_PER_QETH_UNIT, PUBKEY), erc_log(evil, USDC, 1_000_000, PUBKEY),
            transfer_log(USDC, SENDER, evil, 5), erc_log(BRIDGE, evil, 7, PUBKEY),
            serde_json::json!({ "address": BRIDGE, "topics": [topic("Paused(address)")], "data": "0x" }),
        ];
        let mut eth_noisy = noise.clone(); eth_noisy.push(eth_log(BRIDGE, 3 * WEI_PER_QETH_UNIT, PUBKEY));
        assert_eq!(verify_rouge_bridge_deposit(&receipt("0x1", eth_noisy), DepositAsset::Eth, BRIDGE, USDC).unwrap().l1_units, 3);
        let mut usdc_noisy = noise.clone(); usdc_noisy.extend(usdc_pair());
        // (the unsupported-token ERC20 event is not a SUPPORTED deposit: the count stays 1 and the genuine
        //  USDC deposit is still claimable)
        assert_eq!(verify_rouge_bridge_deposit(&receipt("0x1", usdc_noisy), DepositAsset::Usdc, BRIDGE, USDC).unwrap().l1_units, 1_000_000);
        // and the unsupported-token deposit on its own is still refused with the explicit reason
        assert!(verify_rouge_bridge_deposit(&receipt("0x1", vec![transfer_log(evil, SENDER, BRIDGE, 7), erc_log(BRIDGE, evil, 7, PUBKEY)]), DepositAsset::Usdc, BRIDGE, USDC).unwrap_err().contains("not the configured Base USDC"));
    }

    #[tokio::test]
    async fn a_base_tx_can_mint_only_once_and_a_failed_mint_releases_the_reservation() {
        let dir = std::env::temp_dir().join(format!("rbd-claims-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = quantum_vault_storage::bridge_claim_store::BridgeClaimStore::new(&dir).unwrap();
        let mints = std::sync::atomic::AtomicU32::new(0);
        let mint = || -> Result<u32, String> { Ok(mints.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1) };
        assert_eq!(reserve_then_mint(&store, "0xabc", mint).await.unwrap(), 1);
        assert!(reserve_then_mint(&store, "0xabc", mint).await.unwrap_err().contains("already claimed"));
        assert_eq!(mints.load(std::sync::atomic::Ordering::SeqCst), 1, "duplicate Base tx cannot mint twice");
        // a failed mint releases the reservation so a legitimate retry can succeed — and only then
        assert!(reserve_then_mint(&store, "0xdef", || -> Result<u32, String> { Err("mempool full".into()) }).await.is_err());
        assert!(!store.contains("0xdef").await);
        assert_eq!(reserve_then_mint(&store, "0xdef", mint).await.unwrap(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
