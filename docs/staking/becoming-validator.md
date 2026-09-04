# Becoming a Validator

Validators propose blocks and earn fees on RougeChain. This guide targets **mainnet** (`rougechain-mainnet-1`, real value, no faucet). To practice first, see [Testing on testnet](#testing-on-testnet-first) at the end.

## The one thing you must understand

Your validator identity is a **single ML-DSA-65 keypair** that does two jobs:

1. it **holds your stake** — staking from a key registers *that key* as a validator, and
2. it **signs the blocks** your node proposes.

Your node stores this keypair at `<data-dir>/node-keys.json`. **The network rejects any block whose proposer is not a staked validator** — so your node's `node-keys.json` key and your staked key must be the **same key**. If you stake from one key but run your node with a different (freshly generated) key, your blocks are rejected by every peer and you earn nothing, with no obvious error. This is the most common way to get validator setup wrong.

> **Security:** this key signs blocks on an always-online, internet-facing server. Use a **dedicated key that holds only your stake** — never your main treasury wallet. If the server is compromised, the blast radius is limited to the staked amount.

## Prerequisites

- **≥ 10,000 XRGE** (+ ~0.1 XRGE fee) for the standard tier — see [tiers](#validator-tiers).
- A **server** — see [system requirements](../running-a-node/README.md#system-requirements) and [installation](../running-a-node/installation.md).
- The **daemon** (`quantum-vault-daemon`) and the **CLI** (`rougechain`).

## Validator tiers

Your tier is derived automatically from your total stake:

| Tier | Minimum stake | Commission on delegations |
|------|---------------|---------------------------|
| Standard | 10,000 XRGE | 5% |
| Operator | 100,000 XRGE | 10% |
| Genesis | 1,000,000 XRGE | 15% |

## Step 1 — Install and generate your node identity

Install the daemon ([installation guide](../running-a-node/installation.md)), then start it once so it creates its identity keypair and begins syncing:

```bash
./quantum-vault-daemon \
  --genesis daemon/genesis-mainnet.json \
  --chain-id rougechain-mainnet-1 \
  --peers https://api.rougechain.io/api \
  --data-dir ~/.quantum-vault/mainnet \
  --api-port 5100 --port 4100 \
  --node-name my-validator
```

On first boot it logs:

```
[node] Generated and saved new node keys (pub: <your-node-pubkey>...)
```

Your identity keypair now lives at `~/.quantum-vault/mainnet/node-keys.json` (fields: `algorithm`, `public_key_hex`, `secret_key_hex`). **Back this file up, offline.** Losing it means losing your validator identity — and the ability to unstake. Let the node sync to the chain tip before continuing.

## Step 2 — Point the CLI at your node's key

No key copying needed — the CLI signs **directly** from your node's identity file with the `--node-keys` flag, so you act as exactly the key your node signs blocks with:

```bash
rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json whoami
```

This prints your validator's public key + `rouge1…` address — confirm it matches the key the daemon logged in Step 1. Every command below uses the same `--node-keys` flag. (The CLI defaults to the mainnet RPC.)

## Step 3 — Fund and stake

Send **≥ 10,000 XRGE (+ ~0.1 XRGE fee)** to your validator address (from `whoami` above) from your main wallet. Then stake it:

```bash
rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json stake 10000
```

> The 10,000 minimum is enforced on **every** stake call — a smaller top-up is rejected. Each additional stake must itself be ≥ 10,000; totals accumulate.

Verify with the built-in diagnostic — it checks funded / staked / active / producing in one shot:

```bash
rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json validator-status
```

You want `✓ Staked` and `✓ In active set`. (It prints the exact fix next to anything that's ✗.)

## Step 4 — Start mining

Restart the daemon with `--mine` (same key, same data-dir), plus a public URL so peers can reach you:

```bash
./quantum-vault-daemon \
  --mine \
  --genesis daemon/genesis-mainnet.json \
  --chain-id rougechain-mainnet-1 \
  --peers https://api.rougechain.io/api \
  --data-dir ~/.quantum-vault/mainnet \
  --api-port 5100 --port 4100 \
  --node-name my-validator \
  --public-url https://my-validator.example.com
```

Because your `node-keys.json` key is now a staked validator, peers accept your blocks. Check progress anytime with:

```bash
rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json validator-status
```

You're fully live once it shows `✓ Producing blocks`.

## Proposer selection

Selection is **stake-weighted**, mixed with **quantum entropy** (ANU QRNG, falling back to a local CSPRNG), plus block context for verifiability. Even a minimum-stake validator proposes blocks — just less often.

## Security & slashing — read before you go live

- **Dedicated key.** Keep only the stake in your validator key; never use your treasury wallet. (Done, if you followed Step 1.)
- **One node per key.** **Never run two nodes with the same key** — double-signing is slashable equivocation.
- **Back up `node-keys.json`** offline. It is the only copy of your validator identity.
- **Don't expose the daemon port.** Bind to localhost, front it with nginx + TLS, and firewall the RPC/API port. See [public-node security](../p2p-networking/public-node.md). Do **not** open port 5100 to the public internet.
- **Watch for missed blocks.** Missing **50 blocks** triggers an auto-slash; each violation costs **10%** of stake and jails you for ~20 blocks. Alert on your node being offline or lagging the chain tip (`/api/health` height vs the network).
- **Never run `--dev`** on a mainnet node — it enables unsafe key-accepting endpoints.
- **Avoid unattended auto-restart** (e.g. an auto-deploy cron) on a validator: a restart during your proposal slot loses blocks, and auto-pulling unreviewed code is a supply-chain risk. Upgrade deliberately.

## Increasing stake / leaving

- **Add stake:** `rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json stake 10000` again (≥ 10,000 each time).
- **Leave:** `rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json unstake <amount>` enters the **~500-block unbonding** queue; dropping below 10,000 removes you from the active set. See [Staking](README.md).

## Testing on testnet first

Practice the whole flow with no real value: swap the mainnet flags for testnet —
`--chain-id rougechain-devnet-1`, `--peers https://testnet.rougechain.io/api`, `--data-dir ~/.quantum-vault/testnet` — point the CLI at it with `rougechain --rpc https://testnet.rougechain.io/api …`, and use the wallet **faucet** to get test XRGE. Everything else is identical.
