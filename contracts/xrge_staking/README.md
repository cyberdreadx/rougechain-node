# XRGE staking — stake XRGE, share a funded reward pot

Holders stake XRGE with the contract and share a reward pot that streams over time. Rewards are
only ever what someone paid in: the contract mints nothing. All amounts are integer **quanta**
(1 XRGE = 10⁹ quanta).

This is **reward sharing, not validator staking**. XRGE held here does not count as validator
stake and has no effect on block production. Needs payable calls (mainnet block 190, testnet 1200).

| Method | Args | What it does |
|---|---|---|
| `stake` | `{}` + `attach: {"symbol":"XRGE","amount":N}` | Adds N to the caller's stake. An account holds at least **1 XRGE** or nothing. Emits `staked`. |
| `request_unstake` | `{"amount":N}` | N stops earning now and can be withdrawn after the delay. What is left staked must be 0 or at least 1 XRGE. A later request restarts the delay for everything pending. Emits `unstake_requested`. |
| `cancel_unstake` | `{}` | Puts everything pending back to work. Emits `unstake_cancelled`. |
| `withdraw` | `{}` | Pays the pending principal back once the delay has passed. Emits `withdrawn`. |
| `claim` | `{}` | Pays the caller's rewards. Emits `claimed`. |
| `fund` | `{"duration":S}` + XRGE attached | Adds to the pot and streams everything not yet streamed over S seconds from now (1 day to 365 days). Emits `funded` `{"amount","duration","reward_rate","period_end","reserve"}`. |
| `info` *(read)* | `{}` | `{"total_staked","total_pending","reserve","reward_rate","period_end","streaming","now","min_stake","unstake_delay"}`. `reward_rate` is quanta per second. |
| `account` *(read)* | `{"address":"rouge1…"}` | `{"address","staked","earned","pending","unlock_at","withdrawable"}`. `earned` is what `claim` would pay now. |

The account events carry `{"address","amount","staked","pending","unlock_at","total_staked"}`.

## Rules

- **Unstake delay: 3 days** of block time (`UNSTAKE_DELAY_SECS` in `src/pool.rs`). Pending principal
  earns nothing. The delay is fixed in the deployed code; nobody can change it afterwards.
- **Rewards stream per second.** Each second of the stream is shared by the stakers of that second
  in proportion to their stake, so staking just before a funding earns nothing extra.
- **The stream pauses while nobody is staked**: its end moves out by the idle time, so no funded
  reward is lost to an empty pool.
- **Anyone may fund.** A funding during a running stream must not lower its rate — otherwise a
  dust-sized funding with a long duration could stretch someone else's pot. To top up a running
  stream, add enough for the chosen duration, or wait until it ends.
- **No admin.** Nobody can move a staker's principal, pause withdrawals, or take the pot back. Once
  funded, rewards can only leave through `claim`.
- **Accounts are keyed by `rouge1…` address** and payouts go to that address. Only a wallet can
  stake; a contract caller is refused.
- **Principal and rewards are tracked apart.** The contract's XRGE always equals
  `total_staked + total_pending + reserve`, and a claim is capped by `reserve`, so rewards are never
  paid out of anyone's principal.
- A wrong symbol, a missing or unexpected payment, or a refused request makes the call fail, and an
  attached payment goes back to the caller.

**Never send XRGE to the contract address with a plain transfer.** It is not credited to anyone and
nothing can return it. Always use `stake` or `fund`.

Rounding always favours the contract by a few quanta. That dust stays in `reserve`.

## Build and test

```bash
cargo test                                             # the accounting (src/pool.rs), natively
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_xrge_staking.wasm (a prebuilt copy is xrge_staking.wasm)
```

## With the SDK

```ts
const { address: pool } = await rc.contracts.publish(wallet, wasmBytes);
const s = rc.contracts.game(pool, wallet);

await s.call("stake", {}, { attach: { symbol: "XRGE", amount: xrgeToQuanta("250") } });
await s.call("fund", { duration: 30 * 86400 }, { attach: { symbol: "XRGE", amount: xrgeToQuanta("10000") } });
await s.call("claim", {});
await s.call("request_unstake", { amount: 250_000_000_000 });   // quanta, as a JSON integer
// three days later
await s.call("withdraw", {});
```

Reads go through `POST /api/contract/<pool>/query` with `{"method":"account","args":{"address":"rouge1…"}}`.
