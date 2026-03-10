# API Reference — Bridge

## ETH/USDC Bridge

### Get Bridge Config

```
GET /api/bridge/config
```

Returns bridge status, custody address, chain ID, and supported tokens.

**Response:**
```json
{
  "enabled": true,
  "custodyAddress": "0x...",
  "chainId": 84532,
  "supportedTokens": ["ETH", "USDC"]
}
```

### Claim Bridge Deposit

```
POST /api/bridge/claim
```

Claim wrapped tokens (qETH or qUSDC) after depositing on Base Sepolia.

**Body:**
```json
{
  "evmTxHash": "0x...",
  "evmAddress": "0x...",
  "evmSignature": "0x...",
  "recipientRougechainPubkey": "abc123...",
  "token": "ETH"
}
```

The `token` field can be `"ETH"` (default) or `"USDC"`. The node verifies the EVM transaction, checks the signature, and mints the corresponding wrapped token.

### Bridge Withdraw

```
POST /api/bridge/withdraw
```

Burn wrapped tokens and create a pending withdrawal for the relayer.

**Body (signed):**
```json
{
  "fromPublicKey": "abc123...",
  "amountUnits": 10000,
  "evmAddress": "0x...",
  "signature": "...",
  "payload": { "type": "bridge_withdraw", "..." }
}
```

### List Pending Withdrawals

```
GET /api/bridge/withdrawals
```

Returns all pending ETH/USDC withdrawals waiting for the relayer.

### Fulfill Withdrawal

```
DELETE /api/bridge/withdrawals/:txId
```

Mark a withdrawal as fulfilled. Requires `x-bridge-relayer-secret` header or a PQC-signed body.

---

## XRGE Bridge

### Get XRGE Bridge Config

```
GET /api/bridge/xrge/config
```

**Response:**
```json
{
  "enabled": true,
  "vaultAddress": "0x...",
  "tokenAddress": "0x147120faEC9277ec02d957584CFCD92B56A24317",
  "chainId": 84532
}
```

### Claim XRGE Deposit

```
POST /api/bridge/xrge/claim
```

**Body:**
```json
{
  "evmTxHash": "0x...",
  "evmAddress": "0x...",
  "amount": "1000000000000000000",
  "recipientRougechainPubkey": "abc123..."
}
```

### XRGE Withdraw

```
POST /api/bridge/xrge/withdraw
```

**Body (signed):**
```json
{
  "fromPublicKey": "abc123...",
  "amount": 100,
  "evmAddress": "0x...",
  "signature": "...",
  "payload": { "..." }
}
```

### List XRGE Withdrawals

```
GET /api/bridge/xrge/withdrawals
```

### Fulfill XRGE Withdrawal

```
DELETE /api/bridge/xrge/withdrawals/:txId
```
