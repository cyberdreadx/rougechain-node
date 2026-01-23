# Consensus Mechanism - Multiple Node Consistency

## Current Implementation (Devnet)

RougeChain uses a **simple longest-chain consensus** with P2P gossip for devnet. Here's how multiple nodes stay consistent:

## How It Works

### 1. **P2P Network Connection**

Nodes connect via TCP and exchange messages:
- **HELLO**: Exchange chain height and chain ID on connection
- **TIP**: Share current chain tip (height + hash)
- **GET_BLOCK**: Request a specific block by height
- **BLOCK**: Send a block to a peer
- **TX**: Broadcast transactions (gossip protocol)

### 2. **Block Synchronization**

When nodes connect:
```
Node A (height: 10) connects to Node B (height: 12)
→ Node A sends HELLO with height 10
→ Node B sees A is behind, sends TIP with height 12
→ Node A requests: GET_BLOCK height 11
→ Node B sends: BLOCK (height 11)
→ Node A validates and accepts
→ Node A requests: GET_BLOCK height 12
→ Node B sends: BLOCK (height 12)
→ Node A catches up to height 12
```

### 3. **Block Validation**

Every node validates blocks before accepting:
- ✅ Chain ID matches
- ✅ Height is exactly `tip.height + 1`
- ✅ Previous hash matches current tip
- ✅ Proposer signature is valid (ML-DSA-65)
- ✅ Block hash matches computed hash
- ✅ Transaction signatures are valid
- ✅ Transaction hash in header matches transactions

### 4. **Block Broadcasting**

When a node mines a block:
```
Node A mines block #13
→ Node A validates block locally
→ Node A appends to its chain
→ Node A broadcasts BLOCK message to all peers
→ Peers receive block
→ Each peer validates independently
→ If valid, peer accepts and broadcasts to their peers
→ Network converges on same chain
```

### 5. **Transaction Gossip**

Transactions are gossiped across the network:
```
User submits TX to Node A
→ Node A adds to mempool
→ Node A broadcasts TX to all peers
→ Peers validate and add to their mempools
→ When any node mines, it includes TXs from mempool
→ All nodes eventually see same transactions
```

## Consensus Rules

### Longest Chain Rule (Implicit)

- Nodes always accept valid blocks that extend their current tip
- If two blocks are mined at same height, the first one received wins
- Nodes will switch to longer chain if they receive it

### Validation is Strict

- Invalid blocks are **rejected** (not broadcast)
- Only valid blocks propagate through network
- All nodes independently verify every block

## Current Limitations (Devnet)

⚠️ **This is a simple devnet consensus, not production-ready:**

1. **No Fork Resolution**: If two miners create blocks at same height simultaneously, both might propagate. The first one received wins (not deterministic).

2. **No Byzantine Fault Tolerance**: Doesn't handle malicious nodes trying to create conflicting chains.

3. **No Finality**: Blocks are considered final once accepted, but there's no finality mechanism for deep confirmations.

4. **Devnet Proposer Selection**: Proposer selection is quantum‑weighted and stake‑based, but uses a public QRNG endpoint and simple on‑chain stake tracking (not production‑grade).

5. **No Slashing**: No penalties for invalid behavior.

## How Multiple Nodes Stay Consistent

### Scenario: 3 Nodes Mining

```
Node A (height: 100) ──┐
                       ├── All connected via P2P
Node B (height: 100) ──┤
                       │
Node C (height: 100) ──┘

Node A mines block #101
→ Broadcasts to B and C
→ B validates: ✅ Accepts, height now 101
→ C validates: ✅ Accepts, height now 101
→ All nodes now at height 101

Node B mines block #102
→ Broadcasts to A and C
→ A validates: ✅ Accepts, height now 102
→ C validates: ✅ Accepts, height now 102
→ All nodes now at height 102
```

### If Nodes Get Out of Sync

```
Node A (height: 100)
Node B (height: 102) ← Ahead

When A connects to B:
→ A sends HELLO (height: 100)
→ B sees A is behind, sends TIP (height: 102)
→ A requests blocks 101, 102
→ B sends both blocks
→ A validates and accepts both
→ A catches up to height 102
→ Chains are now consistent
```

## Network Partition Handling

**Current behavior:**
- If network splits, each partition continues mining
- When reconnected, nodes sync to longest chain
- Transactions in shorter chain are lost (reorg)

**Example:**
```
Partition 1: Nodes A, B (mining blocks 100-105)
Partition 2: Nodes C, D (mining blocks 100-103)

When partitions reconnect:
→ C and D see A/B have longer chain (height 105)
→ C and D request blocks 104, 105
→ C and D accept and switch to longer chain
→ Blocks 100-103 from C/D partition are orphaned
```

## Transaction Consistency

Transactions are consistent because:
1. **Same Mempool**: All nodes gossip transactions, so mempools converge
2. **Deterministic Inclusion**: When mining, nodes include transactions from mempool
3. **Same Validation**: All nodes validate transactions the same way
4. **Block Order**: Transactions appear in same order within blocks

## For Production

To make this production-ready, you'd need:

1. **BFT Consensus**: Byzantine Fault Tolerant consensus (e.g., Tendermint, HotStuff)
2. **Finality**: Block finality after N confirmations
3. **Fork Choice**: Deterministic fork resolution (longest chain with tie-breaking)
4. **Validator Set**: Known validator set with stake/weight
5. **Slashing**: Penalties for misbehavior
6. **State Machine**: Proper state transitions (not just scanning chain)

## Proposer Selection (Devnet)

RougeChain devnet uses **quantum‑weighted proposer selection**:

1. **Entropy**: Fetches randomness from a public QRNG endpoint.
2. **Seed**: Hash of `(entropy || lastBlockHash || height)`.
3. **Stake Map**: Derived from on‑chain `stake` / `unstake` txs (by `fromPubKey`).
4. **Selection**: Weighted lottery proportional to stake.

Only the selected proposer should produce the block for that height.

## Current Status

✅ **Works for devnet**: Multiple nodes stay consistent through gossip and validation
⚠️ **Not production-ready**: Needs proper consensus algorithm for mainnet
