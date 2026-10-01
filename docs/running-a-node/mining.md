# Mining (Block Production)

RougeChain uses Proof of Stake, so "mining" refers to block production by validators rather than proof-of-work mining.

## Enable Mining

Start your node with the `--mine` flag:

```bash
./quantum-vault-daemon --mine --api-port 5100
```

This tells the node to try to seal a block whenever it has pending transactions. The miner checks the mempool every `--block-time-ms` (default 400 ms) and wakes early when a new transaction arrives. Empty blocks are never produced, so blocks only appear when there are transactions, and only the designated proposer seals them (see below).

## Requirements

| Requirement | Value |
|-------------|-------|
| Staked XRGE | Minimum 10,000 XRGE |
| Node uptime | Must be online to produce blocks |
| Network sync | Node must be synced to chain tip |

## How Block Production Works

1. **Proposer selection** — Since mainnet height 100, each height has exactly one designated proposer: the eligible validator (stake > 0, not jailed) with the most stake, ties going to the lowest raw public-key bytes. It is deterministic (no randomness, no rotation, no fallback). Every other node refuses to seal, and peers reject blocks from any other proposer. (`GET /api/selection` still shows the legacy QRNG lottery; it is not the consensus rule.)
2. **Block assembly** — The designated proposer collects pending transactions from the mempool. Since height 150 it first waits for the commit certificate of the previous block (precommits from validators holding ⅔ of the stake)
3. **Signing** — The block is signed with the validator's ML-DSA-65 key
4. **Voting** — Validators automatically submit prevote and precommit attestations for each block
5. **Propagation** — The signed block is broadcast to all peers via `POST /api/blocks/import`
6. **Verification** — Receiving nodes verify the signature and block validity before accepting

## Block Timing

| Parameter | Default | Flag |
|-----------|---------|------|
| Miner poll interval | 400ms | `--block-time-ms` |

`--block-time-ms` is how often the miner checks for pending transactions, not a fixed block cadence: a new transaction wakes the miner immediately, and nothing is produced while the mempool is empty. So it is an upper bound on how long a pending transaction waits before the designated proposer tries to seal it. Mainnet nodes run with the default (the `block_time_ms` value in the genesis file is not used for timing).

```bash
# Check the mempool less often (every 5 seconds)
./quantum-vault-daemon --mine --block-time-ms 5000
```

## Mining with Peers

To mine as part of the network (not solo):

```bash
./quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.example.com"
```

The `--public-url` flag is important — it lets other nodes discover and sync from you.

## Monitoring

Check your validator status:

```bash
curl https://testnet.rougechain.io/api/validators
```

Check blocks produced:

```bash
curl https://testnet.rougechain.io/api/blocks?limit=10
```

## Rewards

Every staked, non-jailed validator earns a stake-weighted share of the fees in every block; the proposer also gets a 20% share. Fees are credited when the block is applied to state. See [Staking Rewards](../staking/rewards.md) for details.

## Troubleshooting

### Node not producing blocks

- Ensure `--mine` flag is set
- Verify you have enough XRGE staked (min 10,000)
- Check that your node is synced: `curl http://127.0.0.1:5100/api/health`
- Check whether you are the designated proposer: `designated_proposer_next` in `curl http://127.0.0.1:5100/api/stats`. If it is another key, the log line `not the designated proposer … — not sealing` is expected
- If the log says `waiting for the commit certificate of block …`, validators holding ⅔ of the stake have not yet voted for the tip

### Blocks not propagating

- Ensure `--public-url` is set and accessible from the internet
- Check firewall rules for your API port
- Verify peer connections: `curl http://127.0.0.1:5100/api/peers`

### Producing blocks but no rewards

- Confirm your staking transaction was included in a block
- Check validator status via the API
