# Becoming a Validator

Validators propose blocks and earn fees on RougeChain. This guide targets **mainnet** (`rougechain-mainnet-1`, real value, no faucet). To practice first, see [Testing on testnet](#testing-on-testnet-first) at the end.

## Quick install (one command)

On a fresh **Ubuntu 22.04 / 24.04 or Debian 12** server (x86_64; a ~$5/mo VPS is plenty), the
installer downloads the current **signed release** of the node — nothing is compiled — sets it up as
a `systemd` service under a dedicated user, and starts syncing:

```bash
curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh | sudo bash
```

> **Status (2026-10-01):** the release signing key is still being provisioned. Until it is embedded
> in the installer, the script stops with a "no release signing key yet" message and changes
> nothing; use the manual walkthrough below in the meantime. See [Signed releases](../running-a-node/releases.md).

**What it verifies.** The installer fetches the release manifest and its Ed25519 signature
(`api.rougechain.io`, falling back to the GitHub mirror), checks the signature with `openssl`
against the release public key that is **embedded in the script**, and only then downloads the
binary and checks its size and sha256 against the signed manifest. If anything does not match, it
stops and installs nothing. To check a release yourself, or to see what the script would do
without changing anything:

```bash
curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh | bash -s -- --dry-run
```

(`--dry-run` needs no root, but `curl`, `openssl` and `jq` must already be installed.) Verifying a
release by hand with `openssl` is described in [Signed releases](../running-a-node/releases.md#verify-a-release-by-hand).

**What it sets up.** Node `/usr/local/bin/quantum-vault-daemon` and the CLI
`/usr/local/bin/rougechain`, both from the signed release; service `rougechain-validator`
running as the system user `rougechain`; data and `node-keys.json` in `/var/lib/rougechain/mainnet`
(key file mode `0600`); API on `127.0.0.1:5100`. It generates a node key only if there is none and
never overwrites an existing key or chain data. Settings are environment variables placed after
`sudo`, for example `NODE_NAME=my-validator`, `NETWORK=testnet`, `NO_START=1` — the full list is in
[Signed releases](../running-a-node/releases.md#what-the-installer-does).

**It installs a full node, not yet a validator.** Block production (`--mine`) stays off until you
ask for it, because a node should not claim to produce blocks with a key that is not staked:

1. Run the installer (above). **Back up `/var/lib/rougechain/mainnet/node-keys.json` offline.**
2. **Fund and stake ≥ 10,000 XRGE** from that key with the installed `rougechain` CLI. The key
   file is readable only by the `rougechain` user, so run the CLI as that user:

   ```bash
   K=/var/lib/rougechain/mainnet/node-keys.json
   sudo -u rougechain rougechain --node-keys $K whoami            # your validator address
   # send ≥ 10,000 XRGE (+ 1 XRGE fee) to that address from your main wallet, then:
   sudo -u rougechain rougechain --node-keys $K stake 10000
   sudo -u rougechain rougechain --node-keys $K validator-status
   ```

   (Without `sudo`, as root: `runuser -u rougechain -- rougechain …`.) Details of each command are
   in [Step 2](#step-2--point-the-cli-at-your-nodes-key) and [Step 3](#step-3--fund-and-stake) below.
3. Once `validator-status` shows `✓ Staked` and `✓ In active set`, turn on block production and
   give peers a URL they can reach over HTTPS (peers talk to each other over the REST API; there is
   no separate P2P port):

   ```bash
   curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh \
     | sudo VALIDATOR=1 PUBLIC_URL=https://node.example.com bash
   ```

The node then votes on blocks automatically and proposes whenever it is the
[designated proposer](#proposer-selection). **To upgrade, re-run the installer**: it verifies the
new signed release, keeps the previous binary as `quantum-vault-daemon.prev`, and restarts the
service (add `NO_START=1` to restart later yourself). The rest of this page is the manual
walkthrough if you would rather do each step yourself.

## The one thing you must understand

Your validator identity is a **single ML-DSA-65 keypair** that does two jobs:

1. it **holds your stake** — staking from a key registers *that key* as a validator, and
2. it **signs the blocks** your node proposes.

Your node stores this keypair at `<data-dir>/node-keys.json`. **The network rejects any block whose proposer is not a staked validator** (and, since height 100, any block whose proposer is not the [designated proposer](#proposer-selection)) — so your node's `node-keys.json` key and your staked key must be the **same key**. If you stake from one key but run your node with a different (freshly generated) key, your blocks are rejected by every peer and you earn nothing, with no obvious error. This is the most common way to get validator setup wrong.

> **Security:** this key signs blocks on an always-online, internet-facing server. Use a **dedicated key that holds only your stake** — never your main treasury wallet. If the server is compromised, the blast radius is limited to the staked amount.

## Prerequisites

- **≥ 10,000 XRGE** (+ 1 XRGE fee) for the standard tier — see [tiers](#validator-tiers).
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

This prints your validator's public key + `rouge1…` address — confirm it matches the key the daemon logged in Step 1. Every command below uses the same `--node-keys` flag. The CLI talks to the public mainnet node (`https://api.rougechain.io`) unless you pass `--network testnet` or `--rpc <your node>`; `stake`, `unstake` and `transfer` are submitted through the node's signed `/api/v2` routes, so they work from any machine. This needs a CLI built from the current source (or the one the installer provides): older builds default to a retired host and post to a route the public node refuses.

## Step 3 — Fund and stake

Send **≥ 10,000 XRGE (+ 1 XRGE fee)** to your validator address (from `whoami` above) from your main wallet. Then stake it:

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

Because your `node-keys.json` key is now a staked validator, your node votes toward each block's commit certificate, and peers accept your blocks whenever you are the designated proposer. Check progress anytime with:

```bash
rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json validator-status
```

You're fully live once you're staked, in the active set and synced. `✓ Producing blocks` counts blocks you have proposed, so it only turns green once you have been the designated proposer (the largest stake); see [Proposer selection](#proposer-selection).

## Proposer selection

Since mainnet height 100 (Release 1), each block has exactly one **designated proposer**: the eligible validator (stake > 0, not jailed) with the **most stake**; ties go to the lowest raw public-key bytes. Selection is deterministic: there is no randomness, no QRNG and no rotation, so a validator that does not hold the most stake does not propose blocks. Every staked, non-jailed validator still earns a stake-weighted share of the fees in every block (see [Rewards](rewards.md)). There is no fallback proposer yet: if the designated proposer is offline, no blocks are produced until it returns. See [Adding a Validator](adding-a-validator.md) for how this affects a new validator.

> The designated proposer for the next height is `designated_proposer_next` in `GET /api/stats`, and `proposer` in `GET /api/selection` (which reports `rule: "designated_max_stake"` and no entropy fields once the rule is active).

## Security & slashing — read before you go live

- **Dedicated key.** Keep only the stake in your validator key; never use your treasury wallet. (Done, if you followed Step 1.)
- **One node per key.** **Never run two nodes with the same key** — two nodes can sign two different blocks or votes at one height (equivocation). Slashing on equivocation evidence is planned.
- **Back up `node-keys.json`** offline. It is the only copy of your validator identity.
- **Don't expose the daemon port.** Bind to localhost, front it with nginx + TLS, and firewall the RPC/API port. See [public-node security](../p2p-networking/public-node.md). Do **not** open port 5100 to the public internet.
- **Stay online.** Automatic missed-block slashing is **frozen** since height 100 (a slash costs **10%** of stake plus a 20-block jail). But if you are the designated proposer and go offline, the chain stops producing blocks, and an offline validator's vote is missing from the ⅔-stake commit certificate. Alert on your node being offline or lagging the chain tip (`/api/health` height vs the network).
- **Never run `--dev`** on a mainnet node — it enables unsafe key-accepting endpoints.
- **Avoid unattended auto-restart** (e.g. an auto-deploy cron) on a validator: a restart while you are the designated proposer stalls block production, and auto-pulling unreviewed code is a supply-chain risk. Upgrade deliberately.

## Increasing stake / leaving

- **Add stake:** `rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json stake 10000` again (≥ 10,000 each time).
- **Leave:** `rougechain --node-keys ~/.quantum-vault/mainnet/node-keys.json unstake <amount>` enters the **500-block unbonding** queue (wall-clock time depends on how often blocks are produced); dropping to 0 stake removes you from the active set. See [Staking](README.md).

## Testing on testnet first

Practice the whole flow with no real value: swap the mainnet flags for testnet —
`--chain-id rougechain-devnet-1`, `--peers https://testnet.rougechain.io/api`, `--data-dir ~/.quantum-vault/testnet` — point the CLI at it with `rougechain --network testnet …`, and get test XRGE from the faucet (`rougechain --network testnet --node-keys <path> faucet`, 10,000 per key per 24 h — staking 10,000 needs 10,001 with the fee, so top up with a transfer from a second key or the wallet). Everything else is identical.

With the installer: `curl -sSL …/install-validator.sh | sudo NETWORK=testnet bash` (service
`rougechain-validator-testnet`, data in `/var/lib/rougechain/testnet`, API on `127.0.0.1:5101`, CLI
installed as `rougechain-testnet`; run it as `sudo -u rougechain rougechain-testnet --network testnet --node-keys /var/lib/rougechain/testnet/node-keys.json …`).
