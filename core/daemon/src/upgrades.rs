//! Network upgrade schedule — the ONE place that says at which block height each protocol upgrade
//! turns on, per network.
//!
//! Every upgrade check in the node (`tx_uniqueness_rule_active`, `proposer_selection_active`,
//! `finality_v2_active`, `game_ready_active`, `game_ready_2_active`, `game_ready_3_active`,
//! `payable_calls_active`, `token_minting_active`, `contract_nft_royalty_active`) reads its height from the schedule selected here at startup by chain id.
//!
//! * **Mainnet** (`rougechain-mainnet-1`) keeps the heights it activated at. They are history now:
//!   changing any of them would make a node reject mainnet's own blocks. `mainnet_schedule_is_pinned`
//!   guards them.
//! * **Testnet** (`rougechain-devnet-1`) passed mainnet's heights long ago under the old rules, so it
//!   gets its own, later heights, plus a one-time retirement of a validator whose key nobody holds.
//! * Any other chain id (local devnets, tests) uses the mainnet schedule.
//!
//! To schedule an upgrade on testnet: set its height below, rebuild, install before that height,
//! and update `docs/running-a-node/upgrade-schedule.md`.

use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UpgradeSchedule {
    /// Human label, shown in `/api/stats` and the startup log.
    pub network: &'static str,
    pub tx_uniqueness: Option<u64>,
    pub proposer_selection: Option<u64>,
    pub finality_v2: Option<u64>,
    pub game_ready: Option<u64>,
    pub game_ready_2: Option<u64>,
    pub game_ready_3: Option<u64>,
    pub payable_calls: Option<u64>,
    /// TOKEN_MINTING (mintable custom tokens, creator-only capped minting). Not scheduled on any
    /// network yet — see `node::TOKEN_MINTING_ACTIVATION_HEIGHT` and the activation runbook in
    /// `docs/running-a-node/upgrade-schedule.md`.
    pub token_minting: Option<u64>,
    /// CONTRACT_NFT_ROYALTY (read-only `host_nft_royalty_bps` / `host_nft_royalty_recipient`). Not
    /// scheduled on any network yet — see `node::CONTRACT_NFT_ROYALTY_ACTIVATION_HEIGHT`; planned to
    /// activate at the same height as TOKEN_MINTING (runbook in `docs/running-a-node/upgrade-schedule.md`).
    pub contract_nft_royalty: Option<u64>,
    /// One-time testnet cleanup: at `height`, these validators' stake is returned to their balances
    /// and their stake set to zero (keys nobody holds, whose stake would block finality). Applied
    /// identically by the node and by the finality validator replay. Never set on mainnet.
    pub validator_retirement: Option<ValidatorRetirement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ValidatorRetirement {
    pub height: u64,
    pub validators: &'static [&'static str],
}

pub const MAINNET_CHAIN_ID: &str = "rougechain-mainnet-1";
pub const TESTNET_CHAIN_ID: &str = "rougechain-devnet-1";

/// Mainnet: the heights these upgrades activated at (2026-09-23 … 2026-09-28), from the
/// per-upgrade constants in `node.rs` (90, 100, 150, 150, 160, 170, 190 — pinned by
/// `mainnet_schedule_is_pinned`).
pub const MAINNET: UpgradeSchedule = UpgradeSchedule {
    network: "mainnet",
    tx_uniqueness: crate::node::TX_UNIQUENESS_ACTIVATION_HEIGHT,
    proposer_selection: crate::node::PROPOSER_SELECTION_ACTIVATION_HEIGHT,
    finality_v2: crate::node::FINALITY_V2_ACTIVATION_HEIGHT,
    game_ready: crate::node::GAME_READY_ACTIVATION_HEIGHT,
    game_ready_2: crate::node::GAME_READY_2_ACTIVATION_HEIGHT,
    game_ready_3: crate::node::GAME_READY_3_ACTIVATION_HEIGHT,
    payable_calls: crate::node::PAYABLE_CALLS_ACTIVATION_HEIGHT,
    token_minting: crate::node::TOKEN_MINTING_ACTIVATION_HEIGHT,
    contract_nft_royalty: crate::node::CONTRACT_NFT_ROYALTY_ACTIVATION_HEIGHT,
    validator_retirement: None,
};

/// Testnet: the contract and game upgrades from block 1200. At 1240 the stake of validator
/// `4e094d21…` (key held by nobody; 99% of testnet stake) is retired, so from 1250 the node's own
/// staked key can be the designated proposer and gather finality.
pub const TESTNET: UpgradeSchedule = UpgradeSchedule {
    network: "testnet",
    tx_uniqueness: Some(1200),
    proposer_selection: Some(1250),
    finality_v2: Some(1250),
    game_ready: Some(1200),
    game_ready_2: Some(1200),
    game_ready_3: Some(1200),
    payable_calls: Some(1200),
    token_minting: Some(1360),
    contract_nft_royalty: Some(1360),
    validator_retirement: Some(ValidatorRetirement { height: 1240, validators: &[TESTNET_RETIRED_VALIDATOR] }),
};

