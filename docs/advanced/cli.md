# CLI Wallet

The RougeChain CLI (`rougechain`) is a command-line wallet and chain interaction tool. It provides full access to wallet management, transfers, staking, governance, mail, messenger, and the social layer — all with ML-DSA-65 signed requests.

## Installation

Build from source (requires Rust):

```bash
cd core/cli
cargo build --release
```

The binary is output to `target/release/rougechain` (or `rougechain.exe` on Windows).

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--rpc` | `https://rougechain.rougee.app` | RPC endpoint URL |
| `--wallet-dir` | `~/.rougechain` | Directory for key storage |

All flags are global and can be passed before any subcommand:

```bash
rougechain --rpc https://testnet.rougechain.io/api balance
```

## Key Management

```bash
# Generate a new ML-DSA-65 keypair
rougechain keygen
rougechain keygen --label "my-validator"

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

# Send with custom fee
rougechain transfer <recipient-pubkey> 100 --fee 2
```

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

## Governance

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

# Send encrypted mail
rougechain send-mail bob --subject "Hello" --body "How are you?"

# View inbox
rougechain inbox

# View sent mail
rougechain sent-mail
```

## Messenger

```bash
# Register for messaging
rougechain register-messenger --display-name "Alice"

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

## Signed Requests

All write operations (transfers, staking, mail, messenger, social) use v2 signed requests:

1. The CLI reads your active key from `~/.rougechain/keys.json`
2. Builds a payload with `from`, `timestamp`, and a cryptographic `nonce`
3. Signs the canonical JSON with ML-DSA-65
4. Submits the signed envelope to the `/api/v2/` endpoint

This means your private key never leaves your machine — the node only receives the signature.

## Command Reference

| Command | Description |
|---------|-------------|
| `keygen` | Generate ML-DSA-65 keypair |
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
| `proposals` | List governance proposals |
| `vote` | Cast governance vote |
| `delegate` | Delegate voting power |
| `register-name` | Register mail name |
| `release-name` | Release mail name |
| `resolve-name` | Resolve name → wallet |
| `reverse-lookup` | Wallet → name |
| `send-mail` | Send encrypted mail |
| `inbox` | View inbox |
| `sent-mail` | View sent mail |
| `register-messenger` | Register for messaging |
| `conversations` | List conversations |
| `create-conversation` | Create conversation |
| `messages` | View conversation messages |
| `post` | Create a social post |
| `delete-post` | Delete your post |
| `timeline` | Global timeline |
| `feed` | Following feed |
| `get-post` | View a post |
| `user-posts` | View user's posts |
| `like` | Toggle like |
| `repost` | Toggle repost |
| `rpc` | Raw JSON-RPC call |
