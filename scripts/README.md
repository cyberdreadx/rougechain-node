# Bridge Relayer

The bridge relayer connects RougeChain L1 with Base. It runs three jobs in one
polling loop:

1. **Withdrawal fulfillment (L1 → Base):** releases ETH / USDC via the `RougeBridge`
   contract (qETH → `releaseETH`, qUSDC → `releaseERC20`) and XRGE via the BridgeVault
   when users burn qETH / qUSDC / XRGE on L1. Any other token symbol on the EVM feed is
   **never** paid (no default ETH route). Large releases that RougeBridge timelocks are
   persisted in `.bridge-queued-txs.json`, never re-released, and fulfilled from the
   `executeTimelock` transaction; cancellations are surfaced as `CancelledRefundCandidate`.
2. **Deposit watcher (Base → L1):** watches the bridge contracts for deposit events
   and auto-claims them on L1 — users no longer need a manual browser claim.
3. **Failure handling:** reports failed releases to the daemon, alerts on repeated
   failure, and auto-refunds the burned tokens to the owner when a release can't be
   completed.

## Requirements

- **Custody wallet**: the EVM address that holds bridge liquidity. Its private key
  signs releases and it must hold enough ETH/XRGE (plus gas) to pay out withdrawals.
- **RougeBridge contract**: a valid `ROUGE_BRIDGE_ADDRESS` is mandatory. The relayer
  runs a startup preflight (chain id, contract code, owner, paused state, USDC support)
  and refuses to start if any check fails. All qETH/qUSDC payouts are released through
  this contract — there is no direct wallet send mode.
- Base RPC access (defaults to Base Sepolia; set `BASE_CHAIN=mainnet` for the live Base bridge).
- Network access to the RougeChain node API.

## Configuration

The relayer and the daemon share `bridge-relayer.env` (loaded via systemd
`EnvironmentFile`). Copy the template and fill it in:

```bash
cp bridge-relayer.env.example bridge-relayer.env
```

| Variable | Purpose |
|----------|---------|
| `CORE_API_URL` | RougeChain node API (e.g. `http://localhost:5100`) |
| `BRIDGE_CUSTODY_PRIVATE_KEY` | Custody EOA private key (**required**) |
| `BASE_CHAIN` | `mainnet` or `sepolia` (default `sepolia`) |
| `BASE_RPC_URL` | Base RPC URL (this is the name the relayer reads — not `BASE_SEPOLIA_RPC`) |
| `ROUGE_BRIDGE_ADDRESS` | RougeBridge contract (ETH/ERC20). **Mandatory**: startup preflight refuses to run without a valid address that has contract code. qETH/qUSDC payouts go only through `RougeBridge.releaseETH` / `releaseERC20`; there is no direct wallet send path and no env var that enables one |
| `XRGE_BRIDGE_VAULT` | BridgeVault contract (XRGE) |
| `BRIDGE_RELAYER_SECRET` | Shared secret authenticating relayer → daemon calls |
| `POLL_INTERVAL_MS` | Poll interval (default 5000) |
| `CONFIRMATIONS` | Confirmations before acting on a tx (default 2) |
| `AUTO_REFUND` | Auto-refund failed withdrawals (default **`false`**). Even when `true`, qETH/qUSDC refunds are gated by `RougeBridge.processedL1Txs` (RPC failure → refused) and XRGE by the vault's processed guard |
| `ROUGE_BRIDGE_OWNER` | Optional expected `RougeBridge.owner()`; defaults to the custody key's address (checked at startup) |
| `BRIDGE_USDC_ADDRESS` | Optional; if set it must equal the built-in per-chain Base USDC address (checked at startup) |
| `ALERT_WEBHOOK_URL` | Optional Slack/Discord webhook for failure alerts |
| `DEPOSIT_WATCHER` | Enable deposit auto-claim (default `true`) |
| `DEPOSIT_WATCH_FROM_BLOCK` | Optional start block (default: anchor at chain head, no backfill) |
| `DEPOSIT_MAX_BLOCK_SPAN` | Max blocks scanned per poll (default 2000) |

## Running

### systemd (production)

The relayer runs as `bridge-relayer.service`:

```bash
sudo systemctl restart bridge-relayer.service
journalctl -u bridge-relayer.service -f
```

> The unit runs `npx tsx scripts/bridge-relayer.ts` with `EnvironmentFile=bridge-relayer.env`.
> It replaces the old pm2-managed process — do not run both at once, or two relayers
> will share one nonce and double-release.

### Local

```bash
npm run relayer
```

## Flow

**Withdrawals** — polls `GET /api/bridge/withdrawals` (ETH/USDC) and
`GET /api/bridge/xrge/withdrawals` (XRGE):
- Releases `amountUnits × 10^12` wei (ETH) or `amount × 10^18` (XRGE) to `evmAddress`.
- On success: `DELETE /api/bridge/withdrawals/:txId` to mark fulfilled.
- On failure: `POST /api/bridge/withdrawals/:txId/failure`. After repeated failures
  the daemon flags `shouldRefund`, and the relayer calls
  `POST /api/bridge/withdrawals/:txId/refund` to re-mint the tokens to the owner.

**Deposits** — scans `BridgeDepositETH` / `BridgeDepositERC20` (RougeBridge) and
`BridgeDeposit` (vault) over newly confirmed blocks, then calls
`POST /api/bridge/deposit/auto-claim`. The daemon re-verifies the tx on-chain and
dedupes against manual claims. Failed claims are retried each poll; the scan cursor
and dedup set persist in `.bridge-deposit-watcher.json`.

## Health log

Every 60 polls:

```
[health] uptime=… polls=… eth_ok=… eth_fail=… xrge_ok=… xrge_fail=… \
         refunded=… alerts=… deposits_ok=… deposits_pending=… processed=… inflight=…
```

## Security

- **Never commit `bridge-relayer.env`** — it holds the custody private key and relayer
  secret. It is gitignored; commit only `bridge-relayer.env.example`.
- Run on a trusted machine with access to both the node API and Base RPC.
- Keep only the liquidity you need hot; hold excess in cold storage.