/// Testnet validator `4e094d21…` — see `TESTNET.validator_retirement`.
pub const TESTNET_RETIRED_VALIDATOR: &str = "4e094d21a0ffcd1f1328c3683b1ede94317d2d910a89090650eb0d985c39e78dbfc86ca6e2600f494ff5988a814189cf45946b4a4707c2b1bb4288851b417f3ced9cdc02a2a85e2a93f1c6cbaa925059e8678c6d489a8ed22b28fb58bfcfd27926232bd3afd3fbddebad63f0e5fef11f43a30495e59ae85292390bbd52835940224b83daf3055d04fba48fa863b79c0a4e360a792e71e98d91e6d47b9da0ec08980f62f8e84e9561aa5d6cc6b15b1a463b3ed68e3c09115dad77248a7c4d0ebcb7df2072e0b726dc0f972d479da04fc1851cfc47bdd0d1d34b381af8c7103ae73944f414b791c6aa092e7737d43a9a739bcda836d2350903560054373953cadefe2000e4ef502bc27144768801097b4d4b5d364061fb39da0b2074bcc805615c8243c2d6360e343bf7700de1e2dc629772ddd42cd3f480fd4439d779966c2aab9bc6f4a0febc3223ff7cc3e8316eeaf376a315918ff64c35e7ff6d2fe6c200250cd633e1f1984a3e5d647dddb79468309bc44d9de25728a478f0d57b7d0ae706f0e2ae4e3f7e8f044870f726acf08df9114ef009a08ba499337984119489583dabf90bf3dd629d7eed5daee26d577dd4d36c966fdd09cae69db848631b71949f0b307ab1473edc76bacfdd4913d01e37f7862cc378ec0bff5b75ac2d653b1cdee018f0c4d4fb981bf5c61d8c0cd6a67333578ffd27c1de7b9b2ac6a0524439da8a7a4dcb3658ce6a5d0733ba7e180ee327aca63bd67e2525bbb405b91363d34a0990d406c4c7787efa15848aa231101699714de4d7d897fa63343fbd1ce8f55e408a7d99a494193349feaaf5ca91321d94b0b9ea34e69b47df0e98110dacde57be13756ed954f5236666f179daef1a424da24e5d38af7a56e8b97ecea6264c8a5dee4f43bc53003eb44f4d0cee38d0fd6910bfdcbcf01eb5a8cf2a43bbd2cc1a7cd2f8f63b02e16f62e70adc4061c5ea042310af85684cd519c7a8f0fe0b9b119383bdba84e28bd2e6f5c31dbbe275e5b71cc03f8e1510e344a0930d81c08c155bc979469684a368ccb6cee862a3af621e3f4215be9ddfacc7de628daf3fe691aee046a93fc03148ee235316c3f8ea19eec28a9a670020b0d72e7b98e948b0405028de58912f499764e57a17e2d4a05f50e4a3824612b073ea174afe76988f07cc458a2421c3ff2cf562e9051201d51f7f59848a3aeaa1f232941fd877d44dc427d4d2bc286db58b4602710ee198efff0399500960f6a1f58ade2b93725887c7ce06d475dec13307b2b149beabebcce60347d3d6177e1624eaa5a6a35e138f66dd4ae3d9f3050189a876a2301f753b2821eb2b107db22cba6620e9fe2c753765d1885fd82943665170a771457ec174e46702b27f014648a7a7c2dfe10138fba3189bcef881f31db9c40fdb5825e6b23a65c03c22c9bc9f1c9df86746e3685c28793683cd6abcda428d9167fc6d7422b166451e7087cff95546d48ac719e9f144f9f2b4550a61bcb500170e263ca541be5f88af543fcefbb454e8d4525e00409ec3857c0777380f4edacd778715d7aeceed3f4ce9a06661e1b5525ea3b777826af338b39930b1a92c3305f88876f36cf7cf3b78ca0f5505bc3ab3a15241365babe50b86092e922e0de5176aba25fc8ed5264a1059d2e43b206d0c6dfc66de38d56f9eeb2f5fa72229654962cf798afbaff51860918c5d4576e8ab07c684e2105bfc2157453e645827ff0cde3ba25e2511a5ba30b7803d63f697cd1f05106865928c68919e83910a9ad72b37884769103974ec1938daf51da26c55d6bed080c9af60a66958be21900e13f1723f0a7f9ea3691b01753a17b5148d88a6bda418c1a041fc1253eb12f6cb85b203a8c1c46af97c9ef275fa12649dba6f22a7f3021532a5575d7e7bcbffb29465c10258ef6a30db53eea237d6a90529a1fa1948da85a1332e1db196e7e1d695eb1349108ccd4151968d0c06a29f970bb0b4a21e17256a116d558b7ec3e09bac251fee15719becf80c359bb453c6b5fa40bc81ba251bd1649c1bc8faaf516b8ec1cd95f5cd4e75238e43c9c07618062f1d85f7854f9aa87cc39bd8080c843b350741f066cd033dd5216ccc39be7c3f89da5637cb0b5ebe4ba42152bf8c5d1f779976bd74d82a5c25f418f6c1ef80e462a79eeeb5542764e9f7ab839170a034965aad9b9f6cdec6af06123815c6956ad8c09c5dc5af94b26aec9a08ccca5d7554d2560c94ec452b7e154a5e7d59769ea2109b0065781d25850d3d9b53fa1068555907d2fe8c34605cb2f469c3cb76cfdbe61c6350a287207a663f81bfecf52130d58a6932adde3446f8a0821245f27b811f32d689ae1de7124550f34312d15ee8f6f4803ffc4b798f0ce2f67700e0ea5223ca4e611ecf3240d40cf3fb1ecb098a70372718f0e3438a106aa21458180f0a61943d08c4444c5d0321fe9520b78a88780bb833590ba1dbc132b3d21cddc26f585d15653309a65c78825a796dbec3520535d87d6120a8ef9e835ec840c49969e7a45233e77d5c596a167f901aa79b0bdac0261fdab450cbca23303165741e02cba9247750a0734612614e445e8737758595838feeaca9da859a85cd5669dcccad92fec71411af560fa0b879304d2726673d71f0793480837aa0e74c6f3ce3fdf2a721ce61305d0ebd073785020a54abc6873ca85982687b7cca0226070cc6d6cc98a2d27ec166fbd1909b8a1c3ca7d139e760b910d20d66288c9a930c3632e9405f0e122b0f72";

