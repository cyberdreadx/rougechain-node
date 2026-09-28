//! Network upgrade schedule — the ONE place that says at which block height each protocol upgrade
//! turns on, per network.
//!
//! Every upgrade check in the node (`tx_uniqueness_rule_active`, `proposer_selection_active`,
//! `finality_v2_active`, `game_ready_active`, `game_ready_2_active`, `game_ready_3_active`,
//! `payable_calls_active`) reads its height from the schedule selected here at startup by chain id.
//!
//! * **Mainnet** (`rougechain-mainnet-1`) keeps the heights it activated at. They are history now:
//!   changing any of them would make a node reject mainnet's own blocks. `mainnet_schedule_is_pinned`
//!   guards them.
//! * **Testnet** (`rougechain-devnet-1`) passed mainnet's heights long ago under the old rules, so it
//!   gets its own, later heights. Proposer selection and finality stay off on testnet until its
//!   validator set is arranged (its block producer is not its largest staker); schedule them here.
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
};

/// Testnet: the contract and game upgrades from block 1200. Proposer selection and finality are
/// not scheduled (see the module docs).
pub const TESTNET: UpgradeSchedule = UpgradeSchedule {
    network: "testnet",
    tx_uniqueness: Some(1200),
    proposer_selection: None,
    finality_v2: None,
    game_ready: Some(1200),
    game_ready_2: Some(1200),
    game_ready_3: Some(1200),
    payable_calls: Some(1200),
};

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
        });
        assert_eq!(schedule_for(MAINNET_CHAIN_ID), &MAINNET);
    }

    #[test]
    fn testnet_schedule_is_pinned() {
        assert_eq!(schedule_for(TESTNET_CHAIN_ID), &TESTNET);
        assert_eq!((TESTNET.proposer_selection, TESTNET.finality_v2), (None, None));
        for h in [TESTNET.tx_uniqueness, TESTNET.game_ready, TESTNET.game_ready_2, TESTNET.game_ready_3, TESTNET.payable_calls] {
            assert_eq!(h, Some(1200));
        }
    }

    #[test]
    fn other_chains_use_the_mainnet_schedule() {
        for id in ["test", "rougechain-local", ""] {
            assert_eq!(schedule_for(id), &MAINNET);
        }
    }
}
