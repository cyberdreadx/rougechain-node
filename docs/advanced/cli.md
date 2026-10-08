# CLI Wallet

The RougeChain CLI (`rougechain`) is a command-line wallet and chain interaction tool. It provides full access to wallet management, transfers, staking, mail, messenger, and the social layer (plus governance commands for a feature that is suspended since block 245) — all with ML-DSA-65 signed requests.

## Installation

`scripts/install-validator.sh` installs the CLI from the signed node release as
`/usr/local/bin/rougechain` (see [Signed releases](../running-a-node/releases.md)). Or build from
source (requires Rust):

```bash
cd core/cli
cargo build --release
```

The binary is output to `target/release/rougechain` (or `rougechain.exe` on Windows).

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--network` | `mainnet` | `mainnet` (`https://api.rougechain.io`) or `testnet` (`https://testnet.rougechain.io`) |
| `--rpc` | the public node of `--network` | Node base URL, e.g. `http://127.0.0.1:5100` for your own node. Overrides `--network`. A trailing `/` or `/api` is accepted |
| `--chain-id` | the chain id of `--network`; with `--rpc`, the node's own | The network every signature commits to (`chainId` in `/api/v2` requests, `chain_id` in `--legacy-broadcast` envelopes). The CLI compares it with the node's `/api/health` `chain_id` and refuses to sign if they differ (CLI 1.3.0+) |
| `--wallet-dir` | `~/.rougechain` | Directory for key storage |
| `--node-keys` | — | Sign with a node's `node-keys.json` instead of the wallet key store |
| `--legacy-broadcast` | off | Post stake / unstake / transfer as a raw transaction to `/api/tx/broadcast` (see [Signed Requests](#signed-requests)) |

All flags are global and can be passed before any subcommand:

```bash
rougechain --network testnet balance
rougechain --rpc http://127.0.0.1:5100 stats
```

Every request goes to `<base>/api/…` (JSON-RPC to `<base>/api/rpc`).

## Key Management

```bash
# Generate a new ML-DSA-65 keypair
rougechain key-gen
rougechain key-gen --label "my-validator"

# List all saved keys
rougechain keys

# Show the active key's public key and rouge1 address
rougechain whoami
```

Keys are stored in `~/.rougechain/keys.json`. The first key in the file is the "active" key used for signing.

## Wallet & Balance

```bash
# Check XRGE balance (uses active key)
rougechain balance

# Check balance for a specific public key
rougechain balance <pubkey-hex>

# Check all token balances
rougechain token-balances
rougechain token-balances <pubkey-hex>
```

## Transfers

```bash
# Send XRGE
rougechain transfer <recipient-pubkey> 100

# Send another token
rougechain transfer <recipient-pubkey> 100 --token MYTOKEN

# Testnet only: 10,000 test XRGE from the faucet (one claim per key per 24 h)
rougechain --network testnet faucet
```

Amounts are whole units. The node charges a fixed fee of 1 XRGE per transfer.

## Staking & Validators

```bash
# Stake XRGE (minimum 10,000 XRGE)
rougechain stake 10000

# Unstake (enters unbonding queue)
rougechain unstake 5000

# View validators
rougechain validators

# View finality status
rougechain finality
```

## Chain Queries

```bash
# Network stats
rougechain stats

# Get block by height
rougechain block 42

# Get transaction receipt
rougechain receipt <tx-hash>

# List all tokens
rougechain tokens

# List liquidity pools
rougechain pools

# Transaction history
rougechain history
rougechain history --limit 50
rougechain history <pubkey-hex>
```

## Governance (suspended since block 245)

> On-chain governance is **suspended**: since mainnet block 245 a block may not carry `cast_vote` or
> `delegate`, so `vote` and `delegate` cannot take effect on any network at or past the
> monetary-integrity height, and `proposals` lists nothing on mainnet (no proposal was ever created).
> The commands remain in the CLI for the day governance is restored. See
> [Status](../status.md#suspended-since-block-245).

```bash
# List proposals
rougechain proposals

# Cast a vote (yes/no/abstain)
rougechain vote <proposal-id> yes

# Delegate voting power
rougechain delegate <delegate-pubkey>
```

## Name Registry & Mail

```bash
# Register a mail name (e.g., alice@rouge.quant)
rougechain register-name alice

# Release a name
rougechain release-name alice

# Resolve a name to wallet info
rougechain resolve-name alice

# Reverse lookup: wallet → name
rougechain reverse-lookup
rougechain reverse-lookup <pubkey-hex>

# View inbox (sender, time and id of each mail; the CLI cannot decrypt the contents)
rougechain inbox

# View sent mail
rougechain sent-mail
```

## Messenger

> The CLI cannot encrypt or decrypt yet. It lists conversations and messages (who and when), but it
> cannot send messages or mail, read their contents, or handle attachments. `send-mail` and
> `register-messenger` refuse to run. Use [rougechain.io](https://rougechain.io) or Qwalla for messaging
> and mail.

```bash
# List conversations
rougechain conversations

# Create a conversation
rougechain create-conversation <pubkey1>,<pubkey2>

# View messages in a conversation
rougechain messages <conversation-id>
```

## Social

```bash
# Create a post (max 4000 chars)
rougechain post "Hello RougeChain!"

# Reply to a post
rougechain post "Great point!" --reply-to <post-id>

# Delete your own post
rougechain delete-post <post-id>

# Browse the global timeline
rougechain timeline
rougechain timeline --limit 50

# Get your personalized following feed
rougechain feed
rougechain feed --limit 30

# View a specific post with stats
rougechain get-post <post-id>

# View a user's posts
rougechain user-posts
rougechain user-posts <pubkey-hex>

# Like/unlike a post or track (toggle)
rougechain like <post-or-track-id>

# Repost/unrepost (toggle)
rougechain repost <post-id>
```

## Raw RPC

For advanced use, send arbitrary JSON-RPC 2.0 calls:

```bash
rougechain rpc eth_getBalance '["<pubkey-hex>"]'
rougechain rpc rouge_getStats
```

## Verifying a release (offline)

Since CLI 1.2.0, `release verify` checks the **ML-DSA-65** signature of a
[signed release manifest](../running-a-node/releases.md) — no wallet, no node, no network:

```bash
rougechain release verify \
  --manifest manifest-mainnet.json \
  --sig manifest-mainnet.json.mldsa65.sig \
  --pubkey release-mldsa65.pub
# VERIFIED: ML-DSA-65 signature of manifest-mainnet.json (release key ac449798…)
```

The signature covers the exact bytes of the manifest file; the signature file is base64 of the raw
3309-byte signature and the key file is the hex of the raw 1952-byte public key
(`releases/keys/release-mldsa65.pub`). Exit status: `0` verified, `1` the signature does not
verify, `2` a file is missing or malformed. The printed fingerprint is the SHA-256 of the raw
public key. This is the check a node's [automatic updater](../running-a-node/auto-update.md) runs
before it installs a release.

## Signed Requests

Transfers, staking, the faucet, names, mail, messenger and social use v2 signed requests — the same
format the SDK and the web wallet send:

1. The CLI reads your active key from `~/.rougechain/keys.json` (or `--node-keys`)
2. Builds a payload with `from`, `timestamp`, and a cryptographic `nonce`
3. Signs the canonical JSON (sorted keys) with ML-DSA-65
4. Submits `{ payload, signature, public_key }` to the `/api/v2/` endpoint — `stake` → `/api/v2/stake`,
   `unstake` → `/api/v2/unstake`, `transfer` → `/api/v2/transfer`, `faucet` → `/api/v2/faucet`. For
   these four the request also carries `payload_bytes_hex`, the exact bytes that were signed.

This means your private key never leaves your machine — the node only receives the signature. A
request is valid for 5 minutes around its `timestamp`, so the machine's clock must be correct.

`vote` and `delegate` have no v2 route: they are posted as a raw signed transaction to
`/api/tx/broadcast`. The public nodes do not accept that route from the internet, and a node that
does accept it only places the transaction in its own mempool — so these two commands work only
against the node that proposes blocks. `--legacy-broadcast` sends stake / unstake / transfer the
same way; use it only against your own node.

`stake`, `unstake`, `transfer` and `faucet` exit with a non-zero status when the node refuses the
request.

## Command Reference

| Command | Description |
|---------|-------------|
| `key-gen` | Generate ML-DSA-65 keypair |
| `keys` | List saved keys |
| `whoami` | Show active key info |
| `balance` | Check XRGE balance |
| `token-balances` | Check all token balances |
| `transfer` | Send XRGE |
| `stake` | Stake XRGE |
| `unstake` | Unstake XRGE |
| `validators` | List validators |
| `stats` | Network statistics |
| `block` | Get block by height |
| `receipt` | Get transaction receipt |
| `tokens` | List all tokens |
| `pools` | List liquidity pools |
| `finality` | Finality status |
| `history` | Transaction history |
| `proposals` | List governance proposals (suspended since block 245; empty on mainnet) |
| `vote` | Cast governance vote (suspended since block 245) |
| `delegate` | Delegate voting power (suspended since block 245) |
| `register-name` | Register mail name |
| `release-name` | Release mail name |
| `resolve-name` | Resolve name → wallet |
| `reverse-lookup` | Wallet → name |
| `send-mail` | Not supported yet (mail must be end-to-end encrypted) — use rougechain.io or Qwalla |
| `inbox` | View inbox |
| `sent-mail` | View sent mail |
| `register-messenger` | Not supported yet (needs an encryption key) — use rougechain.io or Qwalla |
| `conversations` | List conversations |
| `create-conversation` | Create conversation |
| `messages` | List messages in a conversation (sender and time; contents stay encrypted) |
| `post` | Create a social post |
| `delete-post` | Delete your post |
| `timeline` | Global timeline |
| `feed` | Following feed |
| `get-post` | View a post |
| `user-posts` | View user's posts |
| `like` | Toggle like |
| `repost` | Toggle repost |
| `rpc` | Raw JSON-RPC call |
| `release verify` | Verify the ML-DSA-65 signature of a release manifest (offline) |
