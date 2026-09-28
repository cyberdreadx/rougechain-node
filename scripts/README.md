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

## Daemon withdraw guardrails (EVM + BTC)

- `QV_BRIDGE_WITHDRAW_PAUSED` — emergency kill-switch; blocks all withdrawals when `true`
- `QV_BRIDGE_MAX_WITHDRAW_UNITS` — per-transaction withdrawal cap (0/unset = no cap)
- `QV_BRIDGE_MIN_CONFIRMATIONS` — required Base confirmation depth for deposit claims (default 6)

## BTC ⇄ qBTC relayer (operator notes)

_Moved from the public docs site (docs/bridge/btc-bridge.md)._

### Deploy

#### Daemon env
| Var | Meaning |
|---|---|
| `QV_BRIDGE_BTC_CUSTODY` | Custody BTC address to watch (set to the relayer's derived address). Empty = BTC bridge disabled. |
| `QV_BRIDGE_BTC_NETWORK` | `mainnet` (default) or `testnet`. |
| `QV_BRIDGE_BTC_MIN_CONFIRMATIONS` | Confirmations before honoring a deposit/payout (default 2). |
| `QV_BTC_ESPLORA_PRIMARY` / `QV_BTC_ESPLORA_SECONDARY` | Override the two Esplora bases (network-aware defaults otherwise). |
| `QV_BTC_ALLOW_SINGLE_PROVIDER` | `true` to honor a deposit on the primary alone if the secondary is down (default false = safer). |
| `BRIDGE_RELAYER_SECRET` | Shared secret; the relayer sends it to fulfill payouts. |

#### Relayer
Copy `btc-bridge-relayer.env.example` → `btc-bridge-relayer.env`, fill in `BRIDGE_BTC_CUSTODY_WIF`
and `BRIDGE_RELAYER_SECRET`, then `npm run relayer:btc`. It prints the custody address it derives —
set the daemon's `QV_BRIDGE_BTC_CUSTODY` to that exact address, and fund it.

#### Go-live checklist
1. **Testnet first.** `QV_BRIDGE_BTC_NETWORK=testnet` on both daemon and relayer. Run a full
   deposit + withdraw round-trip. The relayer stays in **dry-run** (`BTC_RELAYER_LIVE` unset) until
   you've watched it build a correct payout.
2. Set `BTC_MAX_WITHDRAW_SATS` to a sane per-payout ceiling.
3. Flip `BTC_RELAYER_LIVE=true` only after the testnet round-trip looks right.
4. On mainnet, keep the custody key cold for the deposit-only period if you want; the hot key is
   only needed once you enable withdrawals. Run the relayer as a singleton (two against one wallet
   can double-spend UTXOs). Keep `BRIDGE_DATA_DIR` persistent (the idempotency state lives there).

#### Emergency stop
`QV_BRIDGE_BTC_CUSTODY` unset disables new deposits; `QV_BRIDGE_WITHDRAW_PAUSED=true` on the daemon
halts all withdrawals (shared kill switch); stop the relayer process to halt payouts.
