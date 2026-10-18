//! CONSENSUS-0, stage 1: the consensus rules of RougeChain's "Consensus R2"
//! redesign (`docs/CONSENSUS_R2_DESIGN.md`) as a pure, deterministic state
//! machine, with a seeded simulator that attacks it.
//!
//! * [`machine`] — the Tendermint round state machine for one validator (§3).
//! * [`schedule`] — the integer stake-weighted proposer rotation (§3.3).
//! * [`chain`] — blocks, epochs, set changes, unbonding, evidence, slashing,
//!   jailing and rewards as pure functions over an integer ledger (§3.4, §4–§6).
//! * [`node`] — driver glue: one machine plus one ledger plus a mempool.
//! * [`sim`] — one seeded event queue driving many nodes through a faulty network.
//! * [`props`] — checkers for properties P1–P10 (§9).
//! * [`explore`] — bounded exhaustive exploration of message orderings.
//! * [`campaign`] — seed → scenario generation and the measurement scenarios.
//!
//! Nothing here touches the node, the network, a clock or the disk.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod campaign;
pub mod chain;
pub mod explore;
pub mod machine;
pub mod mutation;
pub mod node;
pub mod props;
pub mod schedule;
pub mod sim;
pub mod types;

#[cfg(test)]
mod tests;
