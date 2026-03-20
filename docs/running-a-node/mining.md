# Mining (Block Production)

RougeChain uses Proof of Stake, so "mining" refers to block production by validators rather than proof-of-work mining.

## Enable Mining

Start your node with the `--mine` flag:

```bash
./quantum-vault-daemon --mine --api-port 5100
```

This tells the node to produce blocks at the configured interval (default: 400ms).

## Requirements

| Requirement | Value |
|-------------|-------|
| Staked XRGE | Minimum 1,000 XRGE |
| Node uptime | Must be online to produce blocks |
| Network sync | Node must be synced to chain tip |

## How Block Production Works

1. **Validator selection** — Each block slot, the network selects a proposer based on stake weight and quantum entropy
2. **Block assembly** — The selected validator collects pending transactions from the mempool
3. **Signing** — The block is signed with the validator's ML-DSA-65 key
4. **Propagation** — The signed block is broadcast to all peers via `POST /api/blocks/import`
5. **Verification** — Receiving nodes verify the signature and block validity before accepting

## Block Timing

| Parameter | Default | Flag |
|-----------|---------|------|
| Block time | 400ms | `--block-time-ms` |

```bash
# Slower blocks (5 seconds)
./quantum-vault-daemon --mine --block-time-ms 5000

# Faster blocks (500ms, for local dev)
./quantum-vault-daemon --mine --block-time-ms 500
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

Validators earn transaction fees from blocks they produce. Fees are credited immediately when a block is finalized. See [Staking Rewards](../staking/rewards.md) for details.

## Troubleshooting

### Node not producing blocks

- Ensure `--mine` flag is set
- Verify you have enough XRGE staked (min 1,000)
- Check that your node is synced: `curl http://127.0.0.1:5100/api/health`

### Blocks not propagating

- Ensure `--public-url` is set and accessible from the internet
- Check firewall rules for your API port
- Verify peer connections: `curl http://127.0.0.1:5100/api/peers`

### Producing blocks but no rewards

- Confirm your staking transaction was included in a block
- Check validator status via the API
