# Get Test Tokens

The faucet distributes free XRGE tokens for testing on testnet.

## Using the Web UI

1. Go to the **Wallet** page
2. Click **Request from Faucet**
3. Receive 10,000 XRGE instantly

## Using the API

```bash
curl -X POST https://testnet.rougechain.io/api/faucet \
  -H "Content-Type: application/json" \
  -d '{"recipientPublicKey": "your-hex-public-key-here"}'
```

> The field is `recipientPublicKey` and must be a **raw hex public key**, not a `rouge1…` address. The faucet is **OFF by default** and must be explicitly enabled with `--faucet-enabled` (or `QV_FAUCET_ENABLED=1`) — it is for dev/testnet only, and mainnet must never set it. When disabled, requests return `"Faucet is disabled on this network."`

Response:
```json
{
  "success": true,
  "txId": "abc123...",
  "tx": { "...": "the faucet transfer (TxV1)" },
  "error": null
}
```

The signed `POST /api/v2/faucet` endpoint (used by the SDK) instead returns `{ "success": true, "message": "Faucet: 10000 XRGE sent" }`, without a transaction id.

## Rate Limits

| Condition | Limit |
|-----------|-------|
| Per address | 1 request / 24 hours |

The cooldown is shared by `POST /api/faucet` and `POST /api/v2/faucet` (one claim per key per 24 hours, whichever endpoint is used) and starts only after a successful payout. There is no per-IP rate limit. A request is also rejected if the recipient already has a pending faucet transaction, or if their balance exceeds the faucet threshold.

## Whitelisting

The whitelist **gates** faucet access — it does not grant a higher rate. When `QV_FAUCET_WHITELIST` is set, only the listed addresses may use the faucet (both `/api/faucet` and the signed `/api/v2/faucet`, which returns `403`); everyone else is blocked. Leave it unset to allow any address (subject to the 24-hour cooldown).

```bash
# Start node with the faucet enabled and a whitelist
./quantum-vault-daemon --mine --faucet-enabled \
  --faucet-whitelist "pubkey1,pubkey2,pubkey3"

# Or via environment variables
export QV_FAUCET_ENABLED=1
export QV_FAUCET_WHITELIST="pubkey1,pubkey2"
./quantum-vault-daemon --mine
```

## Troubleshooting

### "Rate limited"

Each address can request once every 24 hours. Wait for the cooldown to elapse or use a different address.

### "Faucet disabled"

The node may not have faucet enabled. Check node configuration.

### Transaction not appearing

1. Check the block explorer for your tx
2. Verify you're on the correct network
3. Wait for the next block (1-2 seconds)
