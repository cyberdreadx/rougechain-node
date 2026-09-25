# Troubleshooting

Common issues and how to fix them.

---

## Node Issues

### Node won't start

**"Address already in use"**

Another process is using the port. Find it and stop it, or use a different port:

```bash
# Linux/macOS
lsof -i :5100
kill -9 <PID>

# Windows (PowerShell)
Get-Process -Id (Get-NetTCPConnection -LocalPort 5100).OwningProcess
Stop-Process -Id <PID>

# Or just use a different port
./quantum-vault-daemon --api-port 5102
```

**"cargo not found"**

Rust isn't in your PATH. Fix with:

```bash
source ~/.cargo/env
# Or restart your terminal
```

**"OpenSSL not found" (build error)**

Install OpenSSL development headers:

```bash
# Ubuntu/Debian
sudo apt install libssl-dev pkg-config

# Fedora/RHEL
sudo dnf install openssl-devel

# macOS
brew install openssl

# Windows — install Visual Studio Build Tools with C++ workload
```

---

### Node won't sync

| Check | How |
|-------|-----|
| Node is running | `curl http://127.0.0.1:5100/api/health` |
| Peers are correct | Make sure `--peers` includes `/api` (e.g. mainnet `--peers "https://api.rougechain.io/api"`) |
| Genesis + chain-id match the network | Mainnet needs `--genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1`. A wrong/missing genesis or chain-id makes a fresh node fail to join — its `/api/health` `chain_id` must read `rougechain-mainnet-1` |
| Firewall isn't blocking | Ensure your `--api-port` / P2P port reachability is correct |
| Network is reachable | mainnet `curl https://api.rougechain.io/api/health` (or testnet `https://testnet.rougechain.io/api/health`) |

**Peers value of 0**

Your node isn't connected to anyone. Check:
- You passed `--peers` with the correct URL (including `/api`)
- Your internet connection is working
- The testnet node is online: `curl https://testnet.rougechain.io/api/stats`

**Height stuck at 0**

If your node's chain height isn't advancing:
- Ensure `--peers` is set (solo nodes without peers don't receive blocks)
- If you're mining solo (`--mine` without `--peers`), blocks are only produced locally
- Check logs for sync errors

---

### Blocks not propagating

If you're mining but other nodes don't see your blocks:

1. **Set `--public-url`** — Without this, your node is invisible to the network. Other nodes can't sync from you.
2. **Check your firewall** — Your API port must be reachable from the internet
3. **Verify with peers API:**
   ```bash
   curl https://testnet.rougechain.io/api/peers
   # Your node's URL should appear in the list
   ```

---

## Transaction Issues

### "Insufficient balance"

Transaction amount + fee must be less than your balance. The fee is **0.1 XRGE** per transfer.

```
Required: amount + 0.1 XRGE
```

Use the faucet to get more tokens:
- Website: Go to the **Wallet** page and click "Request Faucet"
- API: `POST /api/v2/faucet`

### "Transaction rejected"

Common causes:

| Cause | Fix |
|-------|-----|
| Wrong signature | Ensure you're signing with the correct private key |
| Duplicate transaction | Wait a moment and retry — the previous tx may still be processing |
| Node not synced | Check `GET /api/health` — your node's height should match the network |
| Stale nonce | Refresh your wallet state and retry |

### "Failed to fetch" in the web app

- Check you're connected to the right network (Testnet vs local Devnet)
- If using local devnet, make sure the daemon is running
- Check browser console (`F12`) for the actual error
- Verify CORS: a self-hosted node only allows a built-in set of origins by default — set `QV_CORS_ORIGINS` or run with `--dev` (see [Configuration → Browser access](running-a-node/configuration.md)). The public `testnet`/`api.rougechain.io` endpoints already send `Access-Control-Allow-Origin: *`, so if you're hitting those, CORS is not the cause.

---

## Wallet Issues

### Wallet not loading

- Clear browser cache and `localStorage`
- Check the browser console for errors (`F12` → Console)
- Try a different browser
- If using the extension, check it's enabled and not suspended

### Lost private key

**There is no recovery mechanism.** Private keys are stored locally in your browser. If you clear browser data, the keys are gone.

**Best practice:** Always export and safely store your keys after creating a wallet.

### Extension not connecting

- Check the extension is enabled in your browser
- Ensure you're on a supported page (the extension injects on pages that need it)
- Try disabling and re-enabling the extension
- Check if another wallet extension is conflicting

---

## Staking Issues

### Can't stake — "insufficient balance"

You need at least **10,000 XRGE** plus the transaction fee — the 10,000 XRGE minimum is enforced on every stake call. Use the faucet if needed.

### Staked but not producing blocks

- **Most common cause: your node's key is not your staked key.** Your node signs
  blocks with the keypair in `<data-dir>/node-keys.json`, and peers **reject**
  blocks whose proposer isn't a staked validator. If you staked from one key but
  the node runs with a different (auto-generated) key, your blocks are silently
  rejected. The node's `node-keys.json` key and your staked key must be the
  **same key** — see [Becoming a Validator](staking/becoming-validator.md).
- Ensure the `--mine` flag is set on your node
- Your node must be synced (height matches the network)
- Validator selection is stake-weighted — with minimum stake, you'll produce blocks less frequently
- Check your validator status: `GET /api/validators` — your node's public key should appear with active stake

### Unstaked but balance not returned

After unstaking, the tokens are returned to your wallet address. Check your balance:

```bash
curl "https://testnet.rougechain.io/api/balance/YOUR_PUBLIC_KEY"
```

---

## Bridge Issues

### Bridge deposit not credited

1. Confirm the EVM transaction was confirmed on Base Sepolia
2. Wait up to 2 minutes — the bridge relayer polls periodically
3. Check the bridge config: `GET /api/bridge/config`
4. Verify the custody address matches your bridge target

### Withdrawal pending

Withdrawals require the bridge relayer to process them. Check status:

```bash
curl "https://testnet.rougechain.io/api/bridge/withdrawals"
```

---

## DEX Issues

### Swap failed — "slippage exceeded"

The price moved between your quote and execution. Increase your slippage tolerance or retry.

### Pool creation failed

- Both tokens must exist on the network
- You need sufficient balance of both tokens
- Pool creation fee is **10 XRGE**

---

## Platform-Specific

### Windows: Build fails

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **C++ desktop workload**
2. Install [Rust](https://rustup.rs) — make sure `cargo` is in your PATH
3. Restart your terminal after installation

### Windows: Permission denied

Run PowerShell as Administrator, or check that your antivirus isn't blocking the daemon.

### macOS: "developer cannot be verified"

```bash
xattr -d com.apple.quarantine ./target/release/quantum-vault-daemon
```

---

## Still Stuck?

- Check the [GitHub Issues](https://github.com/cyberdreadx/rougechain-node/issues)
- Visit the built-in node dashboard at `http://localhost:5100` for live diagnostics
- Review daemon logs (stderr output) for detailed error messages
