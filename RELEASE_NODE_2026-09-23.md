# RougeChain node release — consensus Release 1 (2026-09-23)

**Mandatory upgrade for every mainnet validator and full node.**

This release contains two consensus changes that are **already active on mainnet**:

| Change | Activation height | Status |
|---|---|---|
| Transaction-integrity rule (`TX_UNIQUENESS_ACTIVATION_HEIGHT`) | **90** | live since 2026-09-23 |
| Deterministic proposer selection, Release 1 (`PROPOSER_SELECTION_ACTIVATION_HEIGHT`) | **100** | live since 2026-09-23 |

Both rules are compiled constants in `core/daemon/src/node.rs`. A node that does not enforce them is
not a mainnet node: it can accept blocks the network rejects, and if it mines it will fork itself off.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `d50f7e5d34d03200f6efc45c8b7b63c61079e7f9d5b5c70f5b3c3c3544105eba` |
| Size | 26,866,528 bytes |
| Source commit (this repository) | `203507e` (`consensus: read-only activation report`), branch `release/proposer-selection-r1` |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), cargo 1.94.0 (85eff7c80 2026-01-15), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-proposer-selection-b69d0c9` (+ `.sha256`) |

This exact binary runs on the operator validators. It was built twice from clean checkouts and the two
builds were byte-identical; the recipe is in "Reproducible build" below.

## Minimum required release

**Minimum: this release (binary `d50f7e5d…`, source commit `203507e` or a later commit on the
same line).**

| Binary you are running | Result on mainnet today |
|---|---|
| Any build before the transaction-integrity rule (before commit `a005046`) | Cannot validate blocks ≥ 90. Must upgrade **and resync**. |
| Transaction-integrity build `9ad81dbf98e8e78a86b34be61af2360a34dba055f9f7a4be81b1a69c15942287` | Follows the chain but does **not** enforce proposer selection at ≥ 100. Not acceptable for a validator. Upgrade before reconnecting. |
| `d50f7e5d34d03200f6efc45c8b7b63c61079e7f9d5b5c70f5b3c3c3544105eba` | Current. |

## What changed (summary)

**Transaction integrity (height ≥ 90).** Every transaction has a single identity derived from the
signer's public key and the exact bytes the signer signed. The fields a block executes must be the
fields that were signed, and a transaction identity may be included in the chain at most once. This is
enforced at the API, in the mempool, and as a block-validity rule, so a block that repeats or alters a
signed transaction is rejected by every upgraded node.

**Proposer selection, Release 1 (height ≥ 100).** For each height `H` exactly one validator may
propose: the eligible validator (stake > 0, not jailed at `H`) with the greatest stake in the canonical
validator state after block `H-1`; ties go to the lowest raw public-key bytes. A correctly signed block
from any other validator is rejected. Producers refuse to seal a slot that is not theirs, and keep a
local, durable proposal journal so a restart can never sign two different blocks for the same slot.
Legacy missed-block accounting (auto-slash / auto-jail for not proposing) is frozen from height 100,
because non-designated validators are now *required* not to propose. There is no fallback proposer in
Release 1: if the designated proposer is offline, no block is produced until it returns. Fallback
selection is the subject of Release 2.

**Read-only reporting.** `GET /api/stats` now includes `proposer_selection_activation_height`,
`designated_proposer_next_height`, `proposer_selection_active_next` and `designated_proposer_next`;
the daemon logs one `[consensus] proposer selection: …` line at startup. Compare these across nodes.

**Public API containment (unchanged by this release, still in force).** `POST /api/blocks/import`,
`POST /api/peers/register`, `POST /api/tx/broadcast`, `/api/v2/contract/deploy`,
`/api/v2/contract/call` and `/api/bridge/withdraw` return 403 at the public edge
(`api.rougechain.io`). Nodes sync by pulling `GET /api/blocks`; peering is arranged with the operator.

Design and evidence: `core/daemon/TX_INTEGRITY_FORK.md` and `core/daemon/PROPOSER_SELECTION_DESIGN.md`.

## Upgrade instructions (existing validator or full node)

An old validator **must upgrade before reconnecting to mainnet.** Do not start an old binary against
the network, with or without `--mine`.

1. **Stop the node.**
   ```bash
   systemctl stop <your-unit>      # e.g. rougechain-validator
   ```
2. **Back up keys and data.** `node-keys.json` in your data directory is your staked validator key.
   ```bash
   cp -a ~/.quantum-vault/mainnet ~/.quantum-vault/mainnet.backup-$(date +%Y%m%d)
   ```
3. **Get the binary** — download and verify, or build reproducibly (below).
   ```bash
   curl -fsSLO https://api.rougechain.io/releases/quantum-vault-daemon-proposer-selection-b69d0c9
   curl -fsSLO https://api.rougechain.io/releases/quantum-vault-daemon-proposer-selection-b69d0c9.sha256
   sha256sum -c quantum-vault-daemon-proposer-selection-b69d0c9.sha256      # must print: OK
   install -m 755 quantum-vault-daemon-proposer-selection-b69d0c9 /path/to/quantum-vault-daemon
   ```
4. **Decide whether you need a resync.** If your node ever ran an older binary past height 48, or its
   state root at any height differs from the network's, start from a fresh data directory (keep the
   backup; copy only `node-keys.json` back). If in doubt, resync. A resync from genesis replays the
   whole chain under the current rules and takes a few minutes at today's chain length.
5. **Start without `--mine`.** Remove `--mine` from your unit until the node is verified.
   ```bash
   systemctl start <your-unit>
   journalctl -u <your-unit> --since "-2min" | grep "proposer selection"
   # expect: [consensus] proposer selection: activation height Some(100); next height <tip+1> (rule ACTIVE); designated proposer for <tip+1>: 8ccf7878003b2668
   ```
6. **Verify against the network** at the same height:
   ```bash
   curl -s http://127.0.0.1:5101/api/stats | jq '{network_height, state_root, designated_proposer_next}'
   curl -s https://api.rougechain.io/api/stats | jq '{network_height, state_root, designated_proposer_next}'
   ```
   `state_root` must match at equal heights and `designated_proposer_next` must match. Only then is the
   node on mainnet.
7. **Mining.** Under Release 1 only the designated proposer may seal blocks, and the daemon refuses to
   seal any other slot, so a non-designated validator gains nothing from `--mine`. Leave it off unless
   your validator is the designated proposer. Staying staked and synchronized keeps your validator
   eligible for Release 2 fallback selection.

## Reproducible build

```bash
git clone https://github.com/cyberdreadx/rougechain-node && cd rougechain-node
git checkout 203507e
export SOURCE_DATE_EPOCH=1790185445
export RUSTFLAGS="--remap-path-prefix=$PWD=/build/src --remap-path-prefix=$PWD/core/target=/build/target --remap-path-prefix=$HOME/.cargo=/build/cargo --remap-path-prefix=$HOME=/build/home"
cd core && cargo build --release --locked -p quantum-vault-daemon
sha256sum target/release/quantum-vault-daemon
# expected: d50f7e5d34d03200f6efc45c8b7b63c61079e7f9d5b5c70f5b3c3c3544105eba (rustc/cargo 1.94.0, x86_64 Linux)
```

Verified 2026-09-23: building commit `203507e` of this repository with the recipe above (at the same source path as the release build) produced a byte-identical binary, sha256 `d50f7e5d…`.

Cargo's metadata hash includes the package path, so two builds only match when they are made at the
same absolute source path with the same remapping. A different absolute path yields a different, still
valid, binary; compare against a second build at your own path if you want to check reproducibility
locally.

## Reporting problems

Open an issue in this repository with your `/api/stats` output, the startup `[consensus]` line and
the rejecting log line if any. Do not post private keys or `node-keys.json`.
