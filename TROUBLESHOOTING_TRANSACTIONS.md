# Troubleshooting: Transactions Not Showing

## Issue
Transactions are submitted but not appearing in the UI transaction history.

## Common Causes

### 1. Transactions in Mempool (Not Yet Mined)

**Symptom**: Transaction submitted successfully, but not in blocks yet.

**Solution**: Wait for next block (default: 1 second). Transactions are included when the next block is mined.

**Check**:
```bash
# Check node logs
sudo journalctl -u quantum-vault-daemon -f
```

### 2. Empty Blocks (No Transactions)

**Symptom**: Blocks are being mined but contain 0 transactions.

**Possible causes**:
- Mempool is empty when block is mined
- Transactions are being rejected

**Check**:
```bash
# Confirm blocks are being produced
curl http://localhost:5100/api/blocks?limit=5
```

### 3. Transaction Format Mismatch

**Symptom**: Transactions submitted but rejected.

**Check node logs for errors**:
```bash
sudo journalctl -u quantum-vault-daemon -f
```

**Solution**: Ensure transaction is properly signed before submission.

### 4. UI Not Refreshing

**Symptom**: Transactions are in blocks but UI doesn't show them.

**Solution**: 
- UI now auto-refreshes every 3 seconds
- Check browser console for errors
- Verify `VITE_NODE_API_URL_TESTNET` or `VITE_NODE_API_URL_MAINNET` is set correctly

### 5. Reading from Wrong Source

**Symptom**: UI shows old Supabase transactions but not new node transactions.

**Solution**: 
- `getAllTransactions()` now reads from node API first
- Falls back to Supabase only if node unavailable
- Check browser console for "Node API unavailable" messages

## Debugging Steps

### Step 1: Verify Transaction Submission

```bash
# Submit a test transaction via API
curl -X POST http://localhost:5100/api/tx/submit \
  -H "Content-Type: application/json" \
  -d '{
    "fromPrivateKey": "...",
    "fromPublicKey": "...",
    "toPublicKey": "...",
    "amount": 100
  }'

# Should return: {"success": true, "txId": "...", "tx": {...}}
```

### Step 2: Check Mempool

Check node logs for request errors:
```
sudo journalctl -u quantum-vault-daemon -f
```

### Step 3: Check Block Inclusion

```bash
curl http://localhost:5100/api/blocks?limit=5
```

### Step 4: Verify Blocks API

```bash
# Check if blocks contain transactions
curl http://localhost:5100/api/blocks | jq '.blocks[].txs | length'

# Should show transaction counts per block
```

### Step 5: Check UI Console

Open browser DevTools → Console:
- Look for: `[Wallet] Loaded X transactions from Y blocks`
- Check for errors fetching from node API

## Quick Fixes

### Force Refresh UI
- The Wallet page now auto-refreshes every 3 seconds
- Or click the refresh button manually

### Check Node is Mining
```bash
curl http://localhost:5100/api/health
```

### Verify API is Accessible
```bash
curl http://localhost:5100/api/stats
curl http://localhost:5100/api/blocks
```

## Expected Flow

1. **User submits transaction** → `/api/tx/submit`
2. **Node accepts** → Added to mempool
3. **Node broadcasts** → Gossiped to peers
4. **Next block mined** → Transactions included
5. **UI fetches blocks** → `/api/blocks`
6. **UI parses transactions** → Shows in history

## If Still Not Working

1. **Check node logs**: `sudo journalctl -u quantum-vault-daemon -f`
2. **Check browser console**: Look for errors
3. **Verify API URL**: Ensure `VITE_NODE_API_URL_TESTNET` / `VITE_NODE_API_URL_MAINNET` point to your node
4. **Test API directly**: `curl http://your-node:5100/api/blocks`
5. **Check transaction format**: Ensure payload matches expected structure

## Transaction Lifecycle

```
Submit → Mempool → Next Block → Chain → UI Display
  ↓         ↓          ↓          ↓         ↓
 API     acceptTx   tryProduce  append   getAllTransactions
```

Each step should log to console. Check logs to see where it's failing.
