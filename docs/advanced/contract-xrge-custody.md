# Contract XRGE Custody (RougeChain v2)

> **Live on mainnet since v2 (block 18).** WASM contracts can now hold and move XRGE.

Before v2, a contract could *receive* XRGE but never *spend* it — funds sent to a
contract address were locked forever. As of the v2 fork, contracts are
first-class holders of XRGE: they can custody a balance and pay it out from
within their own execution.

## The unit: quanta

XRGE is counted internally in **quanta**, its smallest indivisible unit:

```
1 XRGE = 1,000,000,000 quanta   (10^9)
```

This is the wei ↔ ETH model. **Contracts do integer math in quanta**; wallets and
UIs render the decimal XRGE. There are no floating-point amounts anywhere in a
contract — everything is exact integers, so a payout can never drift or round
ambiguously. A 1-XRGE three-way split is `333_333_333` quanta to each recipient
with a `1`-quanta remainder — exact, conserved to the atom.

## Host functions

```
host_get_balance(addr_ptr, addr_len) -> i64      // returns the address's balance in QUANTA
host_transfer(to_ptr, to_len, amount_i64) -> i32 // moves `amount` QUANTA from THIS contract to `to`
                                                 // returns 0 on success, 1 on refusal
```

- `amount` is in **quanta**. A negative amount is rejected.
- A contract can only transfer **its own** balance — `host_transfer` always debits
  the executing contract's address.
- If the contract's balance can't cover `amount`, the transfer returns `1` and
  **nothing moves** (no partial transfer, no delta recorded).

## The two rules the chain enforces

Every set of moves a contract makes in a call is checked before any balance
changes, all-or-nothing:

1. **Conservation** — the moves must net to exactly zero. A contract can never
   mint or burn XRGE, only move it.
2. **No overdraft** — no account may go below zero. A contract can only move
   quanta it actually holds.

Break either and the whole call's balance effects are rejected.

## v1 limitation: single-hop

XRGE custody is **single-hop** in this release: a contract moves *its own* XRGE.
Cross-contract XRGE moves (contract A calls contract B, and B pays out) are **not
applied** — cross-calls still work for compute/storage, but XRGE does not move
across a hop. Design payout logic so each contract moves only its own balance.

## Determinism & deployment

- Deploy transactions now **carry the contract bytecode on-chain**; every node
  installs it on import and re-executes identically. No separate code
  distribution step.
- Call arguments are recorded on the transaction, so on-chain re-execution
  matches what the caller signed.
- A call a node cannot execute deterministically (missing code, VM error) is
  rejected — the network fails closed rather than silently diverging. A contract
  that simply reverts or runs out of gas is normal: no moves, the block proceeds.

## Example: a royalty splitter

```wat
(module
  (import "env" "host_transfer" (func $tr (param i32 i32 i64) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0)  "alice")
  (data (i32.const 16) "bob")
  (data (i32.const 32) "carol")
  ;; send 1 XRGE (1e9 quanta) to each of three recipients
  (func (export "split") (result i32)
    (drop (call $tr (i32.const 0)  (i32.const 5) (i64.const 1000000000)))
    (drop (call $tr (i32.const 16) (i32.const 3) (i64.const 1000000000)))
    (call $tr (i32.const 32) (i32.const 5) (i64.const 1000000000))))
```

Fund the contract, call `split`, and 1 XRGE lands in each of three wallets —
conserved exactly, agreed by every node.

## What this changes for NFT royalties (qRougee)

Previously the NFT `royaltyRecipient` **had** to be a wallet — routing royalties
to a contract address would lock them. With v2 custody that constraint relaxes:
a splitter contract can receive royalties and fan them to collaborators on-chain
(single-hop). Off-chain payout wallets are no longer the only safe option.
