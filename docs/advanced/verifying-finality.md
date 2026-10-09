# Verifying Finality

A node's API answers "this transaction succeeded" because the node says so. If you accept
deposits, settle trades or release goods on that answer, you are trusting that one node.
`verifyTxFinalized` from `@rougechain/sdk` (1.14.0 or later) checks the claim against the chain
itself: it proves that a transaction is included in a **finalized** block, using only hashes and
signatures it recomputes.

```javascript
import { verifyTxFinalized } from "@rougechain/sdk";

const result = await verifyTxFinalized({
  txHash: "72952313b71c7fea36a4f553e0eeb3b5e5e09b95e49a5ea33c326d0dd9c25cf1",
  nodes: ["https://api.rougechain.io/api", "https://node-b.example/api", "https://node-c.example/api"],
  chainId: "rougechain-mainnet-1",
  trustedValidatorSet: PINNED_SET, // see "Pin the validator set" below
});

if (result.status === "finalized") {
  // Included and final. Whether it SUCCEEDED is a separate question: see result.outcome.
}
```

## Results

| `status` | Meaning |
|---|---|
| `finalized` | The transaction is in a block whose integrity, proposer signature and finality certificate all verified, and a strict majority of `nodes` serve that same block. |
| `included-not-finalized` | The transaction is in a valid block, but there is no finality certificate yet (normally the newest block), too few of `nodes` answered, no validator set could be obtained, or `minConfirmations` is not met. Ask again later. |
| `not-found` | No node knows the transaction, the block at the height a node named does not contain it, or the block could not be fetched. |
| `invalid` | Something failed verification: a hash, a signature, the chain id, the certificate, or two nodes serving different blocks at the same height. Do not accept the payment. Read `checks` to see which part failed. |

The result also contains:

- `height`, `blockHash` (recomputed, not copied from the node), `txIndex`.
- `trust`: `"pinned validator set"` or `"node-reported validator set"`.
- `proof`: the header fields, where the certificate came from, the verified certificate
  (signers, voting stake, total stake, quorum) and the nodes that agreed.
- `outcome`: `{ source: "node receipt", verified: false, value }`. See below.
- `checks`: every check performed, each `{ name, ok, critical, detail, node }`. A check with
  `critical: false` is informational and does not change `status`.

## What is verified

The verifier recomputes every hash it relies on. It never uses a node's `hash`, `txId`,
`success` or `finalizedHeight` field as an input.

1. **The transaction is in the block.** It fetches the block (`GET /api/blocks?from_height=H`),
   hashes each transaction exactly as the node does (SHA-256 of the transaction's canonical JSON)
   and looks for `txHash`. The height a node reports for the transaction is only a hint.
2. **The block's transaction list matches its header.** It recomputes the header's `tx_hash`
   from the full transaction list, so a transaction added, removed, altered or reordered is
   detected.
3. **The header is the one the proposer signed.** It recomputes the block hash,
   `SHA-256(header JSON ‖ proposer signature)`, verifies the proposer's ML-DSA-65 signature over
   the header, and checks that the header's `chain_id` is the `chainId` you passed.
4. **The block is finalized.** It takes the finality certificate for that height (from the next
   block's `parent_commit`, or from `GET /api/finality/:height`) and checks every precommit:
   its ML-DSA-65 signature over
   `ROUGECHAIN_FINALITY_VOTE_V2|chain=<chain id>|type=precommit|height=<H>|round=0|block=<block hash>`,
   that it is for this exact block, and that each signer is a distinct validator in the set used.
   The signers' stake must reach the quorum `floor(2 × total stake / 3) + 1`. The voting stake,
   total stake and quorum written inside the certificate are compared with the recomputed
   values afterwards; they are never used as inputs.
5. **The nodes agree.** Every node in `nodes` is asked for the block at that height. A strict
   majority must serve the same (recomputed) block hash. Any node serving a different block at
   that height makes the result `invalid`. Unreachable nodes count as neither.

`fetchAndVerifyBlock(height, { node, chainId })` runs steps 2 and 3 for one block and returns the
verified block and the next block. `verifyBlock` and `verifyFinalityCertificate` work on data you
already have.

## What is NOT verified

### Whether the transaction succeeded

**Inclusion and finality do not prove that a transaction succeeded.** A transaction that fails
during execution, for example a transfer from an account with too little balance, is still
included in the block and still finalized. Whether it succeeded is recorded in the node's
receipt, and the receipt is **not committed in the block header**. No signature or certificate
covers it.

`verifyTxFinalized` therefore returns the receipt status separately and marks it unverified:

```javascript
result.outcome; // { source: "node receipt", verified: false, value: "Success" }
                // or { ..., value: { Failed: "reason" } }
```

Treat `outcome.value` as the node's word. To reduce that trust, ask several independent nodes
and compare, or check the resulting balance on several nodes. A planned protocol upgrade on the
roadmap will commit each transaction's outcome to the block header; once it is live, the
verifier can check outcomes the same way it checks inclusion.

### The validator set, unless you pin it

A certificate is only as good as the validator set it is checked against. If you do not pass
`trustedValidatorSet`, the verifier fetches the set from the node that served the block
(`GET /api/validators`) and reports `trust: "node-reported validator set"`. A dishonest node can
then invent a validator set containing keys it controls, sign a certificate with them, and the
check would pass. **Without a pinned set, you trust that node for the validator set.**

Nodes only expose the **current** validator set, not the set that applied at a past height. A
stake change since then can make a certificate's written totals differ from the current set
(reported as informational `cert.claim.*` checks) or, if a past signer is no longer a
validator, make an older certificate fail against the current set.

### State

Balances, token supplies and contract state are not checked. Only inclusion and finality are.

## Pin the validator set

For real security, obtain the validator public keys and stakes from a source you trust (your own
node, several operators, a published list you check) and pass them:

```javascript
const PINNED_SET = {
  validators: [
    { publicKey: "8ccf7878…", stake: 100090000n },
    { publicKey: "21e0ed0a…", stake: 9000n },
    { publicKey: "c97f59a2…", stake: 10000n },
  ],
  // optional: the height this set applies to. When it equals the block's height, the
  // certificate's written totals must match exactly.
  height: undefined,
};
```

List only eligible validators (staked and not jailed). Stakes are in the node's raw stake units,
as `/api/validators` reports them. Update the pinned set when the validator set changes; a stale
set makes new certificates fail (`invalid`), which is the safe direction.

## Background

- **Finality exists since block 150.** From block 151 every block header carries the verified
  finality certificate of its parent (see [Finality](../staking/finality.md)). Blocks before 150
  have no certificate and return `included-not-finalized`.
- **One block proposer today.** Mainnet currently has a single designated proposer, and the
  largest validator holds more than two thirds of the stake, so its signature alone meets the
  quorum. The verifier checks the rule as written; it does not make the validator set more
  decentralized than it is.
- **`minConfirmations`** (default 1) additionally requires `tip − height + 1` blocks. It is
  optional: a verified certificate already makes a block final.
- Pass `fetch` to use your own HTTP client, and `timeoutMs` (default 15,000) per request.
