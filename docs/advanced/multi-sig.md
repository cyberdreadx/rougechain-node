# Multi-Signature Wallets

RougeChain supports M-of-N multi-signature wallets with PQC-safe ML-DSA-65 aggregate verification.

## Overview

A multi-sig wallet requires `M` out of `N` co-signers to approve a transaction before it executes. This enables:

- **Shared treasury management** — DAOs, teams, and organizations
- **Secure cold storage** — 2-of-3 schemes (e.g. hardware + phone + backup)
- **Escrow** — Buyer + seller + arbitrator

## Transaction Types

### Create a Wallet

```json
{
  "tx_type": "multisig_create",
  "payload": {
    "multisig_signers": ["pubkey_hex_1", "pubkey_hex_2", "pubkey_hex_3"],
    "multisig_threshold": 2,
    "multisig_label": "Team Treasury"
  }
}
```

- Minimum 2 signers
- Threshold must be ≥ 1 and ≤ number of signers
- Wallet ID is auto-generated if not provided

### Submit a Proposal

```json
{
  "tx_type": "multisig_submit",
  "payload": {
    "multisig_wallet_id": "ms-abc123...",
    "multisig_proposal_tx_type": "transfer",
    "multisig_proposal_payload": {
      "to_pub_key_hex": "recipient_pubkey_hex",
      "amount": 1000
    },
    "multisig_proposal_fee": 0.1
  }
}
```

- Only signers of the wallet can submit proposals
- The submitter's signature counts as the first approval

### Approve a Proposal

```json
{
  "tx_type": "multisig_approve",
  "payload": {
    "multisig_proposal_id": "mp-def456..."
  }
}
```

- Only signers who haven't already approved can approve
- When threshold is reached, the proposal auto-executes
- For `transfer` proposals: funds move from the wallet creator's balance

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/multisig/wallets` | List all multi-sig wallets |
| GET | `/api/multisig/wallet/:id` | Get wallet details |
| GET | `/api/multisig/wallet/:id/proposals` | List proposals for a wallet |
| GET | `/api/multisig/wallets/:pubkey` | Find wallets where pubkey is a signer |

### Response Format

```json
{
  "success": true,
  "wallet": {
    "wallet_id": "ms-abc123...",
    "creator": "pubkey_hex",
    "signers": ["pubkey1", "pubkey2", "pubkey3"],
    "threshold": 2,
    "created_at_height": 500,
    "label": "Team Treasury"
  }
}
```

## SDK

```typescript
import { RougeChain } from '@rougechain/sdk';

const rc = new RougeChain({ baseUrl: 'https://rougechain.io' });

// Create a 2-of-3 wallet
await rc.sendTransaction({
  txType: 'multisig_create',
  payload: {
    multisig_signers: [keyA, keyB, keyC],
    multisig_threshold: 2,
    multisig_label: 'Team Treasury',
  },
});

// Submit a transfer proposal
await rc.sendTransaction({
  txType: 'multisig_submit',
  payload: {
    multisig_wallet_id: 'ms-abc123...',
    multisig_proposal_tx_type: 'transfer',
    multisig_proposal_payload: { to_pub_key_hex: recipient, amount: 1000 },
  },
});

// Co-signer approves
await rc.sendTransaction({
  txType: 'multisig_approve',
  payload: { multisig_proposal_id: 'mp-def456...' },
});

// Query wallets
const wallets = await rc.get('/api/multisig/wallets');
const myWallets = await rc.get(`/api/multisig/wallets/${myPubKey}`);
```
