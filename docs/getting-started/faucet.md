# Get Test Tokens

The faucet distributes free XRGE tokens for testing on testnet.

## Using the Web UI

1. Go to the **Wallet** page
2. Click **Request from Faucet**
3. Receive 1,000 XRGE instantly

## Using the API

```bash
curl -X POST https://testnet.rougechain.io/api/faucet \
  -H "Content-Type: application/json" \
  -d '{"publicKey": "your-public-key-here"}'
```

Response:
```json
{
  "success": true,
  "amount": 1000,
  "txId": "abc123..."
}
```

## Rate Limits

| Condition | Limit |
|-----------|-------|
| Per address | 1 request / hour |
| Per IP | 10 requests / hour |
| Whitelisted | Unlimited |

## Whitelisting

For development or testing, addresses can be whitelisted:

```bash
# Start node with whitelist
./quantum-vault-daemon --mine \
  --faucet-whitelist "pubkey1,pubkey2,pubkey3"

# Or via environment variable
export QV_FAUCET_WHITELIST="pubkey1,pubkey2"
./quantum-vault-daemon --mine
```

## Troubleshooting

### "Rate limited"

Wait an hour or use a different address.

### "Faucet disabled"

The node may not have faucet enabled. Check node configuration.

### Transaction not appearing

1. Check the block explorer for your tx
2. Verify you're on the correct network
3. Wait for the next block (1-2 seconds)