static ACTIVE: OnceLock<&'static UpgradeSchedule> = OnceLock::new();

/// The schedule for a chain id.
pub fn schedule_for(chain_id: &str) -> &'static UpgradeSchedule {
    match chain_id {
        TESTNET_CHAIN_ID => &TESTNET,
        _ => &MAINNET,
    }
}

/// Select the schedule for this process from its chain id. Call once at startup, before the node
/// applies any block. A second call with a different chain id is refused.
pub fn select(chain_id: &str) -> Result<&'static UpgradeSchedule, String> {
    let wanted = schedule_for(chain_id);
    let got = *ACTIVE.get_or_init(|| wanted);
    if got != wanted {
        return Err(format!("upgrade schedule already set to {} (chain id {} wants {})", got.network, chain_id, wanted.network));
    }
    Ok(got)
}

/// The schedule in force (mainnet's until `select` runs, e.g. in tests).
#[inline]
pub fn current() -> &'static UpgradeSchedule {
    ACTIVE.get().copied().unwrap_or(&MAINNET)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mainnet's heights are history. If this fails, something changed a mainnet activation height —
    /// that would make every node reject mainnet's own blocks.
    #[test]
    fn mainnet_schedule_is_pinned() {
        assert_eq!(MAINNET, UpgradeSchedule {
            network: "mainnet",
            tx_uniqueness: Some(90),
            proposer_selection: Some(100),
            finality_v2: Some(150),
            game_ready: Some(150),
            game_ready_2: Some(160),
            game_ready_3: Some(170),
            payable_calls: Some(190),
            token_minting: Some(235),
            contract_nft_royalty: Some(235),
            validator_retirement: None,
        });
        assert_eq!(schedule_for(MAINNET_CHAIN_ID), &MAINNET);
    }

    #[test]
    fn testnet_schedule_is_pinned() {
        assert_eq!(schedule_for(TESTNET_CHAIN_ID), &TESTNET);
        assert_eq!((TESTNET.proposer_selection, TESTNET.finality_v2), (Some(1250), Some(1250)));
        let r = TESTNET.validator_retirement.unwrap();
        assert_eq!(r.height, 1240);
        assert!(r.height < TESTNET.proposer_selection.unwrap(), "retire before the proposer rule reads the store");
        assert!(r.validators.iter().all(|k| k.starts_with("4e094d21") && k.len() == 3904));
        for h in [TESTNET.tx_uniqueness, TESTNET.game_ready, TESTNET.game_ready_2, TESTNET.game_ready_3, TESTNET.payable_calls] {
            assert_eq!(h, Some(1200));
        }
        assert_eq!(TESTNET.token_minting, Some(1360), "TOKEN_MINTING activates on testnet at 1360");
        assert_eq!(TESTNET.contract_nft_royalty, Some(1360), "CONTRACT_NFT_ROYALTY activates on testnet at 1360");
    }

    #[test]
    fn other_chains_use_the_mainnet_schedule() {
        for id in ["test", "rougechain-local", ""] {
            assert_eq!(schedule_for(id), &MAINNET);
        }
    }
}
