# Shielded pool V2 — protocol specification (SPEC v1)

## 1. Status and scope

**Status: SPEC v1, frozen for implementation and audit. Nothing in this document is active on any
network.** It is documentation only: it changes no code and sets no activation height.

*Amended 2026-10-06 after the node implementation review (`core/shield-v2/REVIEW_NODE_1.md`):* the
pre-activation paragraph of §3 (what happens to a V2 transaction below A — the previous release's
treatment, mirrored exactly — plus the activation runbook note it used to defer), the `version`
pin of the signer-less envelope (§3.1, §3.6 check 2; R1-4), and the mempool / producer SHOULDs of
§4.6 (R1-2, R1-3, R1-5). No frozen constant, encoding or consensus rule from A changed.

*Amended 2026-10-06 with the wallet core (`core/shield-v2-wallet`, `core/shield-v2-wasm`, the
`prover` feature of `core/shield-v2`; notes in `core/shield-v2-wallet/NOTES.md`):* (W-1) §2.11 —
the wallet prover's signature is `prove_spend(witness, public)`; (W-2) §3.1 — which bytes the
account key of a `shield_v2` signs when the wallet core builds it, and how absent payload fields
are written; (W-3) §3.4 / §5.2 — "no salt" and "32 zero bytes" are the same HKDF input; (W-4)
§5.3 and §9.2 — the textual form of a shielded address is fixed provisionally (O-11); (W-5) §5.4 —
what scanning needs besides the viewing key, and how a wallet learns that its listing no longer
matches the chain; (W-6) §5.5 — a wallet does not build a shield whose `fee` equals `v_in`; (W-7)
§5.6 — the hedge of item 4 as implemented, with a per-call counter (O-14 implemented, review
pending); (W-8) §8.1, new §8.4 — the wallet vectors, normative (O-15). No constant, tag, encoding
or parameter of §2 changed, and no consensus rule.

*Amended 2026-10-06 after the wallet core review (`core/shield-v2-wallet/REVIEW_WALLET_1.md`,
findings F-1 … F-7):* (W-9) §5.3, §8.4, §9.1 O-11, §9.2 — the textual shielded address carries a
version byte and an 8-byte integrity value; the first textual form is withdrawn and MUST be
refused (F-2); `keys.json` regenerated; (W-10) §5.4 — a wallet MUST NOT present an incoming
payment as final on one node's word: notes are *unverified* until the wallet's tree root has been
matched against a quorum of nodes, and what that does and does not prove (F-1); what a state
scanned with the viewing key alone must remember (F-3); every listed string is validated before it
is stored (F-4); (W-11) §5.5 — pending transactions: inputs stay locked until the scanned chain
shows the transaction mined or expired, never on a node's answer; `expiry_height` is bounded;
a fee ceiling (F-7); (W-12) §3.4, §5.6 item 6, §5.7 — every random value of a transaction comes
from one hedged per-transaction generator (F-5); (W-13) new §5.8 — privacy from the node. Wallet
rules only: no constant, tag, encoding or parameter of §2 changed, no body or ciphertext format
of §3, and no consensus rule; the vectors `note_encryption.json`, `transactions.json` and
`state_root.json` are byte-for-byte unchanged.

*Amended 2026-10-06 after the second wallet core review
(`core/shield-v2-wallet/REVIEW_WALLET_2.md`, findings RW2-1 … RW2-8):* (W-14) §5.4 — the state
check covers BOTH halves of the pool state of §4.8: a wallet rebuilds the running nullifier hash
from the listing as it rebuilds the tree, and a height is confirmed only when a quorum of nodes
reports the wallet's root AND nullifier hash AND both counts; the quorum is at least a strict
majority of the nodes asked and any conflicting report confirms nothing (RW2-2, RW2-4); what the
node's report is and that its height is the pool's own (RW2-6); notes below a minimum value are
counted and not stored (RW2-7); (W-15) §5.5 — **the settlement of a pending transaction is
rewritten**: a wallet records both output commitments, and a transaction is *mined*, *superseded*
or *expired* only at a confirmed height, by its own nullifiers and outputs; nothing else releases
a lock (RW2-1, RW2-2, RW2-3, RW2-5). **A sentence of the W-11 text was wrong and is withdrawn**:
"a matching root at a height at or above `expiry_height` shows that the tree those nodes hold
does not contain the transaction's outputs" — a matching root shows only that the two trees are
the same. Also corrected: the anchor window does not bound how long a transaction stays valid;
only `expiry_height` does (§4.3 item 8 is annotated, §5.5 says it). Wallet rules and one node API
answer only: no constant, tag, encoding or parameter of §2 changed, no body or ciphertext format
of §3, and no consensus rule.

*Amended 2026-10-06 after the third wallet core review
(`core/shield-v2-wallet/REVIEW_WALLET_3.md`, findings RW3-1 … RW3-10; its guarantees G1–G4 are
restated in §5.5):* (W-16) §5.4 — **the quorum is a strict majority of the nodes the wallet is
CONFIGURED with**, a property of the wallet state and never of the reports at hand; node
identities are canonical http(s) origins; a dissenting minority is named and does not block, and
a listing that most nodes contradict, or that runs ahead of the quorum, is to be replaced
(RW3-1, RW3-8); the state check gains a third value, **`ciphertext_acc`**, a running hash over
every output's commitment and two ciphertexts that each node keeps **node-locally, outside the
pool state of §4.8 and outside the state root**, so that a quorum vouches for the ciphertexts a
listing served (RW3-2); the report is the record of the last *accepted* block (RW3-6); the cap on
stored notes counts unspent notes only and is a parameter (RW3-4); a wallet's own outputs are
stored whatever their size and never depend on a ciphertext (RW3-2, RW3-3); (W-17) §5.5 — **the
anchor and the expiry of a transfer or unshield are taken from the wallet's confirmed height,
never from a height one node claimed** (`expiry_height ≤ confirmed height + 128`), which makes
settlement bounded (RW3-7); **building and locking are one operation** (RW3-5); locks are per
device, and what a restored device must do (RW3-10). Wallet rules, one node-local value and one
node API answer only: no constant, tag, encoding or parameter of §2 changed, no body or
ciphertext format of §3, no consensus rule, and **the state root of §4.8 is byte-for-byte what
it was**.

*Amended 2026-10-06 after the fourth wallet core review
(`core/shield-v2-wallet/REVIEW_WALLET_4.md`, findings RW4-1 … RW4-12):* (W-18) §5.4 — a node
identity that is an IP literal has ONE spelling, a configured set is `https` only (loopback
development sets excepted) with **one node per host** (RW4-2, RW4-7); **a pending record holds
its input notes by commitment and nullifier, never by a leaf position**, leaf numbers in a
listing are the listing node's claim, and **a wallet library never hands out or writes a state
that it would not read back**, and gives up the locks of a stored state it cannot read instead
of forcing a restore (RW4-5); a state scanned without the nullifier key is marked and offers
nothing to spend (RW4-3); (W-19) §5.5 — **the embargo after a restore is the wallet library's
rule, not the user interface's**, measured from a base that a stale quorum cannot lower below
what the answering honest nodes support, with its arithmetic and the assumption that remains
(RW4-1; item (b) of W-17 is replaced); "payment to self" is the WHOLE address and a recipient
with the wallet's own `pk` under another encryption key is refused (RW4-4); the wallet's own
shield is recorded like its change (RW4-11); a state's revision identifies its content
(RW4-10); and **the client loop** is written out as a SHOULD (RW4-8, RW4-9). Wallet rules
only: no constant, tag, encoding or parameter of §2 changed, no body or ciphertext format of
§3, no consensus rule, no node rule, and the state root of §4.8 is byte-for-byte what it was.

*Amended 2026-10-07 after the fifth wallet core review
(`core/shield-v2-wallet/REVIEW_WALLET_5.md`, findings RW5-1 … RW5-9; verdict: ready for UI
integration with conditions):* (W-20) §5.4 — **a page that is not the listing of a chain is
refused as a listing error, never applied**: a note under the nullifiers of a note the wallet
already holds, and a spend listed below the height of the note it spends (RW5-1); an IPv6
literal that only spells an IPv4 address is that IPv4 host (RW5-7); a wallet library reads no
state text that does not say where it stands with the restore embargo (RW5-9); §5.5 — the
user's statement that overrides the embargo **stands once recorded** (the SHOULD of W-19 that
disregarded it is withdrawn, RW5-5), and who may make it is a rule for the client; **the
client loop is restated as a terminating algorithm** (RW5-2, RW5-3): a listing node is banned
on evidence and left without it, the state is rescanned when the listing node changes unless
all of it is confirmed, there is a rule for every error and a stop. What a client owes its
user is `core/shield-v2-wallet/UI_CONTRACT.md`. Wallet rules only, as before: nothing of §2,
§3 or §4 changed.

This document specifies the shielded pool V2 of RougeChain for two readers: the implementer of a
node (validation, state, consensus) and the implementer of a wallet (keys, notes, proving). It is
normative. The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

### 1.1 Sources

| Source | Used for |
|---|---|
| `research/shield3/SPEC_DRAFT.md` | the cryptographic layer (§2), carried over without change |
| `research/shield3/REVIEW2.md` | findings L-1 … L-5, all resolved here (§4, §5, §7) |
| `research/shield2/REVIEW.md` | finding F-6 (blinding seed), resolved in §5.6 |
| `research/shield3/RESULTS.md`, `README.md` | measurements; the statements corrected in §7 |
| `docs/SHIELDED_POOL_V2_DESIGN.md`, draft 4, on branch `design/shielded-pool-v2` | the design and the owner's decisions (its §14) |
| `core/daemon/src/node.rs`, `state_root.rs`, `upgrades.rs`, `core/types/src/lib.rs` | how the chain declares upgrades, commits state and rejects blocks today |

The research code this document refers to is `research/shield3/src` with git tree hash
`8a435868500d47af9b5223663bfd4e8e89f839c4` (last changed in commit `598ad0e`; unchanged at
`54c8c42`, the commit this document was written against). The copy of the design document in
`docs/` on the research branches is draft 1 and is not the one used here.

### 1.2 What is frozen

* Every constant, domain tag, encoding and verifier parameter of the cryptographic layer (§2).
* The node consensus rules of §4 and the wallet rules of §5.
* The transaction body layout of §3, except for the values marked **[P]**.

A value marked **[P]** ("provisional") had to be chosen for this document to be byte-exact, but no
input fixes it. Each is listed in §9.2 for the owner to confirm or change. A change to a **[P]**
value before the first activation is an edit of this document; after an activation it is a fork.

### 1.3 What is not frozen

* **Activation heights.** They are chosen by the chain owner later. Until then, on every network:

  ```
  SHIELD_V2_ACTIVATION_HEIGHT = None      (mainnet, rougechain-mainnet-1)
  SHIELD_V2_ACTIVATION_HEIGHT = None      (testnet, rougechain-devnet-1)
  ```

  The height is declared per network in the upgrade schedule (`upgrades.rs`, one
  `Option<u64>` field per network, `None` = not scheduled), like every other upgrade. It is a
  compiled constant, never an operator setting.
* The open issues of §9.
* Wallet user interface, node API routes, explorer presentation.

### 1.4 Relation to V1

The V1 transaction types `shield`, `shielded_transfer` and `unshield` stay in
`SUSPENDED_TX_TYPES` permanently. V1 proved value balance only. V2 shares no state, no note and no
code path with V1: the V1 commitment store, nullifier store and shielded-supply counter are not V2
state and MUST NOT be read or written by any V2 rule.

### 1.5 Terms and notation

| Term | Meaning |
|---|---|
| quanta | the ledger's integer base unit: 1 XRGE = 10^9 quanta. Every amount in this document is an unsigned integer number of quanta |
| F, p | the base field and its modulus (§2.1) |
| digest | 8 elements of F; 32 bytes in public data (§2.8) |
| `H(D; …)`, `H(D, k; …)`, `H_rho` | the domain-separated sponge of §2.2 |
| note | `(value, pk, rho, r)` (§2.4) |
| `cm` | a note commitment (§2.4) |
| `nf` | a nullifier (§2.5) |
| anchor | a root of the commitment tree named by a transaction (§4.3) |
| body | the 2,546-byte canonical encoding of a V2 transaction without its proof (§3.2) |
| pool total | the public integer amount of quanta held by the pool (§4.4) |
| A | `SHIELD_V2_ACTIVATION_HEIGHT` of the network, once set |
| H | the height of the block being validated |
| `‖` | concatenation |
| LE, BE | little-endian, big-endian |

Numbers are decimal unless written `0x…`.

---

## 2. Cryptographic layer

This section is `research/shield3/SPEC_DRAFT.md` §§1–10 with the same constants, tags, encodings
and parameters. Where the draft marked a research shortcut, the resolution is stated in §2.12.
The test vectors of the draft's §11 are in §8.

### 2.1 Field and extension

| | |
|---|---|
| Base field F | KoalaBear, p = 2^31 − 2^24 + 1 = 2130706433 = `0x7f000001` |
| Canonical form | an integer in [0, p) |
| Challenge field | F^8 = F[X] / (X^8 − 3), the library's `BinomialExtensionField<KoalaBear, 8>` (≈ 248 bits) |
| Two-adic generator, roots of unity | the library's (`p3-koala-bear` v0.8.0) |

"The library" is Plonky3 v0.8.0, commit `a21e3ed42905040ad49c519e402f018381c12d0c`, unmodified.

### 2.2 Hash

**Permutation.** Poseidon2 over KoalaBear, width 24, S-box x^3, 8 external (4 + 4) and 23 internal
rounds, with the round constants and linear layers of
`p3_koala_bear::default_koalabear_poseidon2_24` at the library commit above (constants
`KOALABEAR_POSEIDON2_RC_24_EXTERNAL_INITIAL`, `…_EXTERNAL_FINAL`, `…_INTERNAL`). The permutation
begins with one application of the external linear layer, as in the Poseidon2 paper. An
implementation MUST reproduce the permutation test vector of §8.1.

**Sponge `H(D; x_0 … x_{n−1})`** (n ≤ 28 here), and its indexed form `H(D, k; x_0 … x_{n−1})` with
`H(D; …) = H(D, 0; …)`:

1. state = 24 zeros; `state[16] = n`, `state[17] = D`, `state[18] = k`. Rate = `state[0..16]`,
   capacity = `state[16..24]`.
2. For each chunk of up to 16 inputs: add the chunk element-wise into `state[0..]` (a short last
   chunk leaves the remaining rate elements unchanged — zero padding), then apply the permutation.
3. Output = `state[0..8]`.

The length in the capacity makes zero padding injective. Inputs longer than 16 elements keep the
capacity from the first block (the domain and length are absorbed once).

**Domain tags D:** 1 = `nk`, 2 = `pk`, 3 = `nf`, 4 = note commitment, 5 = Merkle node, 6 = output
rho. **Lengths n:** 8 (keys), 16 (nullifier, Merkle node, output rho), 28 (commitment).
**Index k:** 0 everywhere except the output rho, where it is the 0-based output index.

**`H_rho(nf1, nf2, k) = H(6, k; nf1[0..8] ‖ nf2[0..8])`**, k ∈ {0, 1}: one permutation of the state
`nf1 ‖ nf2 ‖ [16, 6, k, 0, 0, 0, 0, 0]`. Tag 6 is used by nothing else, so no value of `H_rho` is a
nullifier (tag 3), a Merkle node (tag 5) or any other hash of the same 16 elements; k separates
the two outputs of one transaction.

**Security of every hash in this section:** an 8-element digest and capacity (≈ 248 bits):
collisions cost ≈ 2^124 classically and ≈ 2^83 with a quantum collision search. This caps the
security of the whole statement, whatever §2.9 says about the proof system (§6).

### 2.3 Keys

| | |
|---|---|
| `sk` | 8 field elements; derived from the wallet secret as in §5.2 |
| `nk` | `H(1; sk)` |
| `pk` | `H(2; sk)` |

The circuit fixes these two derivations. The design document's label notation for `nk` and `pk`
(`H("rouge-shield/nk" ‖ sk)`, `H("rouge-shield/pk" ‖ sk)`) is superseded by the tags above (§7).

### 2.4 Notes and commitments

A note is `(value, pk, rho, r)`: `value` a u64 number of quanta; `pk`, `rho`, `r` digests. Of these
the creator of a note chooses `value`, `pk` and `r`; `rho` is determined by the creating
transaction.

`value` is encoded as four 16-bit limbs, least significant first:
`limb_j = (value >> 16 j) & 0xffff`.

`cm = H(4; pk[0..8] ‖ rho[0..8] ‖ limb_0 … limb_3 ‖ r[0..8])` — 28 elements, two permutations: the
first block is `pk ‖ rho`; the second adds the limbs into `state[0..4]` and `r` into
`state[4..12]`.

**`rho` of an output note.** For output j ∈ {1, 2} of a transaction with public nullifiers `nf1`,
`nf2`:

`rho'_j = H_rho(nf1, nf2, j − 1)`

The circuit computes it and forces `cm_out_j` to be a commitment with exactly this `rho` (§2.7
item 3). The sender has no influence on it beyond choosing which notes (or dummies) to spend. This
holds for all three operations: a shield has two dummy inputs, and dummies publish nullifiers
(§2.5).

*Why two different notes cannot get the same `rho`.* Two outputs of one transaction differ in the
index. Two different accepted transactions differ in `nf1` and in `nf2` **provided the node
enforces every rule of §4.2 and §4.3 and the wallet rule of §5.7** — not the nullifier-set lookup
alone (§7, correction C-3). Under those rules any two distinct outputs on the chain are `H_rho` of
different inputs, and equal `rho` would be a collision of `H_rho`. The verifier's `nf1 ≠ nf2` rule
(§2.7 item 5) is what makes "insert both nullifiers" well defined. A transaction that is not
accepted creates no notes.

*Consequence for the nullifier.* `nf = H(3; nk ‖ rho)` with a `rho` that is unique per note: two
different notes of one owner cannot have the same nullifier (up to a hash collision).

*`rho'` is public.* Anyone can compute it from the transaction. Hiding of the commitment rests on
`r` alone; unlinkability of the later nullifier rests on `nk` being secret.

`r` is chosen by the sender: 8 field elements (≈ 248 bits) sampled as in §5.6. The `rho` of a
*dummy input* is a free random value (§2.5, §5.7).

A zero-value output ("dummy output") is an ordinary note with `value = 0`.

#### 2.4.1 What the recipient recomputes

The sender delivers `(value, r)` for output j to the recipient (§3.4). `rho` is **not** delivered
and MUST NOT be taken from the sender. The recipient:

1. reads `nf1`, `nf2`, `cm_out_j` and the position j from the transaction as accepted on chain;
2. computes `rho = H_rho(nf1, nf2, j − 1)`;
3. accepts the note iff `H(4; pk ‖ rho ‖ limbs(value) ‖ r) = cm_out_j` for its own `pk`;
4. stores `(value, rho, r)` and the leaf position; its nullifier will be `H(3; nk ‖ rho)`.

A recipient that tries both j does not need to be told the index. The check needs only public
chain data, the recipient's own `pk`, and `(value, r)`.

### 2.5 Nullifier

`nf = H(3; nk[0..8] ‖ rho[0..8])`.

A dummy input publishes a nullifier computed the same way from its own (random) `sk` and `rho`;
the node adds it to the nullifier set like any other (§4.2).

### 2.6 Merkle tree

| | |
|---|---|
| Depth | 32 (2^32 leaves) |
| Leaf | the note commitment itself (8 elements), not hashed again |
| Node | `H(5; left[0..8] ‖ right[0..8])` |
| Empty leaf | the all-zero digest |
| Empty subtree at level l + 1 | `H(5; E_l ‖ E_l)`, `E_0` = all-zero digest; `E_32` is the root of the empty tree (§8.1) |
| Index bit order | bit l of the leaf index (bit 0 = least significant) is the position at level l, counting levels from the leaf: 0 = the running node is the LEFT child, 1 = the RIGHT child |
| Path | 32 siblings, leaf level first |

Insertion order, the accepted anchors and the rule that keeps the empty leaf distinguishable from
a note are node rules: §4.3.

### 2.7 The statement

Public inputs, in this order:

| # | Name | Type |
|---|---|---|
| 1 | `anchor` | digest |
| 2 | `nf1` | digest |
| 3 | `nf2` | digest |
| 4 | `cm_out1` | digest |
| 5 | `cm_out2` | digest |
| 6 | `v_in` | u64 |
| 7 | `v_out` | u64 |
| 8 | `fee` | u64 |
| 9 | `binding` | digest |

Private witness: for each input i ∈ {1, 2}: `en_i` ∈ {0, 1}, `sk_i`, `value_i` (u64), `rho_i`,
`r_i`, 32 siblings, 32 position bits; for each output j ∈ {1, 2}: `value'_j` (u64), `pk'_j`,
`r'_j`.

The proof is accepted iff a witness exists with:

1. `nf_i = H(3; H(1; sk_i) ‖ rho_i)` for both inputs (dummies included);
2. with `cm_i` the commitment of `(value_i, H(2; sk_i), rho_i, r_i)` and `root_i` the result of the
   32-level path from `cm_i`: if `en_i = 1` then `root_i = anchor`; if `en_i = 0` then
   `value_i = 0` (and `root_i` is unconstrained);
3. `cm_out_j` is the commitment of `(value'_j, pk'_j, H_rho(nf1, nf2, j − 1), r'_j)`, where `nf1`,
   `nf2` are the public inputs (equal to the nullifiers of item 1);
4. `value_1 + value_2 + v_in = value'_1 + value'_2 + v_out + fee` over the integers, every value a
   u64;
5. (verifier, outside the proof) `nf1 ≠ nf2`. This rules out one transaction spending the same
   note in both slots and guarantees two distinct nullifiers per transaction. It is not what makes
   two *different* notes have different nullifiers — that is the uniqueness of `rho` (§2.4).

`binding` is not constrained by the circuit; it is a public value of the proof and therefore part
of the Fiat–Shamir transcript (§2.9), so a proof verifies only with the `binding` it was made for.

The three operations are parameter choices of this one statement:

| Operation | Inputs | Outputs | Public amounts |
|---|---|---|---|
| shield | two dummies | one note of `v_in − fee` to the recipient; one zero-value note to a random key | `v_in > 0`, `v_out = 0` |
| transfer | one or two real notes (a dummy fills the second slot) | the payment; the change (possibly zero) | `v_in = v_out = 0` |
| unshield | one or two real notes | the change (possibly zero); one zero-value note to a random key | `v_in = 0`, `v_out > 0` |

The circuit is symmetric in the two inputs and in the two outputs; which output slot carries which
note has no consensus meaning (§5.5).

Not part of the statement (node rules, §4): `anchor` is an accepted root; neither nullifier is
already spent; `binding` is the hash of the transaction body; pool accounting; the encrypted
notes.

### 2.8 Encodings

**Field element in public data:** 4 bytes, little-endian, canonical (< p). A decoder MUST reject a
value ≥ p.

**Digest:** 8 field elements, 32 bytes.

**Public inputs as bytes (216 bytes):**
`anchor ‖ nf1 ‖ nf2 ‖ cm_out1 ‖ cm_out2` (32 each) `‖ v_in ‖ v_out ‖ fee` (u64 LE each)
`‖ binding` (32).

**Public inputs as the proof system sees them (60 field elements, this order):** `anchor` (8),
`nf1` (8), `nf2` (8), `cm_out1` (8), `cm_out2` (8), the four 16-bit limbs of `v_in`, of `v_out`, of
`fee` (least significant first), `binding` (8). The verifier MUST derive the twelve limbs from the
three u64 values itself. A verifier interface that accepts the 60 elements, or the limbs, from a
transaction MUST NOT be used: without a check that every limb is below 2^16 the integer balance
argument fails.

**Binding.** `binding = binding_from_bytes(body)`, where `body` is the 2,546-byte transaction body
of §3.2 and

`binding_from_bytes(b)` = `Blake3.derive_key(context = "rouge-shield/v2/binding/research-0",
key_material = b)` → 32 bytes; element i = (LE u32 of bytes 4i..4i+4) mod p, i = 0 … 7.

The context string is the 34 ASCII bytes shown, including the suffix `research-0`; it is kept
unchanged so that the primitive vectors of §8.1 stay valid (§9.1 O-13).

### 2.9 Proof system and pinned verifier parameters

A proof is a `p3-uni-stark` proof (library version and commit of §2.1) of the AIR of §2.10 under
the configuration below. The verifier takes **all** of it from built-in constants — nothing from
the proof and nothing from its caller.

| Parameter | Value (the one built-in set: "Q2 · Blake3 · hiding ON") |
|---|---|
| Trace height | 2^12 = 4,096 rows; the proof's `degree_bits` MUST equal 13. The library accepts other heights; the verifier MUST refuse them |
| Trace width / public values / periodic columns | 84 / 60 / 34 |
| Challenge field | F^8 |
| PCS | `HidingFriPcs` (two-adic FRI), DFT `Radix2DitParallel` |
| FRI blowup | 32 (`log_blowup` 5) |
| FRI queries | 45 |
| Query proof-of-work | 16 bits |
| Commit-phase / batching / out-of-domain proof-of-work | 0 / 0 / 0 bits |
| FRI folding arity | up to 4 (`max_log_arity` 2) |
| Final polynomial length | 4 (`log_final_poly_len` 2) |
| Merkle cap height | 0 |
| Hiding: random codewords | 8 |
| Hiding: salt elements per leaf | 5 |
| Leaf hash | Blake3 over the serialised field elements (`SerializingHasher<Blake3>`), 32-byte digests |
| Node compression | Blake3 of the two 32-byte children (`CompressionFunctionFromHasher<Blake3, 2, 32>`) |
| Both MMCSs | `MerkleTreeHidingMmcs` (input) and `ExtensionMmcs` over it (FRI) |
| Transcript | `SerializingChallenger32<KoalaBear, HashChallenger<u8, Blake3, 32>>` |
| Maximum proof length | 200,000 bytes (`MAX_PROOF_BYTES`) |
| Security of the proof system, proven / conjectured | 128 / 128 bits (list-decoding regime; computed by `p3-security`; includes 16 bits of query grinding; zero margin over the target) |
| Security of the statement's hashes (§2.2) | ≈ 124 bits classical, ≈ 83 bits against a quantum collision search |
| **End to end** | **the smaller: ≈ 124 classical / ≈ 83 quantum (collisions)** |

No other parameter set exists in the protocol. A proof made under any other set, mode or hasher
MUST NOT verify (§7, L-3).

**Transcript initialisation.** The Blake3 hash challenger starts from the 8 bytes `"SHIELD-3"`,
then observes these 21 field elements in order:

`0x53484c44 mod p` = 1397247044 ("SHLD"), 3, 2 (AIR version), 84, 12, 60, 34, 8 (extension
degree), 5 (`log_blowup`), 45 (queries), 16, 0, 0, 0 (query / commit / batch / out-of-domain
proof-of-work bits), 2 (`log_final_poly_len`), 2 (`max_log_arity`), 0 (cap height), 1 (hiding), 8
(random codewords), 5 (salt elements), 2 (hasher: 2 = Blake3).

Everything after that is the library's own transcript (`uni-stark/src/verifier.rs` at the pinned
commit: instance shape, commitments, the 60 public values, then the challenges).

**Verifier procedure `verify_spend(public, proof_bytes)`.** In this order:

1. If `proof_bytes` is longer than 200,000 bytes: refuse. Nothing has been decoded yet.
2. If `nf1 = nf2`: refuse.
3. Build the 60 public values (§2.8).
4. Decode the proof (§2.9.1); refuse on a decoding error or if any byte is left over.
5. Re-encode the decoded proof with the same serialiser; refuse unless the result equals
   `proof_bytes` byte for byte.
6. Refuse unless `degree_bits = 13`.
7. Run the library verifier with the configuration above; refuse on any error.

The result that enters consensus is one bit, accept or refuse (§4.6).

#### 2.9.1 Proof serialisation

The proof bytes are `postcard` 1.1 (serde) of `p3_uni_stark::Proof<StarkConfig<…>>` for the
configuration's concrete types: `commitments {trace, quotient_chunks, random}`, `opened_values
{trace_local, trace_next, preprocessed, quotient_chunks, random}`, `opening_proof` (the FRI proof:
proof-of-work witnesses, commit-phase commitments, batched input openings with salts, commit-phase
openings, final polynomial), `degree_bits`, `ood_pow_witness`.

* Lengths and `usize` values are postcard varints and MUST be minimal (no redundant continuation
  bytes). The decoder in use (postcard 1.1.3) does not enforce this, which is why step 5 is
  mandatory: "decodes with no trailing bytes" does not give one encoding per proof.
* A field element is 4 bytes little-endian in the library's Montgomery form (the stored value is
  `x · 2^32 mod p`), not the canonical form of §2.8; the decoder rejects a stored value ≥ p. An
  extension element is its 8 base coordinates in order.
* A Blake3 digest is 32 raw bytes.
* The size is not constant: the Merkle openings of all queries are batched and share path nodes,
  so it depends on the query positions. Under the parameters of this section the largest possible
  honest proof is 194,893 bytes; the 200,000-byte maximum is therefore an upper bound of the
  honest size, with a margin of 5,107 bytes (§7, correction C-1).

**What "one encoding" does and does not cover.** For a fixed decoded proof there is exactly one
accepted byte string. A *statement* does not have one proof: whoever knows the witness can make as
many different valid proofs as it likes. No consensus rule may assume one proof per statement;
uniqueness of a spend comes from the nullifiers (§4.2).

### 2.10 The AIR

4,096 rows = 128 cycles of 32 rows, one Poseidon2 permutation per cycle; 84 columns; 184
constraints of degree ≤ 4; 34 periodic columns (24 round-constant columns and 4 round-type columns
of period 32; range-check columns of period 16, 64 ×4 and 128); 60 public values.

| Cycles | Hash |
|---|---|
| 0–36 | input 1: `nk`, `nf`, `pk`, `cm` (two absorptions), Merkle levels 0–31 |
| 37–73 | input 2: the same |
| 74 | `rho'_1 = H_rho(nf1, nf2, 0)` |
| 75, 76 | `cm_out1` (its `rho` slot = the digest of cycle 74) |
| 77 | `rho'_2 = H_rho(nf1, nf2, 1)` |
| 78, 79 | `cm_out2` (its `rho` slot = the digest of cycle 77) |
| 80–127 | padding (unconstrained hash input) |

| Columns | Content |
|---|---|
| 0–23 | hash state |
| 24–31, 32–39 | `sk`, `rho` of the current input (may change only on the link into cycle 37) |
| 40–43, 44–47 | value limbs of input 1, input 2 (constant) |
| 48–51, 52–55 | value limbs of output 1, output 2 (constant) |
| 56, 57 | enable flags (constant) |
| 58–60, 61–63 | carry digits: carry = KA + 2·KB − 3, KA ∈ {0..3}, KB ∈ {0, 1} (constant) |
| 64 | Merkle position bit |
| 65–66, 67–68 | range-check bit and accumulator for the input limbs / the output limbs |
| 69 | `T` = "Merkle cycle of an enabled input" |
| 70, 71 | cycle counter; input-block index |
| 72–83 | one-hot cycle-type selectors NK, NF, PK, CM1, CM2, MK, OA1, OA2, OB1, OB2, RA, RB |

How the output `rho` is enforced: on the row that initialises cycle 74 (77) the whole sponge state
is constrained — rate = public `nf1` ‖ public `nf2`, capacity = `[16, 6, 0 (1), 0, 0, 0, 0, 0]`; on
the row that initialises cycle 75 (78) the state elements 8..16, the `rho` slot of the
commitment's first block, are constrained to equal the digest (elements 0..8) of the row before,
i.e. the output of cycle 74 (77). The cycle types are forced by the selector chain
`… MK → RA → OA1 → OA2 → RB → OB1 → OB2`, with `RA` pinned to cycle 74; the first-row values of
all 12 selectors are part of that argument, not a redundancy.

**Normative text of the constraints** is `src/air.rs` and `src/layout.rs` of the source tree named
in §1.1. A verifier MUST implement exactly those constraints, in the same order (the order fixes
the powers of the constraint-folding challenge), with the same periodic columns in the same order.
A prover MAY lay out the witness any way that satisfies them. That the constraints, the transcript
and the proof format are fixed by reference to pinned source, and not written out here, is open
issue O-1.

### 2.11 Production entry points

The node and the wallet use the cryptographic layer through these functions and no others:

| Function | Used by | Role |
|---|---|---|
| `verify_spend(public: &PublicInputs, proof_bytes: &[u8]) -> Result<(), VerifyError>` | node; wallet (self-check) | the verifier of §2.9. The only function whose result is consensus |
| `prove_spend(witness: &SpendWitness, public: &PublicInputs) -> Result<Vec<u8>, ProveError>` — no seed parameter; the seed is drawn inside (§5.6). Cargo feature `prover` of the verifier crate, never enabled in a node build (W-1) | wallet | the prover for the same fixed parameter set. It checks the statement of §2.7 before proving, refuses a proof above the maximum length and runs `verify_spend` on its own output |
| `PublicInputs::from_bytes` / `to_bytes`, `digest_from_bytes` / `digest_to_bytes` | both | the encodings of §2.8 |
| `binding_from_bytes` | both | §2.8 |
| `derive_rho`, `receive_note`, the commitment and nullifier functions | wallet | §2.4, §2.5 |

### 2.12 Resolution of the draft's research shortcuts

Every item of `SPEC_DRAFT.md` §12, in its numbering:

| # | Shortcut | Resolution |
|---|---|---|
| 1 | Proof serialisation is a serde / postcard derive of library types; canonical form enforced by re-encoding, not by a strict decoder | Normative for v1 as written in §2.9.1, with the library pinned by version and commit and postcard pinned to 1.1.x: the accepted set is exactly the image of the encoder. A field-by-field format with a strict decoder: open issue O-1 |
| 2 | Transcript order and encoding are the library's | Normative by reference to the pinned commit (§2.9). Open issue O-1 |
| 3 | Binding: no transaction encoding; placeholder context string | Resolved: the body of §3.2 is the preimage. The context string is kept byte for byte (§2.8); open issue O-13 |
| 4 | Key derivation, sampling of `r` and of the dummies' `sk` / `rho` unspecified | Resolved in §5.2 **[P]**, §5.6, §5.7 |
| 5 | Poseidon2 constants are "whatever the library ships" | Normative: the constants of the pinned commit, checked by the permutation vector of §8.1. The round numbers and constants have not been reviewed: open issue O-2 |
| 6 | Empty leaf = all-zero digest | Resolved: a transaction whose `cm_out1` or `cm_out2` is the all-zero digest is invalid (§3.6 check 8), so no leaf written by a transaction equals the empty leaf |
| 7 | The blinding seed is one caller-supplied value | Resolved as a production requirement in §5.6 (closes F-6 / L-5). It needs a code change: open issue O-14 |
| 8 | `fee` on a shield, output-slot roles, slot shuffling | Fee: resolved in §3.5 **[P]**. Slot roles and order: no consensus meaning; wallet rule §5.5 |
| 9 | Limb checks on public amounts | Resolved: the verifier derives the limbs from u64 values; any other interface is forbidden (§2.8) |
| 10 | The hiding mode is unaudited; 8 random codewords and 5 salt elements are the library minimum | Unchanged and stated in §6. Audit scope: open issue O-2 |
| 11 | The AIR has had one independent review; the SHIELD-3 changes none | Updated: the SHIELD-3 changes have now had one independent review (`REVIEW2.md`: no Critical, High or Medium finding). Neither review is a soundness proof (§6) |
| 12 | The 248-bit in-circuit digest caps the statement at ≈ 124 / ≈ 83 bits; undecided | Decided by the owner: accepted for version 1 (design §14, decision 2). Stated in §6 |
| 13 | The proof-length cap is a measured margin, not a bound | Wrong; corrected in §7 (C-1): it is a bound. No re-prove rule exists |
| 14 | The crate can build other parameter sets behind the `research` feature | Resolved as a build requirement in §7 (L-3) |
| 15 | Note delivery does not exist | Resolved in §3.4 **[P]** and §5.4 |

---

## 3. Transaction types

Three new transaction types exist from height A: `shield_v2`, `shielded_transfer_v2`,
`unshield_v2`.

**Before A, and while A is `None`, a V2 transaction is treated exactly as the previous release
(1.6.3, the build without this upgrade) treats it — no more and no less** (REVIEW_NODE_1, R1-1).
That release has no rule for these transactions, so the treatment is:

* a transaction whose `tx_type` is one of the three names is an *unknown type*: it is subject to
  the ordinary rules of every account transaction (a valid account signature over its bytes,
  fee and type sanity, MONETARY_INTEGRITY, the signed-payload binding) and, when its block is
  accepted, it is applied as a **no-op** — the sender's nonce is written and the sender indexed,
  no fee is charged, no balance moves, and it counts as one transaction of the block; a
  signer-less envelope (empty `from_pub_key`, empty `sig`) fails the signature rule and
  invalidates its block, like any unsigned transaction;
* the two payload fields of §3.1 **do not exist** for that release: its deserialisation drops them
  silently, so the signature, the transaction identity, the transaction hash and the stored block
  are those of the field-less transaction. An upgraded node MUST do the same to every transaction
  of a block below A before any rule reads it, and MUST compare a signed envelope's payload with
  the fields dropped.

Consequently a block below A that carries a V2-typed transaction or the fields is valid or invalid
for an upgraded node exactly when it is for a non-upgraded one, with the same state root, and the
upgrade can be installed on validators in any order before A without a split. Wallets MUST NOT
submit a V2 transaction before A (it would be a no-op that costs a nonce, or an unsigned
transaction that invalidates its block), and a node MUST NOT admit one to its mempool, relay one
or produce one before A — a node-local refusal that is not a consensus rule. From A the three
types and both fields are consensus-validated by §3.6 and §4.

*Activation runbook note (operators).* Schedule A in the node's upgrade schedule for the network
and release the build; every validator and every node installs it before A, in any order — below
A the build is consensus-identical to the previous release, so a partially upgraded validator set
cannot split, and a node that has not upgraded by A simply stops following the chain at A (it
cannot verify the state root from A on). Nothing is written to the pool store before A. Before A
no wallet, SDK or client may offer V2 transactions; the node-local refusal above is the safety
net, not the plan. After A, confirm on every node that `GET /api/shield-v2/stats` reports
`active: true` and the same `tree_root`, `nullifier_acc` and `pool_total_quanta`, and that
`state_root` agrees across nodes at the same height. Rollback before A is reinstalling the
previous binary; after A there is none.

All three share one body layout and one proof statement. They differ in the `kind` byte, in which
public amounts may be non-zero, in the meaning of the `account` field, and in whether an account
signature exists.

| | `shield_v2` | `shielded_transfer_v2` | `unshield_v2` |
|---|---|---|---|
| `kind` | 1 | 2 | 3 |
| `v_in` | > 0 | 0 | 0 |
| `v_out` | 0 | 0 | > 0 |
| Public sender | the funding account | none | none |
| Account signature | ML-DSA-65, as for any account transaction today | none: the proof is the authorization | none |
| `account` field | the funding account | 32 zero bytes | the recipient of `v_out` |
| Who pays `fee` | the funding account, out of `v_in` | the shielded value | the shielded value |

That transfers and unshields have no public sender is the owner's decision (design §14,
decision 1).

### 3.1 Envelope **[P]**

A V2 transaction travels in the chain's existing transaction structure (`TxV1`) so that blocks,
the transaction hash of the header and the transaction-uniqueness rule need no new container.

Two payload fields are added. Like the fields added by earlier upgrades, each is omitted from the
encoding when absent, so every existing transaction encodes and hashes exactly as before.

| Payload field | Content | Length |
|---|---|---|
| `shield_v2_body` | the body of §3.2, lowercase hexadecimal | exactly 5,092 characters |
| `shield_v2_proof` | the proof bytes of §2.9.1, lowercase hexadecimal | even, at least 2 and at most 400,000 characters |

Envelope rules, for all three types:

* `tx_type` is one of the three names. Both fields above MUST be present. Every other payload
  field MUST be absent (`None`).
* The envelope's floating-point `fee` MUST be exactly `0.0`. The fee of a V2 transaction is the
  integer `fee` of its body; no floating-point value takes part in any V2 rule.
* Hexadecimal MUST be lowercase (`0-9a-f`). Uppercase is invalid, so that the same bytes have one
  textual form.

Additional rules for `shield_v2`:

* `from_pub_key` is the funding account's ML-DSA-65 public key (1,952 bytes, hexadecimal), `nonce`
  and `sig` are as for any account-signed transaction today.
* **What is signed.** The account signature MUST cover both payload fields — the whole body and
  the whole proof — through one of the chain's existing signing formats: the bytes of
  `encode_tx_for_signing` (which include the payload), or a `signed_payload` whose signed bytes
  contain both hexadecimal strings and from which the payload fields are derived by the
  signed-payload binding rule. A `shield_v2` whose body or proof is not inside the signed bytes is
  invalid.
* *(W-2, wallet core.)* The wallet core returns a `shield_v2` unsigned, together with the bytes of
  `encode_tx_for_signing` for the envelope it built (`version` 1, the two payload fields set, `fee`
  0.0, no `signed_payload`); the account key signs exactly those bytes and the hexadecimal
  signature becomes `sig`. The wallet core never holds the account's secret key. In the chain's
  JSON encoding of the envelope the two V2 fields are present and every other payload field is
  either omitted or `null`, as the chain's own encoder writes it; both read back as absent.

Additional rules for `shielded_transfer_v2` and `unshield_v2` (no public sender):

* `from_pub_key` MUST be the empty string, `sig` MUST be the empty string, `nonce` MUST be 0,
  `signed_payload` MUST be absent, and the envelope `version` MUST be 1. (Nobody signs this
  envelope, so every field of it that enters the transaction identity or hash must be pinned by
  rule; `version` is such a field — REVIEW_NODE_1, R1-4.)
* The node MUST NOT run account-signature verification for these two types, MUST NOT read or write
  an account nonce for them, and MUST NOT index a sender address. These exemptions apply to these
  two types and to no other, and only from A (§3, first paragraph).
* Replay protection and uniqueness come from the nullifiers (§4.2) and the expiry height, not
  from a nonce.

The transaction identity used by the existing transaction-uniqueness rule is computed as for any
transaction and covers the payload, hence the proof bytes. Because a witness holder can make many
proofs of one statement (§2.9.1), that identity MUST NOT be relied on to detect a repeated spend.

### 3.2 Body

The body is exactly 2,546 bytes. All integers are little-endian. Digests use the encoding of §2.8.

| Offset | Size | Field | Content |
|---|---|---|---|
| 0 | 1 | `body_version` | `0x01` |
| 1 | 1 | `kind` | `0x01` shield, `0x02` transfer, `0x03` unshield |
| 2 | 32 | `chain` | SHA-256 of the chain id string as UTF-8 (for example `rougechain-mainnet-1`) |
| 34 | 8 | `expiry_height` | u64 LE; the last block height at which the transaction is valid |
| 42 | 32 | `anchor` | digest |
| 74 | 32 | `nf1` | digest |
| 106 | 32 | `nf2` | digest |
| 138 | 32 | `cm_out1` | digest |
| 170 | 32 | `cm_out2` | digest |
| 202 | 8 | `v_in` | u64 LE, quanta |
| 210 | 8 | `v_out` | u64 LE, quanta |
| 218 | 8 | `fee` | u64 LE, quanta |
| 226 | 32 | `account` | see §3.3 |
| 258 | 1,088 | `kem_ct1` | ML-KEM-768 ciphertext for output 1 (§3.4) |
| 1,346 | 56 | `note_ct1` | encrypted note of output 1 (§3.4) |
| 1,402 | 1,088 | `kem_ct2` | ML-KEM-768 ciphertext for output 2 |
| 2,490 | 56 | `note_ct2` | encrypted note of output 2 |
| 2,546 | | end | |

Bytes 42..226 of the body are, unchanged, the first 184 bytes of the 216-byte public-input
encoding of §2.8. The body does not contain `binding` or the proof.

The layout of offsets 0..42 and 226..2,546 is **[P]**; the fields it must carry (recipient of
`v_out`, encrypted notes, expiry height, chain id) are fixed by the design (§7 of the design).

### 3.3 The `account` field

| Type | `account` |
|---|---|
| `shield_v2` | SHA-256 of the 1,952 raw bytes of `from_pub_key`. This is the 32-byte payload of the funding account's `rouge1` address. It binds the proof to the account that pays |
| `shielded_transfer_v2` | 32 zero bytes |
| `unshield_v2` | the 32-byte payload of the `rouge1` address that receives `v_out` (the address is the bech32m encoding, prefix `rouge`, of these 32 bytes) |

### 3.4 Encrypted notes **[P]**

Each output j ∈ {1, 2} is delivered on chain to its recipient (design §3, §7): ML-KEM-768 for key
agreement and AES-256-GCM for the note. The plaintext is `(value, r)` — not `rho`, which the
recipient derives (§2.4.1; this supersedes the design's "(value, rho, r)", §7).

For output j, with the recipient's ML-KEM-768 public key `ek` (part of its shielded address,
§5.3):

1. `(kem_ct_j, ss) = ML-KEM-768.Encaps(ek)`; `kem_ct_j` is 1,088 bytes, `ss` 32 bytes.
2. `key = HKDF-SHA256(ikm = ss, salt = 32 zero bytes, info = "rouge-shield/v2/note", L = 32)`.
   (A salt of 32 zero bytes is what RFC 5869 uses when no salt is given; "no salt" in §5.2 is the
   same input — W-3.)
3. `plaintext = value (u64 LE, 8 bytes) ‖ r (digest, 32 bytes)` — 40 bytes.
4. `note_ct_j = AES-256-GCM(key, nonce = 12 zero bytes, aad = cm_out_j (32 bytes), plaintext)` —
   40 bytes of ciphertext followed by the 16-byte tag: 56 bytes.

The key is used for one message, so the fixed nonce is safe. A sender MUST use a fresh
encapsulation for every output of every transaction. *(W-12.)* "Fresh" MUST NOT rest on the
operating system's generator alone: the two outputs of a payment to the sender's own address go to
the same `ek`, and one repeated 32-byte encapsulation randomness would give both notes one key
under the fixed nonce. A wallet MUST derive the encapsulation randomness of each output so that it
differs per output slot and per transaction even if the generator repeats (§5.6 item 6).

For an output that has no recipient (the zero-value note of a shield or an unshield), the sender
MUST fill both fields the same way, encapsulating to a freshly generated ML-KEM-768 key that it
discards, so that the two slots of every transaction look alike.

The node does not and cannot check the ciphertexts. They are covered by `binding`, so nobody can
replace them without invalidating the proof. A sender that writes ciphertexts the recipient cannot
decrypt has made a note the recipient cannot find; this destroys the sender's own value and
nobody else's.

### 3.5 Amounts and the fee

* `shield_v2`: the funding account is debited exactly `v_in` quanta. Of these, `fee` goes to the
  block's fee collection and `v_in − fee` enters the pool; the note created by the shield is worth
  `v_in − fee` (the proof forces this, §2.7 item 4). The public account therefore pays the fee, as
  the design requires, and no second fee field exists. **[P]**
* `shielded_transfer_v2`: `fee` quanta leave the pool total and go to the block's fee collection.
  The proof forces the spent notes to cover it. No public account is involved.
* `unshield_v2`: `v_out + fee` quanta leave the pool total; `v_out` is credited to the `account`
  address and `fee` goes to the block's fee collection.

"The block's fee collection" is the amount the node already accumulates per block from every
transaction and then burns and distributes by its existing rule; V2 fees are added to it as
integers and are treated from there on exactly like the fee of any other transaction. A V2
transaction counts as one transaction wherever that rule counts transactions.

`fee` MUST be at least `SHIELD_V2_MIN_FEE_QUANTA`. Its value is not fixed by the inputs: open
issue O-6.

### 3.6 Validity checks, in order

A node performs these checks in this order, for mempool admission and for every transaction of a
block it validates. The first failure ends the procedure. Checks 1–13 need neither chain state nor
the proof system; checks 15–19 are state lookups; check 20 is the only expensive one.

| # | Check | Cost |
|---|---|---|
| 1 | H ≥ A (and A is set). Below A there is no V2 check at all: the transaction is judged by the previous release's rules (§3, first paragraph), and the mempool / producer refuse it node-locally | constant |
| 2 | Envelope shape (§3.1): both fields present, every other payload field absent, envelope `fee` is `0.0`; for the two signer-less types `from_pub_key`, `sig` empty, `nonce` 0, no `signed_payload`, `version` 1 | constant |
| 3 | **Length of `shield_v2_proof`: even, ≥ 2 and ≤ 400,000 characters — i.e. the proof is at most 200,000 bytes. Checked on the string length, before the proof is decoded from hexadecimal or parsed in any way** | constant |
| 4 | Length of `shield_v2_body` is exactly 5,092 characters | constant |
| 5 | Both strings are lowercase hexadecimal; decode them to bytes | linear |
| 6 | `body_version = 0x01`; `kind` matches `tx_type` | constant |
| 7 | `chain` equals SHA-256 of this node's chain id; `expiry_height ≥ H` | one hash |
| 8 | `anchor`, `nf1`, `nf2`, `cm_out1`, `cm_out2` are canonical digests (each 4-byte word < p); `cm_out1` and `cm_out2` are not the all-zero digest | constant |
| 9 | `nf1 ≠ nf2` | constant |
| 10 | Amount pattern of the type: shield `v_in > 0`, `v_out = 0`, `fee ≤ v_in`; transfer `v_in = v_out = 0`; unshield `v_in = 0`, `v_out > 0` | constant |
| 11 | `fee ≥ SHIELD_V2_MIN_FEE_QUANTA` | constant |
| 12 | `account`: shield — equals SHA-256 of the decoded `from_pub_key`; transfer — 32 zero bytes; unshield — any 32 bytes | one hash |
| 13 | Block level: the transaction is within the per-block limit of §4.7 | constant |
| 14 | `shield_v2` only: the account signature is valid and covers body and proof (§3.1) | one ML-DSA-65 verification |
| 15 | `anchor` is in the anchor window of H (§4.3) | lookup |
| 16 | Neither `nf1` nor `nf2` is in the nullifier set, and neither equals a nullifier of an earlier transaction of the same block (§4.2) | lookup |
| 17 | The tree has room: `note_count + 2 ≤ 2^32` | constant |
| 18 | Pool accounting (§4.4): shield — `pool_total + v_in − fee ≤ SHIELD_V2_POOL_CAP_QUANTA`; transfer — `pool_total ≥ fee`; unshield — `pool_total ≥ v_out + fee` | constant |
| 19 | `shield_v2` only: the funding account's balance is at least `v_in` | lookup |
| 20 | `binding = binding_from_bytes(body)`; `public` = bytes 42..226 of the body ‖ `binding`; `verify_spend(public, proof)` accepts (§2.9) | ≈ 6 ms (§4.7) |

Checks 15–19 are made against the state as it is after every preceding transaction of the same
block has been applied. Check 9 is repeated inside `verify_spend`; a node MUST make it before any
state lookup regardless.

If all checks pass, the effects of §4.5 are applied.

---

## 4. Node consensus rules

All rules of this section are consensus from height A. A node that applies them differently
computes a different state root and leaves the chain. The soundness of the pool — in particular
the uniqueness of every note's `rho`, on which the fix of the first review's finding F-2 rests —
depends on **every** rule of §4.2, §4.3 and §4.5 (REVIEW2, finding L-1). None of them may be
relaxed, deferred or implemented "later as an optimisation".

### 4.1 State

The pool's consensus state is exactly:

| State | Type | Initial value at A |
|---|---|---|
| nullifier set | set of 32-byte nullifiers | empty |
| `nullifier_count` | u64 | 0 |
| `nullifier_acc` | 32 bytes (§4.5) | 32 zero bytes |
| commitment tree | append-only Merkle tree of §2.6 | empty |
| `note_count` | u64, the number of leaves | 0 |
| `tree_root` | digest | `E_32` (§8.1) |
| anchor window | list of at most 128 digests (§4.3) | `[E_32]` |
| `pool_total` | u128, quanta | 0 |

It is part of the block state transition: applied in the same step, under the same pre-apply
snapshot and the same rollback, as balances and every other effect of a block. It is not a side
store.

### 4.2 Nullifier set

1. **Both nullifiers of every accepted transaction are inserted** — `nf1` and `nf2`, for all three
   types. Nullifiers of dummy inputs are inserted exactly like nullifiers of real notes: a shield
   inserts two. A node cannot tell the two kinds apart and MUST NOT try to.
2. **A transaction is invalid if** (a) `nf1 = nf2`, or (b) `nf1` or `nf2` is in the nullifier set,
   or (c) `nf1` or `nf2` equals a nullifier of an earlier transaction of the same block. Condition
   (c) means the lookup is against the set as it is after the preceding transactions of the block,
   not as it was when the block started.
3. **The set is never pruned.** No entry is ever removed, for any reason, at any height. The two
   permanent entries per transaction are load-bearing: they are what makes every accepted pair
   `(nf1, nf2)` unique for ever, and with it every output note's `rho`.
4. **Insertion is atomic with acceptance.** Either all effects of a transaction (§4.5) are applied
   — both nullifiers, both commitments, the pool total, the balance change, the fee — or none.
   There MUST be no path on which a transaction's commitments enter the tree while its nullifiers
   do not enter the set, or the reverse.
5. A block that is rejected or rolled back leaves the set exactly as it was before the block.

The regression vector for these rules is the pair of transactions of
`review2_uniqueness_rests_on_the_node` (`research/shield3/tests/review2_air.rs`): two different
shields built from the same dummy secrets, with the same `(nf1, nf2)`. `verify_spend` accepts both
proofs by design. The node MUST accept at most one of them. This MUST be the first test of the
node implementation.

### 4.3 Commitment tree and anchors

1. **Append-only.** Leaves are written at positions 0, 1, 2, … and never changed or removed.
2. **One insertion path.** The tree is fed only by `cm_out1` and `cm_out2` of transactions
   accepted under §3.6. There is no genesis allocation, no migration of V1 notes, no deposit path
   and no administrative insertion. Any other path would insert a note whose `rho` somebody chose.
3. **Order.** Block order, then transaction order within the block, then `cm_out1` before
   `cm_out2`. The k-th accepted V2 transaction since A (counting from 0) writes leaves `2k` and
   `2k + 1`.
4. **Roots.** Let `R(h)` be the tree root after block h has been applied, with `R(A − 1) = E_32`.
   A block without V2 transactions leaves the root unchanged: `R(h) = R(h − 1)`.
5. **Accepted anchors.** A transaction in block H is valid only if its `anchor` equals `R(h)` for
   some h with `max(A − 1, H − 128) ≤ h ≤ H − 1`: the root after one of the last 128 blocks before
   H (fewer just after activation). This set is the *anchor window of H*. The window size
   `SHIELD_V2_ANCHOR_WINDOW = 128` is the design's figure (design §6, marked there as an estimate;
   open issue O-8).
6. An anchor is never a root from inside the block being built: a note created in block H can be
   spent in block H + 1 at the earliest.
7. The rule applies to all three types. The circuit does not compare a shield's `anchor` with
   anything (both inputs are dummies), but the node requires it to be in the window all the same,
   so that the three types are checked alike.
8. A transaction built against `R(h)` stays valid, as far as its anchor is concerned, up to and
   including block h + 128. *(W-14, clarification; the rule is item 5 and is unchanged.)* That is
   a guarantee, **not a bound**: the window is a set of root values, and by item 4 a block without
   V2 transactions repeats the root. While no V2 transaction is mined, `R(h)` is the root after
   every later block and stays an accepted anchor indefinitely. The anchor window does not limit
   how long a transaction can be mined; **`expiry_height` (§3.6 check 7) is the only limit**.

### 4.4 Pool accounting and the cap

`pool_total` is a public integer number of quanta, independent of every proof.

| Type | Change of `pool_total` | Public balance change |
|---|---|---|
| `shield_v2` | `+ (v_in − fee)` | funding account `− v_in` |
| `shielded_transfer_v2` | `− fee` | none |
| `unshield_v2` | `− (v_out + fee)` | `account` address `+ v_out` |

In every case `fee` is added to the block's fee collection (§3.5).

* **Never below zero.** A transfer or unshield that would take `pool_total` below zero is invalid
  (§3.6 check 18). This holds whatever the proof says: even if the proof system, the circuit or
  an implementation were broken, the pool can never pay out more than was paid in.
* **Cap.** `SHIELD_V2_POOL_CAP_QUANTA = 1,000,000 XRGE = 10^15 quanta` (design §14, decision 5). A
  `shield_v2` for which `pool_total + v_in − fee` would exceed the cap is invalid. Transfers and
  unshields are never refused because of the cap.
* **Changing the cap.** The cap is a compiled consensus constant. It can be changed only by a
  later upgrade with its own activation height, delivered as a signed release that every validator
  installs before that height — a fork, like any other change of a consensus rule. It is never an
  operator setting, a governance transaction or a node-local value.
* **Supply.** Total XRGE = public balances + stake + unbonding + pool reserves + `pool_total` +
  burned. The node's supply-invariant tests MUST be extended with the `pool_total` term.

### 4.5 Applying an accepted transaction

For a transaction that passed every check of §3.6, in this order and as one atomic step:

1. Insert `nf1`, then `nf2`, into the nullifier set. For each inserted nullifier `nf` (its 32 bytes
   in the encoding of §2.8):
   `nullifier_acc ← SHA-256("rougechain.shield_v2.nullifier_acc.v1" ‖ nullifier_acc ‖ nf)`;
   `nullifier_count ← nullifier_count + 1`.
2. Append `cm_out1` at leaf `note_count`, then `cm_out2` at leaf `note_count + 1`;
   `note_count ← note_count + 2`; recompute `tree_root`.
3. Update `pool_total` and the public balance as in §4.4.
4. Add `fee` to the block's fee collection.

After the last transaction of block H: append `R(H)` (the current `tree_root`) to the anchor
window and, if the window then holds more than 128 entries, remove the oldest. This happens for
every block from A on, including blocks with no V2 transaction.

### 4.6 Failure behaviour

**A block that contains a V2 transaction failing any check of §3.6 is invalid as a whole.** It is
rejected at import, nothing of it is applied, and the state is restored from the pre-apply
snapshot. This is the behaviour of the MONETARY_INTEGRITY rule ("a block is invalid if it carries
a transaction that …"), not the other behaviour that exists on the chain today, in which a
transaction that fails a stateful check is left in the block and skipped without effect.

Consequences:

* There is no "included but failed" V2 transaction, no failure receipt and no fee charged for a
  failed V2 transaction.
* A block producer MUST evaluate V2 transactions in order against the evolving state of the block
  it builds, and MUST leave out any transaction that fails — for example the second of two
  mempool transactions that share a nullifier, or a shield whose account an earlier transaction of
  the block has emptied.
* **Error kinds are not consensus (REVIEW2, L-4).** `verify_spend` reports why it refused, and the
  kind can differ between platforms and with the order of checks for one and the same invalid
  proof (a 32-bit and a 64-bit build can name different errors; no input is known that one
  accepts and the other refuses). Consensus distinguishes "accepted" from "refused" and nothing
  else. A node MUST NOT put the kind or text of a verification error into a block, a receipt, the
  state root or any other consensus-relevant data, MUST NOT branch a consensus rule on it, and
  MUST NOT charge anything by it. It MAY log it locally.

Mempool (node-local, not consensus): a node SHOULD admit a V2 transaction only after all checks of
§3.6 pass against its current tip, SHOULD refuse a transaction that shares a nullifier with one
already in its mempool, and SHOULD drop a transaction once `expiry_height` has passed or its
anchor has left the window. It SHOULD make every cheap refusal — replay, already mined, duplicate,
mempool full, the stateless checks, the pool checks, the nullifier conflict — before check 20,
and MAY remember refused proofs so that the same bytes are not verified twice (REVIEW_NODE_1,
R1-2). It SHOULD count the `v_in` of the shields it already holds from an account against that
account's balance when admitting another, and SHOULD cap the number of V2 transactions it holds
(each is about 400 KB; R1-5). A producer that holds more valid V2 transactions than the per-block
limit MUST keep the rest for a later block, not drop them (R1-3).

Before A (§3, first paragraph) none of this applies: the mempool and the producer refuse every V2
type and every transaction carrying either field, node-locally, while a block carrying one is
judged by the previous release's rules.

### 4.7 Resource bounds per block

A block MUST NOT contain more than `SHIELD_V2_MAX_TX_PER_BLOCK` V2 transactions (the three types
counted together). A block with more is invalid.

**`SHIELD_V2_MAX_TX_PER_BLOCK = 8` [P]** — a recommendation, not fixed by any input (open issue
O-7). The figures behind it, all from `RESULTS.md` and `REVIEW2.md` for the pinned parameter set,
measured natively on a loaded 2-core host with no quiet-host figure available:

| Quantity | Figure |
|---|---|
| Verification, median of 51, three runs | 6.08 / 5.87 / 5.69 ms, canonical-encoding check included |
| Verification, slowest of 153 | 9.65 ms |
| Hostile input up to the cap, before refusal | at most 14 ms and 4.5 MiB allocated |
| Input above the cap | refused without parsing |
| Honest proof size | 179,147 – 190,795 bytes measured; at most 194,893 possible; cap 200,000 |
| Body | 2,546 bytes |

With the limit at 8, the V2 part of a block costs at most about 80 ms of honest verification
(about 112 ms if every proof is a worst-case hostile input) and at most 1,620,368 bytes of body
and proof (twice that in the hexadecimal envelope), per validating node.

### 4.8 State commitment

From height A the header state root of every block commits the pool state. The pool section is
applied last, after every extension the node already applies at that height (the balance root,
the NFT and contract extension, the mint-ledger extension when present). It is applied from A on
unconditionally, including while the pool is empty.

It uses the conventions of the existing state root: SHA-256; an ASCII domain tag with no
terminator; `field(x)` = the length of x as u64 BE followed by x; fixed-width big-endian integers;
the previous root entered as its 64-character lowercase hexadecimal string. Digests are the 32
bytes of §2.8.

```
root_after = hex( SHA-256(
      "rougechain.stateroot.shield_v2.v1"          (33 ASCII bytes)
   ‖  field( root_before as 64 ASCII hex chars )   (8 + 64 bytes)
   ‖  pool_total                                    (u128 BE, 16 bytes)
   ‖  note_count                                    (u64 BE, 8 bytes)
   ‖  tree_root                                     (32 bytes)
   ‖  frontier[0] ‖ … ‖ frontier[31]                (32 × 32 bytes)
   ‖  nullifier_count                               (u64 BE, 8 bytes)
   ‖  nullifier_acc                                 (32 bytes)
   ‖  window_len                                    (u64 BE, 8 bytes)
   ‖  window[0] ‖ … ‖ window[window_len − 1]        (32 bytes each, oldest first)
) )
```

* `frontier[l]`, l = 0 … 31: if bit l of `note_count` is 1, the root of the complete subtree of
  height l that covers the leaves `[m, m + 2^l)` with `m = (note_count >> (l + 1)) << (l + 1)` —
  the left subtree that is waiting for its right sibling at level l; otherwise 32 zero bytes.
  Together with `note_count` the frontier is everything needed to append the next leaf.
* `window` is the anchor window after the block has been applied (§4.5): `R(h)` for
  `max(A − 1, H − 127) ≤ h ≤ H`, oldest first; `window_len ≤ 128`.
* The nullifier set is committed through `nullifier_acc` and `nullifier_count` (§4.5): a running
  hash over every inserted nullifier in insertion order. The set itself is consensus data that
  every node holds. That the commitment is a running hash and not a hash over the sorted set is a
  choice of this document **[P]** (open issue O-12).

A block whose header state root differs from the root computed this way is rejected and rolled
back, as for any other state-root mismatch today.

---

## 5. Wallet rules

### 5.1 One address per wallet

A wallet has exactly one shielded address (design §14, decision 3). Two senders who pay the same
wallet can see that they used the same address; nobody else can, because addresses never appear on
chain. Address rotation can be added later without a fork.

### 5.2 Key derivation **[P]**

Everything is derived from the wallet's existing secret, so that restoring the wallet restores its
shielded keys. The wallet's existing secret is the 64-byte BIP-39 seed from which its account key
is already derived (mnemonic and optional passphrase → PBKDF2 → 64 bytes).

| Key | Derivation |
|---|---|
| `sk` | `okm = HKDF-SHA256(ikm = BIP-39 seed, no salt, info = "rouge-shield/sk", L = 64)`; `sk[i]` = (LE u64 of `okm[8i..8i+8]`) mod p, i = 0 … 7 |
| `nk` | `H(1; sk)` (§2.3) |
| `pk` | `H(2; sk)` (§2.3) |
| viewing key | `d ‖ z = HKDF-SHA256(ikm = BIP-39 seed, no salt, info = "rouge-shield/view", L = 64)`; the ML-KEM-768 key pair is `ML-KEM-768.KeyGen_internal(d, z)` (FIPS 203) with `d`, `z` 32 bytes each. The decapsulation key is the viewing key |

The labels are the design's (§4 of the design); the construction follows the wallet's existing
account-key derivation (HKDF-SHA256 over the BIP-39 seed with a label). The mapping of the output
to field elements, and wallets that have no recovery phrase, are open issue O-9.

`sk` and `nk` never leave the wallet. The viewing key decrypts incoming notes and cannot spend; a
user MAY give it to an auditor.

### 5.3 Shielded address

A shielded address is `(pk, ek)`: the 32-byte digest encoding of `pk` followed by the 1,184-byte
ML-KEM-768 encapsulation key — 1,216 bytes.

**Textual form [P] (W-4, W-9, O-11).** Bech32m (BIP-350: the same character set, generator and
checksum constant `0x2bc830a3`) with the human-readable prefix `rshield` and no length limit, of
the 1,225 bytes

`version (1 byte, 0x02) ‖ pk (32) ‖ ek (1,184) ‖ check (8)`

where `check` is the first 8 bytes of
`SHA-256("rouge-shield/v2/address-check/v1" ‖ version ‖ pk ‖ ek)` (the tag is 32 ASCII bytes).
That is `rshield1` + 1,960 data characters + 6 checksum characters = 1,974 characters, lowercase
(an all-uppercase string decodes to the same address; mixed case is invalid).

A decoder MUST verify, each with its own error: the bech32m checksum; the prefix `rshield`; the
payload length (exactly 1,225 bytes — a payload of exactly 1,216 bytes is the withdrawn first form
of this section and MUST be refused as such, not repaired); the version byte (`0x02`; any other
value is refused); **`check`**; that `pk` is a canonical digest (§2.8); and that the encapsulation
key passes the modulus check of FIPS 203 §7.2.

*Why `check` exists, and what it guarantees.* The bech32m checksum is a BCH code of length 1,023
characters. On a string of this length it still detects every single changed character, but not
more: the same change applied to two characters exactly 1,023 places apart leaves it valid, and
the string then decodes to a different, fully valid `(pk, ek)` — a payment to it is lost for
everybody. `check` closes that: any change to the string that passes the bech32m checksum changes
the decoded bytes, and is accepted only if the 64-bit truncated hash matches as well — for damage
that was not searched for against the hash, with probability 2^-64. It is an integrity value
against accidents and blind tampering, not an authenticator: whoever can replace an address
wholesale can compute a correct `check` for their own address.

The transport is copy-paste or a QR code, never typing. A wallet SHOULD show the *address
fingerprint* — the first 8 bytes of SHA-256 of the 1,216 bytes `pk ‖ ek`, hexadecimal — so that
two people can compare an address out of band; it MUST show and compare all of it (a fingerprint
of which only a few characters are compared is found by search in minutes). Not consensus; vectors
in §8.4.

### 5.4 Note data: what the wallet keeps and what a restore recovers

The wallet downloads the encrypted outputs of all V2 transactions in bulk and keeps its own copy
of its note data and its own note tree (design §14, decision 4). It MUST NOT ask a node for the
Merkle path of one position, which would tell the node which note it is about to spend.

**Scanning.** For every accepted V2 transaction since A, in chain order, and for each output j:
decapsulate `kem_ct_j` with the viewing key, derive the key, decrypt `note_ct_j` with
`aad = cm_out_j` (§3.4). If the tag verifies, run the recipient check of §2.4.1 with the
decrypted `(value, r)`. Only a note that passes that check is the wallet's. The wallet MUST take
`nf1`, `nf2`, `cm_out_j` and j from the transaction as accepted on chain, in their on-chain order
— never from the sender or from a message outside the chain — and MUST follow reorganisations: a
note in a block that is no longer on the chain does not exist, and its `rho` may be reused by a
different transaction on the other fork (L-1, rule 6).

*(W-5.)* The viewing key alone decrypts; it does not complete the scan. The recipient check needs
the wallet's `pk` (public: it is in the address), and knowing which notes are spent needs `nk`.
A scanner therefore holds `(dk, pk)` to find incoming notes and their values, and `(dk, pk, nk)`
to also see spends; neither can spend, which needs `sk`. What a user gives an auditor under §5.2
is `(dk, pk)` — incoming notes only.

A wallet that keeps the frontier and per-note paths instead of the whole tree cannot undo an
append. It MUST check that every listed output is at the leaf position its own tree expects next
and MUST refuse a listing that is not, and after scanning it compares its state with what nodes
report (below); after a reorganisation, or on any mismatch, it rebuilds from an empty state by
scanning from A — keeping its record of pending transactions, every one of them as pending (§5.5).

*(W-10, W-14.)* **What one node's listing proves: nothing.** A note that passes the recipient
check is authenticated against `cm_out_j` and the nullifiers *of the same listing*. Nothing ties a
listing to the chain: the chain has no light-client proofs yet (block headers commit the pool
state, §4.8, but a wallet has no way to verify a header). **A single node's listing cannot be
authenticated.** A node that knows a wallet's address — every payer knows it — can list a
transaction that was never mined, with a note the wallet accepts. It can list as mined a
transaction it is holding back. It can replace the nullifiers of a listed transaction and leave
its commitments alone, so that a spend of the wallet's note is hidden, or a payment that was made
looks as if it had not been. Comparing with "the node's latest anchor" does not help: the lying
node reports the root of the tree it made the wallet build — and in the last case that root is
the true one.

**The state check.** The pool state of §4.8 has two halves, and a listing carries both: the
commitments (`cm_out1`, `cm_out2` of every transaction, in order) and the nullifiers (`nf1`, `nf2`
of every transaction, in order). It also carries something the pool state does not commit: the
two ciphertexts of every output. A wallet MUST rebuild all three from the listing it scans:

* the commitment tree — the frontier, `note_count` and `tree_root` of §4.3;
* the running nullifier hash — `nullifier_acc` and `nullifier_count` exactly as §4.5 step 1
  defines them: starting from 32 zero bytes at A, `acc ← SHA-256(tag ‖ acc ‖ nf)` for `nf1` and
  then `nf2` of every listed transaction in listing order; and
* *(W-16, RW3-2.)* the running **ciphertext hash** `ciphertext_acc`: starting from 32 zero bytes
  at A, for every output in tree order,
  `acc ← SHA-256("rougechain.shield_v2.ciphertext_acc.node_local.v1" ‖ acc ‖ cm_out_j ‖ kem_ct_j ‖ note_ct_j)`
  (32 + 32 + 1,088 + 56 bytes after the tag);

and MUST keep, for the heights it may be asked about, the five values
`(tree_root, nullifier_acc, ciphertext_acc, note_count, nullifier_count)` after the block at that
height.

*(W-16, RW3-2.)* **`ciphertext_acc` is node-local and not consensus.** The ciphertexts are in
neither half of §4.8: a listing node could blank or swap them and a wallet whose root and
nullifier hash a quorum had confirmed would never learn that a note was hidden from it. So every
node keeps the hash above **beside** its pool record — not in it, not in the state-root section
of §4.8, not in any block — updated in the same atomic write as the pool record, rolled back
with it when a block is rejected, and rebuilt by a re-import (or, once, from the stored blocks
by a node that was upgraded). Two nodes that disagreed on it would still agree on every block:
it is derived from data consensus already fixed (`cm_out` is in the tree; the ciphertexts are in
the body, and the body is bound by the proof). A node that cannot vouch for it reports `null`,
and its report then counts for nothing.

A **report** is one node's statement of those five values for one height. The node's
`GET /api/shield-v2/stats` returns it as `report: { height, tree_root, nullifier_acc, note_count,
nullifier_count, ciphertext_acc }`, as ONE record that the node writes when it has **accepted**
the block at `height` — stored on its chain — and never while it is still applying a block that
may be rejected. *(API only; RW2-6, RW3-6.)* The wallet labels each report with the identity of
the node it asked.

*(W-16, RW3-1, RW3-8.)* **The configured set.** A wallet state MUST contain the set of nodes the
wallet is configured with, and the quorum is a property of that set:

* **A node's identity is the endpoint the user or the application configured**, in canonical
  form: an http(s) origin `scheme://host[:port]` with scheme and host in lower case, the default
  port removed, and no path, query, fragment or trailing slash. Two spellings of one endpoint are
  one node; a wallet MUST refuse an identity that is not an http(s) origin. It MUST NOT be a
  name, key or address that the node returned about itself: one operator would then be as many
  nodes as it cared to name. That the configured nodes are in fact independent operators is the
  configuring party's choice and risk.
* *(W-18, RW4-2, RW4-7.)* **An IP literal has one spelling, and a set has a rule.** A bracketed
  IPv6 literal is written in its RFC 5952 form; a host whose last label is a number is an IPv4
  literal and MUST be four decimal parts of 0–255 without leading zeros — every other form a
  URL parser would read as an address (`127.1`, `2130706433`, `0x7f.0.0.1`, `127.0.0.01`) MUST
  be refused. A wallet MUST refuse a configured set unless: every node is an `https` origin
  (whoever sits on the network path answers for every `http` node at once — a majority by
  construction); and **each host appears once**, whatever the scheme or the port. The one
  exception is a development set in which EVERY host is a loopback host (`localhost`,
  `*.localhost`, `127.0.0.0/8`, `[::1]`): there `http` is accepted and nodes are told apart by
  port. A loopback node MUST NOT be counted in a quorum together with a node that is not
  loopback. A set SHOULD have an odd number of at least three nodes.
* *(W-20, RW5-7.)* **An IPv6 literal that only spells an IPv4 address is that IPv4 host** for
  the rule "one node per host": IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible
  (`::a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), the NAT64 well-known prefix
  (`64:ff9b::a.b.c.d`) and 6to4 (`2002:AABB:CCDD::/48`). A library MUST refuse a set that
  holds such a literal together with the IPv4 address it spells. Teredo and ISATAP addresses
  and network-chosen NAT64 prefixes are hosts of their own.
* *(W-20, RW5-1.)* **A page that is not the listing of a chain is refused, not applied.** No
  two transactions of a chain share a nullifier (§2.4), and `rho = H_rho(nf1, nf2, j)`: a
  wallet never holds two notes with one `rho`. A library MUST refuse, as a listing error and
  before its state is changed, a page that lists a note of the wallet whose `rho` is that of a
  note it holds or of one the same page listed; and, for a state that was scanned without the
  nullifier key and remembered the nullifiers it met, MUST refuse to apply a remembered
  nullifier that was listed at a height below the block that created the note it belongs to
  (a note is spent in a later block than the one that created it). An error that says "the
  library's own state is inconsistent" MUST NOT be something a node's answer can cause.
* *(W-20, RW5-9.)* **A stored state says where it stands with the restore embargo (§5.5), or
  it is not read.** A library MUST NOT complete a state of its current format with a default
  for the embargo, for the user's statement or for the mark of a state scanned without the
  nullifier key; a state it cannot read gives up its locks to a recovery that puts the result
  under the embargo unless the text itself, readably, says otherwise.
* **The quorum is a strict majority of the configured set**, `⌊n/2⌋ + 1`, and at least 2. A
  height is **confirmed** iff that many configured nodes reported, for that height, exactly the
  wallet's five values. A node counts at most once per height; a node that made two different
  reports for one height does not count there; a report from a node that is not configured does
  not count at all.
* **The threshold MUST NOT depend on the reports at hand.** Asking fewer nodes, or leaving out a
  node that disagrees, can only make a confirmation harder. Changing the configured set is an
  explicit act of the user or application; it does not un-confirm what was confirmed and applies
  to every later confirmation.
* **With fewer than two configured nodes nothing is confirmed.** A single-node wallet shows
  every note as unverified and builds no transfer or unshield (§5.5). A merchant-facing
  integration — anything that releases goods or credits an account on an incoming shielded
  payment — MUST be configured with nodes it has reason to trust, its own among them.
* **A dissenting minority does not block.** Within the trust model — a strict minority of the
  configured nodes lies arbitrarily — a strict majority contains an honest node, and an honest
  node's report is the chain's state at its height; the wallet's state there is the chain's
  whatever the others say. A wallet MUST return which configured nodes contradicted it, by node
  and height, so that an interface can say "node X disagrees".
* **When the listing is what is wrong.** If at one height more configured nodes contradict the
  wallet than a lying minority can be (more than `n − quorum`), at least one honest node says
  that the wallet's listing is not the chain: the wallet MUST say so (*listing refuted*) and the
  client rebuilds from an empty state against **another** node. The same when the listing shows
  pool transactions in blocks above the height a quorum has reached — the quorum-th highest
  height the configured nodes claim — and keeps doing so when the nodes are asked again
  (*listing ahead*): nobody can contradict a block nobody has, and a listing node that invented
  one in which a note of the wallet is "spent" would otherwise keep that note out of every
  balance until the chain got there.
* A wallet MUST keep a confirmation status per note. A note is **unverified** when it is found
  and **confirmed** when its height is at or below a confirmed height.
* A wallet MUST report confirmed and unverified balances separately, MUST NOT spend an unverified
  note — neither select it nor accept it as an input of a transaction it builds — unless the
  caller explicitly asks for it, and **MUST NOT present an incoming shielded payment as final on
  one node's word**: the user interface shows it as unconfirmed until its height is confirmed.

Why matching values are evidence: the root commits every output commitment up to that height in
order, the running hash commits every nullifier up to that height in order, the ciphertext hash
commits the two ciphertexts of every output, and by §4.3 item 3 the k-th transaction is entries
`2k` and `2k + 1` of each. If all are the nodes', every transaction the wallet read up to that
height — which nullifiers with which outputs and which ciphertexts — is one those nodes hold,
and there is no other. A listing with an invented, hidden, reordered or altered transaction, or
with a blanked or swapped ciphertext, gives another root or another hash. **The confirmed balance is therefore exact as of
the confirmed height, and only as of it**: a spend above that height that the wallet's listing
hides is not known to the wallet until a later height is confirmed — or cannot be.

This is not a new weakness of the shielded pool and the quorum is not a proof: it is the word of
a majority of the configured nodes instead of the word of one — **the same trust a wallet places
in a node today for ordinary account balances**, which are also shown "as reported by the node".
A majority of the nodes a wallet is configured with, lying together, is believed. Proofs against a header-committed pool state
(so that a wallet needs no node's word at all) come with the consensus and light-client work,
which is outside this specification.

*(W-10, F-3.)* A state that holds a note found with `(dk, pk)` alone has no nullifier for it. It
MUST remember every nullifier that appears on chain from then on, so that the spends can be
applied when `nk` is supplied; if it cannot (its memory for them is bounded), it MUST refuse to
continue with `nk` and require a rescan, rather than show as unspent a note that may be spent.

*(W-10, F-4.)* A listing is input from the network. A wallet MUST validate every string of it
before storing anything — nullifiers, commitments and ciphertexts as fixed-length lowercase
hexadecimal, the transaction hash as exactly 64 lowercase hexadecimal characters, the type as one
of the three of §3 — and MUST bound the size of a page it accepts. It MUST NOT store a zero-value
note (nothing can be done with it; anybody can send them).

*(W-14, RW2-7.)* **Dust.** Anybody who knows an address can send it notes, at one fee per two
notes. A wallet SHOULD NOT store an incoming note whose value is below a minimum the caller sets
— default: the minimum fee of §3.5, since a note worth less than the fee to spend it cannot be
spent alone — and SHOULD count such notes instead, so that the user can be told. Such a note is
in no balance; a wallet that later wants it rescans with a lower minimum. A wallet SHOULD bound
what it stores per note (paths of neighbouring notes share their upper nodes) and SHOULD drop
spent notes whose spend is long confirmed.

*(W-16, RW3-3, RW3-4.)* **What the dust rule and the cap do not apply to.**

* **A wallet's own outputs.** A note the wallet created itself — the change of its own
  transaction, a payment to its own address — MUST be stored whatever its size. The wallet knows
  them two ways: from its pending record (below, §5.5), and, on a restore, because the
  transaction that created them spends one of the wallet's notes, which only the wallet's key can
  do. Coin selection SHOULD avoid a change above zero and below the minimum where a selection
  without one exists, and SHOULD say so where none does.
* **Spent notes.** A bound on the number of stored notes MUST count unspent notes only, and a
  scan over a long history MUST end with every unspent note stored: a wallet keeps a bounded
  number of spent notes for display and drops the rest as it scans. The bound is a parameter of
  the state (default 65,536); notes that arrive while that many unspent notes are held are
  counted, not stored, and a rescan with a higher bound recovers them. Filling the default bound
  with notes of the default minimum value costs a sender 32,768 fees and 65,536 XRGE handed to
  the victim.

**The wallet stores**, for every note it owns: `value`, `rho`, `r`, the leaf position, `cm`, the
transaction that created it, and whether its nullifier `H(3; nk ‖ rho)` has appeared on chain. It
also stores what it needs to produce Merkle paths for its unspent notes against a root in the
anchor window (the tree, or the frontier plus one witness per note, kept current as leaves are
appended), and its own record of what it sent.

**A restored wallet recovers from the recovery phrase and chain data alone:**

* its keys and its address (§5.2);
* every note ever sent to its address in a conforming transaction, including its own change —
  value, `rho`, `r`, position — by scanning from A;
* which of them are spent, by computing each nullifier and looking for it on chain;
* its shielded balance, and Merkle paths for every unspent note, by rebuilding the tree from all
  `cm_out` since A.

**It cannot recover from chain data alone:**

* the recipient and amount of payments it sent to other wallets (the outputs are encrypted to the
  recipient only; see open issue O-10 on a sender's copy);
* a note whose sender wrote ciphertexts that do not decrypt and handed over `(value, r)` some
  other way: it is spendable only if the wallet kept `(value, r)`;
* labels, contact names and anything else that was never on chain.

No shielded funds are lost by losing the wallet's local copy, provided every note was delivered
through conforming ciphertexts.

### 5.5 Building a transaction

* The wallet chooses an `anchor` from the anchor window. *(W-11, W-15, rewritten W-17.)* **For a
  transfer or an unshield the anchor MUST be the wallet's tree root at its confirmed height C
  (§5.4), and `expiry_height` MUST be above C and at most C + 128**; a wallet SHOULD use exactly
  **C + 64** (§5.8). Neither is taken from the caller, from the height the scan has reached or
  from anything else one node said: the scanned height is the listing node's claim, and a
  transaction whose expiry was measured from it would stay minable — and its inputs locked — for
  as long as that node cared to claim (RW3-7). A wallet without a confirmed height MUST NOT build
  a transfer or an unshield. A wallet whose tree root is above its confirmed height (its listing
  has shown outputs nobody has confirmed) MUST refuse too, unless the caller explicitly accepts
  an unconfirmed root — and then the expiry is still measured from C. (A shield spends no note
  and locks nothing; its `expiry_height` is at most 128 above the height the caller read.)
  **`expiry_height` is the only thing that limits how long a transaction can be mined** — the
  anchor window does not (§4.3 item 8) — and the node accepts a transaction in block H while
  `expiry_height ≥ H` (§3.6 check 7), so the last block that can hold it is block
  `expiry_height`.
* It builds the body (§3.2), computes `binding = binding_from_bytes(body)`, and proves the
  statement of §2.7 for the public inputs taken from the body. The nullifiers must be fixed before
  the output commitments can be computed, because each output's `rho` is `H_rho(nf1, nf2, j − 1)`.
* The wallet MUST check its own transaction with `verify_spend` before submitting it.
* Output slots have no consensus meaning. A wallet SHOULD place the payment and the change in a
  random order. A receiving wallet MUST try both slots of every transaction.
* A wallet MUST NOT spend the same note in both input slots (the verifier refuses `nf1 = nf2`).
* *(W-6.)* The node accepts a `shield_v2` with `fee = v_in` (§3.6 check 10: `fee ≤ v_in`); it
  creates two zero-value notes and shields nothing. A wallet SHOULD NOT build one, and SHOULD NOT
  build a transfer whose payment is zero or an unshield it cannot pay for.
* If the prover reports that a proof exceeds 200,000 bytes, that is an implementation fault, not a
  condition to retry: under the pinned parameters it cannot happen (§7, C-1).
* *(W-11.)* A wallet SHOULD refuse a `fee` above a ceiling the caller sets (default: 10 × the
  minimum fee of §3.5): the fee is whatever the inputs exceed the outputs by, and a unit mistake
  would otherwise burn a note.

*(W-11, rewritten W-15.)* **Pending transactions.** A `shielded_transfer_v2` or `unshield_v2`
has no signer and no nonce. Once it has left the wallet — handed to any node, relay or proxy — it
stays valid until `expiry_height` (§3.6 check 7), **whatever anybody answered when it was
submitted**. A node that answers "rejected" and keeps the transaction can have it mined later. If
the wallet meanwhile builds the "same" payment again from *other* notes, both transactions are
valid and the payee is paid twice. The rule that follows from it:

> **A wallet believes nothing about a transaction's fate that it cannot tie to data a quorum of
> nodes vouches for.**

*Recording.* Before a transaction leaves it, the wallet MUST record it in its persistent state:
**both nullifiers and both output commitments** (`nf1`, `nf2`, `cm_out1`, `cm_out2` — together
they identify the transaction in a listing), the notes it spends, its `expiry_height`, and
*(W-17)* **every note the transaction creates for the wallet itself — its change, a payment to
its own address — with value and `r`**, so that the wallet stores that note from its own record
when the commitment appears, whatever a listing serves as its ciphertext (RW3-2). The notes it
spends are **locked** from that moment: the wallet MUST NOT select them or hand them to a
builder. A lock belongs to the note — its commitment — not to a leaf position.

*(W-17, RW3-5.)* **Building and locking are one operation.** A wallet library MUST NOT offer a
way to obtain a proven transfer or unshield without the state in which its inputs are locked and
its record is written: the call that builds takes the state (and the revision the caller expects
it to have) and returns the transaction **together with** the new state. The client's rule is
one sentence: **persist the returned state, then submit.** A client that could not persist the
state does not submit, and builds again. A client that is certain it never submitted MAY say so;
that is a hint for the interface and releases nothing — the library cannot check it, and if it
is wrong, releasing would be a double payment.

*Settlement.* Let C be the highest confirmed height (§5.4). A pending transaction is settled, and
its lock ended, in exactly three cases, each decided on the wallet's own data up to C:

| Outcome | Condition | The wallet then |
|---|---|---|
| **mined** | a listed transaction at a height ≤ C has BOTH nullifiers of the record and BOTH its output commitments | treats the inputs as spent; the change is a confirmed note |
| **superseded** | a listed transaction at a height ≤ C has at least one of the record's nullifiers and is NOT that transaction (its outputs differ) | knows the transaction can never be mined and that the payment was NOT made. It marks as spent only the inputs whose own nullifier appeared, and releases the others |
| **expired** | C ≥ `expiry_height`, and no listed transaction at a height ≤ C has one of the record's nullifiers | knows the transaction can never be mined; releases all inputs |

* **Anything else leaves the transaction pending and its inputs locked.** In particular: a
  listing that shows the transaction at a height nobody has confirmed; a scanned height at or
  above `expiry_height` that nobody has confirmed; and any response to the submission — an error,
  a timeout, "rejected" — which a wallet MAY record as a hint for the user interface and MUST
  NOT act on. A wallet MUST NOT offer a way to release a lock on one node's word.
* A note is marked spent when **its own** nullifier appears in the listing, never because another
  input of the same pending transaction was spent. Two devices that hold the same recovery phrase
  share no storage and cannot share locks: each can spend a note the other has locked. That is
  the *superseded* case, and it loses nothing.
* The expected change is stored from the wallet's own record when its commitment appears in the
  listing, and credited like any other note — when its height is confirmed, which is when the
  transaction settles as mined — and not before.
* *(W-17, RW3-7.)* **Settlement is bounded.** `expiry_height ≤ C_build + 128`, where `C_build`
  is the confirmed height at the build, and a confirmed height is one the chain has reached. So
  once the confirmed height reaches `expiry_height` — at most 128 blocks after the build — the
  transaction is in exactly one of the three rows above, **whatever a lying minority served in
  the meantime**; the minority can delay the confirmation, by the time it takes the client to
  list from another node, and nothing else.
* The comparison for *expired* is exact. The node refuses a transaction whose `expiry_height` is
  below the block's height (§3.6 check 7), so block `expiry_height` is the last that can hold it;
  C ≥ `expiry_height` means that block has been read and confirmed.
* A user interface MUST show such a payment as pending until it is settled, MUST NOT offer "try
  again" before it is settled as *superseded* or *expired*, and MUST NOT report *superseded* as a
  payment. A second payment made while the first is pending is a second payment.
* A wallet that rebuilds its state (§5.4) MUST carry every unsettled record over **as pending and
  locked** — never as mined, whatever its old state had seen of it — and settles it again from
  the rescanned data, once that data is confirmed.
* Two writers of one stored state (two tabs, a page and a worker) MUST NOT overwrite each
  other's records: a lost record is a lost lock. A wallet state SHOULD carry a revision that
  changes with every write, checked when the state is stored. *(W-19, RW4-10.)* **A counter is
  not enough**: two writers that start from revision `r` both hold an "r + 1". The revision
  SHOULD identify the content — a hash over the previous revision's identity, the counter and
  the change — and the state is stored only if the stored identity is still the one the writer
  loaded.
* *(W-18, RW4-5.)* **A pending record holds its input notes by their commitments and by its
  nullifiers — never by a leaf position.** A position is derived from the wallet's own tree and
  recomputed; the leaf number a listing gives an output is the listing node's claim and MUST
  NOT be written into a record. **A wallet library MUST NOT return or write a state that it
  would refuse to read**: every operation that changes a state validates the result by the
  rules it applies when reading one, and refuses the operation, leaving the state as it was,
  if the result would not pass. A stored state that cannot be read MUST NOT force the user
  into a new state without locks: the library MUST offer a recovery that carries every pending
  record it can read (nullifiers, input commitments, outputs, expiry) into an empty state to
  rescan into, and that state is under the embargo below if any record could not be read.
* *(W-17, RW3-10.)* **Locks are per device.** They live in the wallet state, and a second device
  on the same recovery phrase, or the same device after a restore from the phrase, has none. If
  such a device picks the notes a pending transaction of the other spends, one of the two
  transactions is *superseded*: nothing is lost. If it picks OTHER notes for "the same" payment
  while the first transaction is withheld, both are mined: no wallet library can prevent that,
  because the second device does not know the first transaction exists. The user interface
  MUST: (a) tell the user, after a restore and on first use of a phrase on a new device, that
  payments made from another copy of the wallet may still be in flight and are not shown here;
  (b) *(replaced by W-19, below)*; and (c) never suggest "pay again" for a payment whose state
  it does not hold.
* *(W-19, RW4-1; replaces item (b) of W-17, whose rule — "128 blocks above the first height
  confirmed after the restore" — ended too early: the first height a restored device confirms
  can be BELOW the height the lost copy built at, when the quorum that confirms it consists of
  a lying node replaying a true old state and an honest node that is behind.)* **The embargo
  after a restore is enforced by the wallet library.** A state created from the recovery
  phrase — a new wallet, a restore, a second device — has no lock history. The library MUST
  refuse to build a transfer or an unshield from it until a confirmed height exists, and MUST
  fix, at the FIRST state check that confirms a height, the **embargo base**:

  * `Tq` — the quorum's tip: the highest height that a strict majority of the configured nodes
    claim to have reached, a node's claim being the highest height it reported in that check;
  * `Tm` — the highest height ANY configured node claimed in that check;
  * `base = min(Tm, Tq + 256)` if every configured node reported, and `base = Tq + 256` if one
    did not (a node that is silent is treated as if it had claimed the highest tip);
  * no transfer or unshield until the confirmed height is at least `base + 128`. The longest
    expiry a library accepts and the length of the embargo are the same number.

  *Why.* A copy that built at confirmed height `C_b` had a quorum for `C_b`, so an honest node
  had reached `C_b`, and an honest node's height never decreases; the transaction cannot be
  mined after block `C_b + 128`. If `base ≥ C_b`, then at confirmed height `base + 128` every
  block that could hold it is read and confirmed: it is mined, and its inputs are spent in
  this state, or it never will be. A lying minority is fewer than a quorum: it cannot lower
  `Tq` below what the answering honest nodes support and cannot hide the tip of an honest node
  that answers. By claiming a high tip or by not answering it raises the base — by at most
  256 blocks: a bounded delay (G4).

  *The assumption that remains.* The rule is sufficient **iff `C_b ≤ Tq + 256`**: the nodes
  whose tips form the first quorum after the restore are at most 256 blocks behind the height
  the lost copy last built at. Where fewer nodes lie than any two quorums have in common
  (`2·quorum − n`) the quorums share an honest node and nothing is assumed; with three, five
  or seven nodes and a full lying minority they may share only liars, and then the embargo is
  a margin of 256 blocks of honest lag and not a proof. A wallet without header-committed
  proofs of the pool state cannot do better; this is stated to the user as in (a).

  *The override.* A library MAY accept the user's explicit statement that no other copy of the
  wallet has a payment in flight. It MUST be an explicit, named input; it MUST be recorded in
  the state; and it MUST NOT be accepted after the base is fixed. *(W-20, RW5-5: W-19 added
  "it SHOULD be disregarded when the first state check shows a configured node ahead of the
  height being confirmed". That is withdrawn — the condition is met by one block arriving
  while the nodes are asked, which cost an honest user the whole embargo, and a liar avoids it
  by waiting for a check in which the leading node is slow.)* **Once recorded, the statement
  stands**: the first state check establishes the state without an embargo. It is therefore
  exactly as strong as it is true, and the rule that matters is the client's: a client MAY
  make the statement without asking only for a phrase that was generated on that device in
  that installation, and MUST NOT make it for an imported or restored phrase unless the user
  was shown, and explicitly confirmed, what it says (`UI_CONTRACT.md`, obligation 1). A state
  that continues a device's own stored state (a migration, a recovery with every record read)
  is under no embargo.
* *(W-19, RW4-4.)* **"Payment to self" is the whole address.** A payment output belongs to the
  wallet's own record only if the recipient address — `pk` AND encryption key — is the
  wallet's own. A library MUST refuse a recipient whose `pk` is the wallet's own and whose
  encryption key is not: the note would be the wallet's and readable only by the other party,
  and the wallet would lose it at its next rescan. *(W-19, RW4-11.)* A `shield_v2` to the
  wallet's own address SHOULD be recorded in the state with its `(value, r)` like a change, so
  that its note is stored whatever its value; a library SHOULD refuse to build a shield whose
  note is below the minimum note value unless the caller says so explicitly.
* *(W-18, RW4-3.)* **A state scanned without the nullifier key cannot see spends.** It MUST be
  marked; while it is marked it MUST NOT report as confirmed any note whose nullifier it does
  not know, MUST report nothing as spendable, and MUST NOT build — until a scan with the full
  key has derived every missing nullifier and applied the spends that were remembered.

*(W-19, RW4-8, RW4-9; restated by W-20, RW5-2, RW5-3.)* **The client loop.** The rules of §5.4
and of this section say what each signal means; this is how a client SHOULD combine them —
how often "ask again" is, in which order nodes are tried, when a node is left and when it is
banned, what is persisted when, and when the loop stops. *(As written for W-19 the loop left a
listing node on three signals that a node which never reaches its tip triggers none of, and
on a refuted listing it banned the node being listed from at that moment — after a change of
node without a rescan, an honest one. Both are corrected here.)* `S` is the stored state, the
calls are those of a wallet library with the operations of this specification (the names are
the reference implementation's; the loop itself is `core/shield-v2-wallet/tests/common/
client_loop.rs`, and `core/shield-v2-wallet/NOTES.md` §6 has the same text with its reasons):

```
CONSTANTS (the client's; none is consensus)
  B = 64   blocks asked for per page: GET L/api/shield-v2/notes?since=…&blocks=64
  P ≥ 1    pages per round (the client's choice; the reference uses 6)
  K = 3    consecutive rounds a listing node may fail to deliver before it is left
  W = 5    rounds the first state check of a state without an embargo base waits for every node
  R        keeps the reports of the last 3 rounds, at most 1,024

STORED    S            the state, under its revision_id
          listed_from  the node every page that S holds above its confirmed height came from
SESSION   (memory only; lost in a crash and when the application ends)
          L        the node listed from
          bad      nodes whose listing was shown not to be a chain's
          strikes  rounds in a row in which L did not deliver
          prev     S.scanned_height at the end of the previous round on L (none at first)
          waited   rounds the first state check has waited
          R        the reports

START OF A SESSION
  bad := {}; strikes := 0; prev := none; waited := 0; R := {}
  L := listed_from. If listed_from is not known: L := any node of N, and if
       S.scanned_height ≠ S.confirmed_height then S := rescan_state(S) → persist.
  A `state:` error on the STORED state: recover_locks(text) → persist → set_nodes if
       nodes_kept is false. NEVER new_state: that state has no locks.

ROUND
  0. stopped → return (nothing is asked, nothing is written).
  1. at most P times:
       page := the answer of L for since = S.next_height, blocks = B
       no answer, or not a page          → strikes += 1; if strikes ≥ K: LEAVE(no ban), end
                                           the round; otherwise go to step 2
       r := scan(S, page, FULL scan key)
       `listing:`                        → LEAVE(ban); end the round
       `rescan_required:`                → S := rescan_state(S) → persist; prev := none;
                                           L stays, NOBODY is blamed (the client's own
                                           worker caused it); end the round
       `stale_state:`                    → another writer changed S: reload S; end the round
       `state_invariant:`, anything else → STOP(fault): report a bug. S stays as it is stored:
                                           no rescan, no new_state, no retry
       ok                                → persist
           r.leaf_mismatch               → LEAVE(ban); end the round
           not r.at_tip and (the page is not active, or
             page.next_height − page.from_height < B)
                                         → LEAVE(ban); end the round            ("a short page")
           r.at_tip                      → at_tip := true; go to step 2
  2. ask EVERY node of N for /api/shield-v2/stats at the same time; take `report`; drop one
     that is null or not a report; label each with the CONFIGURED origin — never with anything
     the node says about itself. A report without `ciphertext_acc` is handed in as it is: the
     core names that node in `outdated_nodes` (no vote; "node X must be updated").
     Add them to R; drop from R what is older than three rounds.
     2a. if S has no embargo base (summary.spend.embargo_until = null) and the user's statement
         is not recorded (summary.sole_copy_asserted = false):
           unless THIS round's answers hold a report from every node of N for one common height,
           and while waited < W:   waited += 1; show "waiting for every node (waited of W)";
                                   end the round
  3. c := confirm_state(S, R) → persist.     (a base now exists ⇒ waited := 0)
       c.listing_refuted                 → LEAVE(ban); end the round
       c.quorum_tip = T exists (a quorum answers):
         not at_tip and S.scanned_height < T
                                         → catching up: prev := S.scanned_height; no verdict
         otherwise, with  ahead       = c.listing_ahead
                          short       = at_tip and S.scanned_height < T
                          unconfirmed = prev exists and S.confirmed_height < prev
                                        (nothing confirmed counts as below everything)
           prev := S.scanned_height
           ahead or short or unconfirmed → strikes += 1; if strikes ≥ K: LEAVE(no ban), end
                                           the round
           none of the three             → strikes := 0
       no quorum_tip                     → nothing is counted (the node is not what is missing)
  4. resolve_pending → persist → tell the user: mined / superseded / expired.
  5. for every entry that is still pending and whose envelope is stored: if its submit failed
     or was not answered, submit THE SAME envelope again (to any node). Never build again for it.
     A payment is offered only if
       – at_tip, this round's confirm_state matched, and confirmed_height = scanned_height;
       – `spend.can_spend_now` of that result (the core's answer: no embargo, not view-only,
         the root confirmed, a window left);
       – the payment is new, or step 4 reported its last attempt superseded or expired.
     build_*(S, revision) → persist { state, envelope } DURABLY, in one storage transaction,
     compare-and-swap on the revision_id that was LOADED → submit the envelope.
     Not written ⇒ discard the result and do not submit.

LEAVE(ban)
  if ban: bad += L
  next := the first node after L, in the order of N, cyclically, that is not in bad and is not L
  no such node, and L ∈ bad    → S := rescan_state(S) → persist; listed_from := unknown;
                                 STOP("no honest listing node reachable"). bad is NOT cleared.
  no such node, L not in bad   → strikes := 0; prev := none; return   (L is the only node left)
  if ban, or S.scanned_height ≠ S.confirmed_height:  S := rescan_state(S)
  L := next; listed_from := next → persist S and listed_from together
  strikes := 0; prev := none
  (The user choosing another node in the settings is LEAVE(no ban).)

STOP  The loop does nothing more in this session. "no honest listing node reachable" is shown
      to the user with the banned nodes; a fault is reported as a bug. A new session — the
      application started again, or the user's explicit "try again" — starts with bad empty;
      nothing else ever removes a node from bad.

THE BACKGROUND WORKER (export_scan_key(seed, false): the viewing key)
  lists from L and from no other node, persists under the same compare-and-swap, and applies
  the rules of step 1 to every answer. The state it leaves is marked view-only: nothing is
  built from it until step 1 has applied one page with the full key (W-18). After a
  `rescan_required:` the worker is not started again in that session.

AFTER new_state (a new wallet, a restore, a second device)
  nothing for the client to remember: the core refuses build_* (`restored_recently:`) until
  the embargo has ended. Show `spend.reason = "embargo"`, `embargo_until`,
  `embargo_blocks_left` and "payments made from another copy of this wallet may still be in
  flight". `assert_sole_copy`: `UI_CONTRACT.md`, obligation 1 — never from this loop.
```

*A node is banned only on evidence, and left without it.* Evidence is what no honest node
produces: a listing error, leaf numbers below the wallet's own tree, a page that neither
reaches the node's tip nor covers the 64 heights asked for (64 blocks hold at most
`64 · SHIELD_V2_MAX_TX_PER_BLOCK` = 512 transactions, the listing's cap), a refuted listing. A
node that does not get the wallet to where the quorum is may be honest — ahead, behind, or
listed from while the others lag: it is left after K rounds and comes round again. *The state
is rescanned on every change of the listing node unless everything it holds is confirmed*:
every unconfirmed page of a state is then its current listing node's, so the node that is
banned is the node that lied; a state whose scanned height is confirmed is the chain's,
whoever listed it. *Termination.* A tenure of one node lasts at most `D + 1 + K` rounds,
`D = ⌈(T − A + 1) / (B·P)⌉` being the rounds it takes to read the chain to the quorum's tip
`T` at the speed step 1 enforces; with a strict majority of honest nodes reachable at the tip
the loop ends with the tip confirmed within `(n − quorum + 1)·(D + K + 2) + W` rounds, or has
stopped because every node is banned.

**Every bound in these rules is a number of blocks**, and this chain produces a block when a
transaction is pending, not on a clock: on a quiet chain 64 blocks have no upper bound in time,
on a busy one they are well under a minute. A user interface MUST show these bounds as blocks,
SHOULD show how far the quorum's tip is above the confirmed height (a spend is measured from
the confirmed height, so that many blocks of its life are already gone), and answers a lost
submission by submitting the SAME envelope again, not by waiting for the expiry. Confirmation
needs a quorum of nodes that report ONE height: a client keeps the reports of the last rounds
and asks again.

*(W-17.)* **What these rules guarantee**, for a wallet whose configured nodes are honest in their
strict majority, against any behaviour of the others, of senders and payees, with several
devices and crashes at any point: **(G1)** the wallet's own behaviour never pays twice — a
payment is retried only after the wallet has settled the previous attempt as *superseded* or
*expired*, and those are true; **(G2)** the confirmed balance never exceeds the true balance at
the confirmed height; **(G3)** nothing is locked or hidden from view for longer than it takes
the confirmed height to advance 128 blocks past the build, while an honest majority is
reachable; **(G4)** a lying or unreachable minority causes delay only. Outside that model — a
majority of the configured nodes lying together, or one operator behind most of them —
everything "confirmed" is theirs (§5.4).

Why *mined* needs the outputs and not only a nullifier: a nullifier of the record appears whenever
*any* transaction spends that note; and two transactions built from the same two notes have the
same two nullifiers. Why it needs the nullifier hash and not only the tree root: see §5.4 — a
node that swaps a mined transaction's nullifiers in its listing leaves the root true, and the
wallet would see neither the spend nor its own change (whose `rho` is derived from the
nullifiers). *The W-11 text justified releasing on "a matching root at a height at or above
`expiry_height`"; that sentence was wrong (a matching root shows that the trees are the same, not
what is in them) and the rule it justified let one lying listing node undo a quorum of honest
ones. It is withdrawn; the table above replaces it.*

### 5.6 Randomness: the blinding seed and `r` (closes F-6 and L-5)

In hiding mode a 32-byte blinding seed is the **only** entropy of the proof's blinding — the
random trace rows and columns, the quotient masks, the randomisation polynomial and every Merkle
leaf salt. The proof is a deterministic function of (trace, public inputs, seed).

Requirements:

1. The seed MUST be 32 bytes drawn from the operating system's cryptographically secure random
   number generator, **inside the proving function, once per proof**.
2. The production proving function MUST NOT have a seed parameter, and no wallet code path may
   supply, store, derive, log or reuse a seed. In particular the seed MUST NOT be derived from the
   recovery phrase, a counter, a timestamp or the transaction.
3. If the operating system's generator is unavailable or reports an error, proving MUST fail. It
   MUST NOT fall back to another source.
4. The prover SHOULD additionally mix the witness and the public inputs into the blinding
   (`H(OS entropy ‖ witness ‖ public inputs)`), so that a generator that repeats does not repeat
   the masks across different statements. This is a hardening on top of 1–3, not a substitute.
   *(W-7.)* The wallet prover does this as
   `seed = Blake3-keyed(key = the 32 bytes of OS entropy; "rouge-shield/v2/prover/blinding-seed/v1"
   ‖ counter (u64 LE) ‖ public inputs (216 bytes, §2.8) ‖ witness)`, where `counter` counts the
   proofs started by the process, so that a generator that repeats within one process does not
   repeat the masks even for the same statement, and `witness` is every private value of §2.7 in
   a fixed order. The construction is not observable from outside the prover and is not a
   protocol constant; another prover MAY hedge differently as long as 1–3 hold.
5. The fixed seeds of the test vectors (§8) exist only to make bytes reproducible. A wallet MUST
   NOT use a fixed seed.
6. *(W-12.)* Everything else a transaction draws at random — the `r` of each output, the
   ML-KEM-768 encapsulation randomness of each output (§3.4), the `d`, `z` of the discarded key
   and the random `pk` of a zero-value output, the `sk`, `rho`, `r` of each dummy input (§5.7) and
   the order of the output slots (§5.5) — MUST be hedged in the same spirit as item 4, because a
   generator that repeats is exactly as harmful there: two notes of one transaction encrypted
   under one key, one `r` for every note a wallet ever makes (and `r` is what a payee is given),
   repeated dummy nullifiers. The wallet core derives all of it from **one generator per
   transaction**:

   `prk = HMAC-SHA256(key = 32 bytes of OS entropy; "rouge-shield/v2/wallet/tx-randomness/v1" ‖
   counter (u64 LE) ‖ the spending key (absent for a shield) ‖ the transaction's inputs and
   outputs)`, and each value is
   `HKDF-Expand(prk, use label ‖ slot index (1 byte) ‖ draw number (u32 LE))`,

   where `counter` counts the transactions assembled by the process, the transaction's inputs and
   outputs are its type, chain tag, anchor, expiry, fee, input notes (position, value, `rho`, `r`),
   recipient and amounts in a fixed encoding, there is one label per use, and field elements are
   taken by rejection sampling of 31-bit draws. Requirements 1 and 3 hold unchanged: one read of
   the operating system's generator per transaction; if it fails or returns only zero bytes,
   building fails — the hedge is never a substitute for it. As in item 4 the construction is not
   observable from outside and is not a protocol constant; what is required is the property: no
   two draws of one wallet coincide unless the generator, the counter, the key and the whole
   transaction coincide, and never two draws inside one transaction.

**What breaks if a seed is reused or leaks.** Whoever learns the seed can strip every mask and
read the whole witness from the proof: spending key, values, positions. Two proofs of *different*
witnesses made with one seed carry identical masks, and their openings at a common query index
reveal differences of witness columns — the privacy of both transactions is lost, with no way to
repair it after publication. (The same witness proved twice with one seed just yields the same
bytes.) Soundness is not affected; nobody gains the ability to forge.

The commitment randomness `r` of every output note MUST be 8 field elements sampled uniformly from
[0, p) with the same generator (for example by rejection sampling of 31-bit values), fresh for
every note. Since `rho` is public, the hiding of a commitment rests on `r` alone: an `r` that is
predictable or repeated lets an observer test guesses of `(value, pk)` against the commitment.

### 5.7 Dummy inputs (the wallet half of L-1)

For every dummy input — both inputs of a shield, the second input of a one-note transfer or
unshield — the wallet MUST draw a fresh `sk`, a fresh `rho` and a fresh `r` (8 uniform field
elements each) from the operating system's generator (*W-12:* through the per-transaction hedged
generator of §5.6 item 6, which is keyed by it), **for that transaction only**. They MUST NOT
be derived from the recovery phrase, from a counter or from any stored state, and MUST NOT be
reused. The wallet need not keep them after the transaction is accepted. The same holds for the
random `pk` of a zero-value output.

Why: a dummy's nullifier is `H(3; H(1; sk) ‖ rho)` of exactly these values. A wallet that repeats
them publishes a pair `(nf1, nf2)` that is already in the nullifier set, and the node refuses the
transaction (§4.2). For an honest wallet the cost is a failed transaction, not lost funds; and
nobody else can cause it, because producing given nullifiers needs their preimages. The node's
rules are what protect recipients against a sender that repeats dummy secrets on purpose; this
rule keeps honest wallets from tripping over them — for example a wallet restored from a backup
that also restored a random-number state.

### 5.8 Privacy from the node (W-13)

The proof hides what a transaction spends and creates. It does not hide the wallet from the node
it talks to, and three things a wallet does are visible there. None of them is a consensus matter;
all of them are a wallet's to mitigate.

* **`expiry_height` is public and chosen by the wallet.** Two clients that pick it differently —
  "tip + 100", "tip + 20", a wall-clock rule — sort their users into groups on chain. Every
  wallet SHOULD use the one fixed offset of §5.5, anchor height + 64, so that the expiry carries
  no more than the anchor already does.
* **The anchor links a transaction to a sync.** The anchor says how recent the sender's view was
  (§6), and the node that served the listing knows which client had synced to exactly that
  height just before. A transaction that then arrives through *any* route with that anchor is
  probably that client's. A wallet SHOULD wait a random time between its last sync and
  submitting, and MAY submit through a different node or route than the one it scans from.
* **`since` fingerprints the client.** Each listing request names the height the client has
  reached. A client that asks for `since = 48,113` after having asked for `48,100` is the same
  client, whatever network address it uses now; and its `since` is the anchor of what it sends
  next. A wallet SHOULD round `since` down to a fixed stride (for example a multiple of 64) and
  drop from the answer the blocks it has already applied before it scans the rest, so that many
  clients ask the same question, and SHOULD NOT sync at intervals that identify it.

Also true and not fixable by a wallet: a shield's note value is public (`v_in − fee`), so a later
unshield of the same amount is linkable at any pool size, not only a small one; a self-merge
followed by a payment is a visible two-step pattern; and the node sees the network address of
every request (§6). A wallet that wants none of this runs its own node.

---

## 6. Security statement

**Level.** The proof system has 128 bits of security, proven in the list-decoding regime as
computed by the library's own calculator, exactly at the target with zero margin and counting 16
bits of query grinding. What a proof *means* rests on collision resistance of the in-circuit hash,
whose digest and capacity are 8 KoalaBear elements (≈ 248 bits): **≈ 124 bits classically and
≈ 83 bits against a quantum collision search.** The end-to-end level is the smaller pair: ≈ 124
classical / ≈ 83 quantum. The owner has accepted this level for version 1 (design §14,
decision 2). A security level MUST NOT be quoted for the proof system without the hash figure
beside it.

**What has and has not been examined.** Two independent reviews found no way to make the verifier
accept a false statement or a second encoding of a proof. Neither is a soundness proof. The
security calculator, the Poseidon2 round numbers and constants, and the FRI verifier were read or
re-run, not audited.

**The hiding mode is unaudited.** Zero-knowledge rests entirely on the hiding mode of the proof
library (`HidingFriPcs` over `MerkleTreeHidingMmcs`, 8 random codewords, 5 salt elements per leaf
— the library's minimum for this field). It has not been audited by anyone, upstream or here. The
privacy tests of the research phase can only fail to find a leak; they do not show
zero-knowledge.

**Launch condition.** By the owner's decision (design §14, decisions 5 and 7) the pool may be
activated on mainnet before the external audit, under the cap of 1,000,000 XRGE (§4.4). Until the
hiding mode has been reviewed, product text, documentation and user interfaces **MUST NOT claim
audited privacy**, and MUST NOT describe the pool's privacy as audited, proven or guaranteed.

**What the cap and the accounting limit do.** If the proof system, the circuit or an
implementation were broken, the pool could still never pay out more than was paid in (§4.4), and
never hold more than the cap. Counterfeit notes inside the pool would be a loss for the pool's
users, bounded by the cap, and not for the chain's supply. The cap does nothing for privacy.

**What is hidden** — inside the pool, to the extent the hiding mode holds:

* the amount of a note and of a transfer;
* the sender of a transfer or unshield (which notes were spent, and by whom);
* the recipient of a shield's note and of a transfer;
* whether an input is real or a dummy, and whether an output has value.

**What is public:**

* the amount `v_in` and the funding account of every shield;
* the amount `v_out` and the recipient address of every unshield;
* the `fee` of every transaction;
* the type of every transaction, the time (block) of every transaction, and the number of
  transactions;
* the pool total and the number of notes;
* which anchor a transaction used, hence roughly how recent the wallet's view was;
* the network address of whoever submits a transaction to a public node (out of scope for the
  chain).

With few users, a shield and a later unshield can be matched by amount and time. Privacy is
proportional to how many people use the pool. The two senders of payments to one wallet can tell
that they paid the same address (§5.1).

---

## 7. Corrections to earlier documents

Each statement below was found wrong or incomplete by `REVIEW2.md`, or contradicts this
specification. The corrected statement is normative; the earlier documents are not edited by this
one.

| # | Where | Earlier statement | Corrected statement |
|---|---|---|---|
| C-1 | `RESULTS.md` "Proof-length cap"; `SPEC_DRAFT.md` §9.1 and §12 item 13; `src/config.rs` comment on `MAX_PROOF_BYTES`; `README.md`; design §14 decision 6 ("a wallet that draws a larger proof makes another") | The 200,000-byte cap is a measured margin, not a bound; an honest prover can draw a longer proof and then proves again with a fresh seed | **The cap is a bound.** Under the pinned parameters the largest possible honest proof is **194,893 bytes**, **5,107 bytes** below the cap. An honest prover never exceeds it, and **no re-prove rule exists or is needed.** The relevant margin is those 5,107 bytes (2.6 %), not a number of standard deviations. **The bound depends on the pinned parameters** (trace width 84, trace height, blowup, 45 queries, folding arity, final polynomial length, hiding parameters) and on the library's multiproof being the minimal boundary set: any change of the AIR's width or of a parameter requires the bound to be recomputed, and the test that computes it (`review2_proof_length_bound`) MUST be kept so that such a change fails a test and not a user's transaction |
| C-2 | `README.md` "Verifier and prover API" | "A normal build has exactly two entry points" | A default build exports more than two items (the trace builder, the reference module, other parameter-set constants, four `#[no_mangle]` WebAssembly symbols, two of which panic when called out of order). What is true: **two functions define the protocol** — `verify_spend`, the only one whose result is consensus, and `prove_spend` — and `verify_spend` cannot be reached with other parameters in a default build |
| C-3 | `RESULTS.md` "Output rho" (b); `SPEC_DRAFT.md` §4; `README.md` "Uniqueness" | "The uniqueness of `rho` needs only the node's nullifier-set rule" | It needs **all** of: refusal on a nullifier already in the set *or earlier in the same block*; insertion of both nullifiers, dummies included; a set that is never pruned; atomic insertion of commitments and nullifiers; a tree fed only by accepted transactions; and recipients that read the nullifiers from the chain and follow reorganisations (§4.2, §4.3, §5.4, §5.7) |
| C-4 | `RESULTS.md` "Must-refuse counts" | "46" runs of proofs made under other options | 4 of the 46 are repeats; there are **42 distinct** runs. The total of 598 counts runs correctly |
| C-5 | design §5, first paragraph; design §7 | `rho` is chosen by the sender; the note ciphertext carries `(value, rho, r)` | `rho` of an output is derived (§2.4); the ciphertext carries `(value, r)` and the recipient MUST NOT accept a `rho` from the sender (§3.4) |
| C-6 | design §4 | `nk = H("rouge-shield/nk" ‖ sk)`, `pk = H("rouge-shield/pk" ‖ sk)` | `nk = H(1; sk)`, `pk = H(2; sk)` (§2.3); the circuit fixes them |
| C-7 | design §3 | field: Goldilocks; digest "about 256 bits" | KoalaBear with a degree-8 extension; 8-element digests of ≈ 248 bits (§2.1, §2.2). The design's own §14 already records this |
| C-8 | design §5 | `r` is a 256-bit random value | `r` is 8 uniform field elements, ≈ 248 bits (§5.6) |
| C-9 | `SPEC_DRAFT.md` §12 item 11 | the SHIELD-3 changes have had no independent review | They have had one (`REVIEW2.md`) |

**L-3 — build requirement.** The verifier that is compiled into a node MUST NOT have the
`research` cargo feature enabled, directly or through feature unification with any other crate of
the same build (a benchmark tool, a test helper, the builder of a demonstration page). With the
feature on, the binary also contains verifiers for other parameter sets, including the non-hiding
one, and a prover hook that seeds the transcript for parameters it does not use. For consensus use
the fixed-parameter verifier SHOULD be a crate of its own that has no such feature at all; failing
that, the build MUST fail (`compile_error!`) if the feature is on in a node build. The production
entry points are the ones of §2.11: `verify_spend(public, proof_bytes)` for the node, and
`prove_spend` behind a wrapper without a seed parameter for the wallet. The WebAssembly exports of
the research crate (`shield3_setup`, `shield3_prove`, `shield3_verify`,
`shield3_verify_tampered`) are not production entry points.

**L-4 — error kinds.** Stated normatively in §4.6: only accept / refuse is consensus.

**L-1, L-2, L-5.** L-1 is resolved by §4.2, §4.3, §4.5, §5.4 and §5.7; L-2 by C-1; L-5 (the first
review's F-6) by §5.6.

---

## 8. Test vectors

### 8.1 Files

| File | Content | Status |
|---|---|---|
| `research/shield3/vectors/vectors.json` | the primitives of §8.2, all 33 empty-subtree values, and every private and public value of the three transactions of §8.3 | **normative** for §2 |
| `research/shield3/vectors/shield.public.bin`, `transfer.public.bin`, `unshield.public.bin` | the 216 public-input bytes (§2.8) | **normative** for §2 |
| `research/shield3/vectors/shield.proof.bin`, `transfer.proof.bin`, `unshield.proof.bin` | proof bytes (§2.9.1) | **normative** for §2: `verify_spend` MUST accept each with its public bytes |
| `research/shield3/tests/vectors.rs` | the checker for the above | reference |
| `research/shield2/vectors/` | vectors of the previous circuit | **not** valid for this specification |
| `research/shield3/logs/`, `phone/` | measurement output, demonstration page | not normative |

SHA-256 of the files at the commit of §1.1:

| File | SHA-256 |
|---|---|
| `vectors.json` | `6c8c69b187026890bc291b6bda7addfb5ccc4edda02cb28bce57ffec6c27aaca` |
| `shield.public.bin` | `d374a870ff9f8cd09553136ce1846b8b0de535e557058b3ac5d144362f8915a1` |
| `shield.proof.bin` | `a41f5d172ea86f501356cb9b8eec1fb7e6a4259ab77be8889d53aed530e7804b` |
| `transfer.public.bin` | `cd394278eb8080b673cbebda03dacf1a0c17ea1425c979bbee783febd7deeb03` |
| `transfer.proof.bin` | `ad390b761fb56d3887e0722a3e6222420fb8c08d1df7ab63a92d6b73d79b985a` |
| `unshield.public.bin` | `f640477bcdbe2f7d308bcaa6e9d844df08c0149a7ebf1f91dd4e992096f8ea4d` |
| `unshield.proof.bin` | `9caf22b6a9cf9e3e99f35ec59150cac6153be2ce9cb729563adf1566e2bc80eb` |

**Scope of the vectors above.** They cover the cryptographic layer only. Their `binding` values
are hashes of arbitrary test bytes, not of a body of §3.2, and their anchors are roots of test
trees. The body encoding, the binding of a real body, note encryption, key derivation, the
shielded address and the state-root section of §4.8 are covered by the wallet vectors of §8.4
(W-8, O-15). The node-rule regression pair of §4.2 is not a file: it is the first test of the node
implementation (`shield_v2_daemon_tests`), built in the test process because the three vectors
above cannot serve (their bindings are not bindings of a body).

### 8.2 Primitives

Field elements are printed in canonical form.

| Input | Output (8 field elements unless stated) |
|---|---|
| Poseidon2 permutation of the state `[0, 1, …, 23]` (24 elements out) | `[723511737, 87131171, 587052829, 1323145575, 949917837, 2060493993, 234724110, 834906887, 306751607, 1771020267, 329216878, 823818173, 765507096, 1447982946, 605505945, 247386051, 1223069940, 354661286, 233493652, 2075130821, 1961191294, 313483662, 1701936810, 1815724394]` |
| `H(1; 1, 2, …, 8)` (`nk` of `sk = 1..8`) | `[595169165, 1319949558, 100343831, 1316207761, 1502406953, 2038333709, 911296729, 1702281373]` |
| `H(2; 1, …, 8)` (`pk` of the same `sk`) | `[503064717, 456360397, 379665597, 1823540223, 137459452, 1974170947, 1422064588, 141399043]` |
| `H(3; 1, …, 16)` (nullifier of `nk = 1..8`, `rho = 9..16`) | `[1038027522, 310679221, 579707435, 482677477, 306161169, 1695676278, 1953830546, 119319773]` |
| `H(5; 1, …, 16)` (Merkle node of `left = 1..8`, `right = 9..16`) | `[657568912, 152267029, 1520450300, 822796350, 745411925, 19510099, 1479479508, 1103660458]` |
| `H(4; 1, …, 28)` (two-block sponge) | `[1982285774, 1409472141, 2088989081, 123423727, 1020238694, 1437663514, 195750243, 1551669774]` |
| commitment of `value = 0x0123456789abcdef`, `pk = 1..8`, `rho = 9..16`, `r = 21..28` (limbs 52719, 35243, 17767, 291) | `[350137339, 1849492580, 947277798, 542868595, 1789965415, 1250062654, 1254300323, 1955880556]` |
| `H_rho(nf1 = 1..8, nf2 = 9..16, 0)` = `H(6, 0; 1, …, 16)` (rho of output 1) | `[1603212827, 2094382249, 1056528495, 59986379, 1078967191, 1191687171, 650718498, 867289535]` |
| `H_rho(nf1 = 1..8, nf2 = 9..16, 1)` = `H(6, 1; 1, …, 16)` (rho of output 2) | `[1732965259, 671099154, 2092728354, 163104313, 640848453, 255301622, 1193769835, 1714681889]` |
| output commitment of `value = 0x0123456789abcdef`, `pk = 1..8`, `rho = H_rho(1..8, 9..16, 0)`, `r = 21..28` | `[527674917, 602702121, 326390822, 1575311313, 1394427594, 1823693299, 866678550, 2070370043]` |
| `binding_from_bytes("")` | `[1049694149, 1036567868, 77557340, 245308734, 1726537877, 353180042, 580128092, 1381772360]` |
| `binding_from_bytes("abc")` | `[1198618829, 931526174, 1956969216, 28667118, 22116650, 722833852, 568669320, 419013842]` |
| empty subtree, level 1 (`H(5; 0^16)`) | `[256768056, 1346670833, 169516431, 761082886, 23516395, 1696849271, 1264406107, 218204685]` |
| empty subtree, level 2 | `[1869782978, 1256714202, 1898727018, 1050234623, 586286605, 618690765, 1398433549, 512807105]` |
| empty tree root, level 32 | `[337192190, 2091044999, 403604861, 1802413220, 880295642, 444711869, 850406734, 1912470196]` |

All 33 empty-subtree values are in `vectors.json`.

### 8.3 Transactions

Parameter set of §2.9. The blinding seed is fixed so that the proof bytes are reproducible; a
wallet MUST never do this (§5.6). Expected result of `verify_spend`: **accept**; with `fee + 1`:
**refuse**; with any single bit of the 216 public bytes flipped: **refuse**; with `nf2 := nf1`:
**refuse**; with the proof's last varint re-encoded non-minimally: **refuse**. For every output
j, `rho'_j = H_rho(nf1, nf2, j − 1)` and `cm_out_j` is the commitment with that `rho`.

**shield** — inputs enabled: False, False; input values 0, 0; output values 249999001, 0.

| Field | Value |
|---|---|
| `anchor` | `[1587948379, 1664409200, 1324518916, 2068962620, 126229749, 1400112274, 1519445250, 1099760258]` |
| `nf1` | `[590251664, 1438780733, 1599797257, 1941082409, 1794341511, 104618980, 1366508066, 2002199351]` |
| `nf2` | `[1596592775, 1490526262, 304851891, 705213899, 483203567, 182465859, 1985318395, 2008775219]` |
| `cm_out1` | `[1486977469, 45635388, 875377179, 2056672827, 1771417498, 982911299, 1788251707, 1244420242]` |
| `cm_out2` | `[205657299, 1118923707, 1579005092, 1354133732, 2026395158, 1665549041, 260099149, 1746424264]` |
| `v_in` | 250000001 |
| `v_out` | 0 |
| `fee` | 1000 |
| `binding` | `[499117066, 1558565360, 1242723330, 1967676226, 2010499051, 520146775, 706823265, 1054927545]` |
| `rho'_1 = H_rho(nf1, nf2, 0)` (derived, not a public input) | `[786937180, 236387781, 755228862, 1027876635, 223730362, 1242582519, 1150062156, 259927853]` |
| `rho'_2 = H_rho(nf1, nf2, 1)` (derived, not a public input) | `[1685200055, 171446319, 20793731, 1300144843, 1020908761, 1096909000, 309124646, 1869995305]` |
| public bytes (216, hex) | `5b2ba65e70de3463048ef24e3cdd517bf51c86079204745302e5905a82028d4190862e233d0dc25509f85a5f2991b273877af36ae45b3c06224273513723577787122a5f36a0d758b3ab2b12cbb5082aef19cd1c4335e00afb8d5576337abb77bd79a1583c57b8021b322d343b56967a9aaf95694309963a3b8e966a92582c4ad314420cbb6bb142a4b41d5ee470b6501656c878f14246634dcc800fc851186881b2e60e000000000000000000000000e8030000000000000aecbf1df0d1e55c0274124a425b4875ebc7d57757cf001f6144212ab9eae03e` |
| blinding seed (hex) | `1111111111111111111111111111111111111111111111111111111111111111` |
| proof | `vectors/shield.proof.bin`, 187307 bytes, Blake3 `b2a57bdd078ba6f90ccdda7db0ec5bfa65447077b792e02fa70387f59eebacdb` |
| `verify_spend` | accept (with `fee + 1`: reject) |

**transfer** — inputs enabled: True, True; input values 77309422755, 17179830904; output values 77309422832, 17179829827.

| Field | Value |
|---|---|
| `anchor` | `[1548194659, 2051136615, 1719832383, 393246519, 1828268592, 636012725, 1967991513, 678650434]` |
| `nf1` | `[438835520, 1832573465, 565981876, 559195145, 955430039, 1125703896, 1341115894, 1878256356]` |
| `nf2` | `[1060837439, 1256041781, 1511396493, 1948820496, 1078249242, 2019090851, 330307011, 2094344921]` |
| `cm_out1` | `[113432694, 917753959, 1504505639, 1051923251, 1005258550, 866195727, 1956021336, 1732770759]` |
| `cm_out2` | `[407974870, 1931071215, 15182526, 1824785346, 2054239248, 1678582604, 2004679854, 1627714940]` |
| `v_in` | 0 |
| `v_out` | 0 |
| `fee` | 1000 |
| `binding` | `[1377517717, 1638047372, 406884712, 2026865656, 1641976469, 105264568, 2105176754, 1913631939]` |
| `rho'_1 = H_rho(nf1, nf2, 0)` (derived, not a public input) | `[1453476457, 868505023, 1380585715, 1747519423, 1418836779, 465706983, 1974168274, 310465871]` |
| `rho'_2 = H_rho(nf1, nf2, 1)` (derived, not a public input) | `[532135592, 1850192960, 869550211, 1567492665, 1029427171, 2025188845, 2108352992, 2053010392]` |
| public bytes (216, hex) | `6393475c67dc417a3f8f826637777017302af96cb5c8e825d92a4d75426273284019281a19da3a6db432bc2109a4542197b4f238d8e01843f6cdef4fe4eaf36f3f183b3f35addd4a8d14165a10a428741ac74440a3e15878c315b013d92ad57c76d8c20667d0b33627efac593313b33e3607eb3b0f19a13358849674c7fb4767d6335118efce1973beaae700c203c46c1034717a4c230d64aefc7c777cf5046100000000000000000000000000000000e80300000000000095401b528c9ea26168914018f883cf789592de61b8354606b2727a7dc3b40f72` |
| blinding seed (hex) | `2222222222222222222222222222222222222222222222222222222222222222` |
| proof | `vectors/transfer.proof.bin`, 186347 bytes, Blake3 `5827dba9acd127ce32a4bf5fc54eb4eebd97351131ac0246cd681fad2040b6bd` |
| `verify_spend` | accept (with `fee + 1`: reject) |

**unshield** — inputs enabled: True, False; input values 77309426575, 0; output values 77059425572, 0.

| Field | Value |
|---|---|
| `anchor` | `[624269772, 1166226467, 1155160018, 1987384441, 836405504, 152578518, 1276950723, 42586783]` |
| `nf1` | `[515715850, 2108254734, 1381371376, 631265290, 108117807, 2057478728, 2035987071, 1452551980]` |
| `nf2` | `[1749431360, 249385996, 538133571, 1536650727, 145459623, 1946039646, 2068905809, 2079735876]` |
| `cm_out1` | `[577020724, 130143548, 1753897842, 8612811, 267574582, 876970029, 1513974377, 29795507]` |
| `cm_out2` | `[1652492447, 1215014783, 151170959, 1418405668, 1124281340, 1264910509, 1502132215, 717919874]` |
| `v_in` | 0 |
| `v_out` | 250000003 |
| `fee` | 1000 |
| `binding` | `[1081236164, 824873748, 1429031949, 2112798796, 1691926001, 2038463317, 389592491, 518003254]` |
| `rho'_1 = H_rho(nf1, nf2, 0)` (derived, not a public input) | `[1038627325, 666513310, 1626812798, 1462448810, 2126095600, 253186825, 1713630856, 325481184]` |
| `rho'_2 = H_rho(nf1, nf2, 1)` (derived, not a public input) | `[1339542974, 1897906994, 1225734200, 1247020792, 1563767533, 358270254, 1348257986, 1851996356]` |
| public bytes (216, hex) | `cc99352523348345d257da44791475760089da31d6291809c3b81c4c9fd289020a33bd1e0e6aa97df00d56520a58a0252fbf710648a2a27a7fb25a792c2f9456403446680c54dd0e43441320e76d975ba789ab085e35fe7351ff507b4440f67b34a364223cd5c107725b8a68cb6b830036ddf20f2d804534696a3d5ab3a4c6019f087f627fa76b488faf020924278b54fc2b0343ad00654bf7b788598296ca2a000000000000000083b2e60e00000000e803000000000000c45a724014932a310d4c2d554cc0ee7df1bdd864557b8079abb53817361ae01e` |
| blinding seed (hex) | `3333333333333333333333333333333333333333333333333333333333333333` |
| proof | `vectors/unshield.proof.bin`, 185291 bytes, Blake3 `7d9967cbe7fd248bbf98d364d47fe46002158a83809f64cae1b4a32622ee701c` |
| `verify_spend` | accept (with `fee + 1`: reject) |

Private values of each vector (keys, the inputs' `rho`, `r`, paths, `nk`, `pk`, input commitments,
the root each input's path leads to, the outputs' `pk`, derived `rho` and `r`) are in
`vectors.json`. For the shield vector both inputs are dummies with all-zero paths, so their path
root is not the anchor.

### 8.4 Wallet vectors (W-8; closes O-15)

**Normative** for §3.2 (body), §2.8 (binding of a body), §3.4 (encrypted notes), §5.2 (key
derivation), §5.3 (shielded address) and §4.8 (state-root section). Files, in
`core/shield-v2/vectors/wallet/`:

| File | Content | SHA-256 |
|---|---|---|
| `keys.json` | two wallets from fixed BIP-39 recovery phrases (no passphrase): the 64-byte seed, both HKDF outputs, `sk` (bytes and the 8 reduced elements), `nk`, `pk`, the ML-KEM-768 seeds `d`, `z`, the encapsulation and decapsulation keys, the SHA-256 of the address bytes `pk ‖ ek`, the address fingerprint, and the textual address of §5.3 with its version byte, the tag and value of `check` and the SHA-256 of the 1,225 encoded bytes (regenerated for W-9; the key material is unchanged) | `36487f52bcf42ff62e335955558f0bd7ffc39c8bc8580ff4744abb6d4059672b` |
| `note_encryption.json` | one encrypted note to wallet-1 with the ML-KEM encapsulation randomness `m` fixed: `kem_ct`, the shared secret, the AES key, the plaintext, `note_ct`. The commitment is the one of §8.2 | `bac08d6170fa294780e25ad5fa59b724df6c123d756dee643eed1755278077bc` |
| `transactions.json` | one `shield_v2`, one `shielded_transfer_v2`, one `unshield_v2` on chain id `rougechain-devnet-1`, chained (the transfer spends the shield's note, the unshield spends the transfer's change): every body field, the full witness, the 2,546 body bytes, the binding, the 216 public-input bytes, and which wallet can read which output | `39ea4d3949e84b8ab3971a2ea1546ec092aa81d0670defff9a61f04b828c7246` |
| `state_root.json` | the pool state and the §4.8 section `root_after` at activation and after each of the three transactions, applied one per block from activation height 3 | `62a6a4ffd6599eea1832608e29dfd6c6c499c5b1bc756c8fb06564597dce997e` |

Rules for an implementation checked against them:

* **Keys.** From `bip39_seed` it MUST reproduce `sk_okm`, `sk`, `nk`, `pk`, `view_okm`, the two
  ML-KEM keys, `address_check` and the address string; it MUST decode the address string back to
  `pk ‖ ek`, and MUST refuse the bech32m encoding of the bare 1,216 bytes (the withdrawn first
  form) and the same string with any byte of its payload changed and the bech32m checksum
  recomputed.
* **Note encryption.** With the stated `m` as the randomness of `ML-KEM-768.Encaps` it MUST
  reproduce `kem_ct`, `shared_secret`, `aes_256_gcm_key` and `note_ct`; decapsulating with
  wallet-1's key MUST return the plaintext, and wallet-2's key MUST fail the tag.
* **Transactions.** From the listed fields and the ciphertexts inside the body it MUST reproduce
  `body`; from `body`, `binding` and `public_inputs`; from the witness, both nullifiers and both
  output commitments (with `rho` derived from the nullifiers). A node's body parser MUST accept
  each body for its `tx_type`, its `height` and this chain id, and MUST refuse it for another
  chain id, another type, or a height above `expiry_height`. Each output named under
  `readable_by` MUST decrypt for that wallet and pass the recipient check of §2.4.1; no other
  output may decrypt for either wallet.
* **State root.** Applying the three transactions through the rules of §4, one per block from
  height 3, MUST give each listed state and, with the listed `root_before`, each `root_after`.
* **No proof is part of these vectors.** A proof's blinding is drawn inside the prover (§5.6) and
  is not reproducible; the proofs of §8.3 remain the proof vectors. The values a wallet draws at
  random — dummy secrets, `r`, the keys of zero-value outputs, encapsulation randomness, the slot
  order — are fixed here by a test-only deterministic source that no wallet build contains, and
  are given through the witness and the ciphertexts.
* The `from_pub_key` of the shield vector is 1,952 arbitrary bytes, not a valid ML-DSA-65 key;
  only its SHA-256 enters the body. Account signatures are not part of these vectors.

Checkers: `core/shield-v2-wallet/tests/vectors.rs` (regenerates every value and compares; the
HKDF outputs are recomputed there independently of the wallet code) and the node's
`node::shield_v2_wallet_interop_tests::committed_wallet_vectors_agree_with_the_node_parser_and_the_state_root_section`
(the node's body parser, binding, listing and persistent pool store on the same files).

---

## 9. Open issues

### 9.1 Undecided or contradictory in the inputs

Each item is followed by a recommendation. None of them is decided by this document.

*Draft against code.* `SPEC_DRAFT.md` §§1–11 was compared with `research/shield3/src` by reading
(sponge, tags, lengths, limb and byte encodings, binding, transcript seed, verifier order,
parameter set, trace layout). No difference was found other than the statements corrected in §7.
The comparison was by reading; no code was built or run for this document.

**O-1 — The AIR constraints, the transcript and the proof byte format are defined by reference to
pinned source, not written out.** §2.9, §2.9.1 and §2.10 fix them through one library commit, one
serialiser version and one source tree. A second, independent verifier cannot be written from
this document alone, and canonical encoding is enforced by re-encoding, not by a strict decoder.
*Recommendation:* accept for version 1, with exactly one verifier implementation built from the
pinned sources in every node; write the format and the constraints out field by field, with a
strict decoder and explicit maximum lengths, before any second implementation is attempted, and
make it part of the audit.

**O-2 — Unaudited foundations.** The hiding mode of the proof library, the Poseidon2 round numbers
and constants, the security calculator behind the "128 bits" (which has zero margin and counts 16
bits of grinding), and the claim that no consistent trace exists for a false statement have been
read or tested, not audited or proven. *Recommendation:* no parameter change now; the external
audit MUST cover all four, the hiding mode first; keep the cap until it has.

**O-3 — Design document is behind.** Draft 4 of the design still carries the statements corrected
in §7 (C-5 … C-8) and decision 6's re-prove wording (C-1). *Recommendation:* issue a draft 5 that
points to this specification for every encoding and removes the superseded sentences.

**O-4 — Fee on a shield.** The design says the public account pays; the research constructor pays
the fee out of `v_in`; the draft left it open. §3.5 specifies: the account is debited `v_in`, of
which `fee` is the fee, and the envelope fee is zero. *Recommendation:* confirm §3.5 — it keeps
every V2 amount an integer, gives all three types one fee field, and matches the shield test
vector.

**O-5 — Envelope and exemptions for transactions without a sender.** The design requires "a
defined exemption for this type and no other" but does not define the carrier. §3.1 specifies
empty sender, empty signature, nonce 0 inside the existing transaction structure.
*Recommendation:* confirm §3.1, and review every place in the node that assumes a non-empty sender
(signature check, nonce store, address index, mempool ordering by the floating-point fee,
receipts, explorer) as part of the node work.

**O-6 — Minimum fee.** The design asks for "a fee that reflects size and verification cost" and
gives no number, and the chain's existing fee handling assumes a paying account. Without a
consensus minimum, transactions without a sender have no spam cost.
*Recommendation:* a fixed consensus constant `SHIELD_V2_MIN_FEE_QUANTA = 1,000,000,000` (1 XRGE,
ten times the base transfer fee, for a transaction that stores about 200 KB for ever), revisited
with testnet data.

**O-7 — Per-block limit.** The design requires a cap; no input gives the number.
*Recommendation:* `SHIELD_V2_MAX_TX_PER_BLOCK = 8` as in §4.7, re-measured on a quiet validator
host before mainnet. The figures in §4.7 come from a loaded host and were not re-measured by the
reviewers.

**O-8 — Anchor window.** 128 blocks is marked as an estimate in the design. *Recommendation:* keep
128; confirm against the real block interval that it gives a wallet enough time to prove (about 3
to 7 seconds measured) and submit.

**O-9 — Key derivation.** The design gives labels but not the construction; the circuit works on
8 field elements; some wallets may have been created from a raw key without a recovery phrase.
*Recommendation:* confirm §5.2 for wallets with a phrase; decide separately whether a wallet
without a phrase gets no shielded address or derives it from its account secret key, and do not
ship the second without review.

**O-10 — Note encryption details and the sender's copy.** The design names the primitives
(ML-KEM-768, AES-256-GCM) but not the key derivation, nonce or associated data, and it says both
that the sender "also encrypts a copy to their own viewing key" and that a transaction carries two
ciphertexts. §3.4 specifies two ciphertexts and no sender's copy; a restored wallet then recovers
all its funds but not the history of what it sent (§5.4). *Recommendation:* confirm §3.4 for
version 1 and keep outgoing history in the wallet's local store; if on-chain outgoing history is
wanted, add one sender ciphertext per transaction as body version 2 before testnet, not after.

**O-11 — Shielded address encoding.** No prefix or textual form is defined, and a 1,216-byte
payload is far beyond the length bech32m's checksum was designed for. *Recommendation:* bech32m
with prefix `rshield` for now, QR codes and copy-paste as the only transport, and a wallet-side
integrity check on import; decide before wallets ship. Not consensus. *Status 2026-10-06 (W-4):*
implemented as recommended and fixed provisionally in §5.3, with the address fingerprint as the
wallet-side check; still to be confirmed by the owner. *Status 2026-10-06 (W-9):* the review of
the wallet core showed that the bech32m checksum alone accepts two changed characters 1,023
places apart at this length; the textual form now carries a version byte and an 8-byte
domain-tagged SHA-256 integrity value that the decoder MUST verify, and the first form is
withdrawn (it was never used on any network). Still provisional; still to be confirmed by the
owner (a shorter address — for example a hash of `ek` resolved through a directory — remains the
open design question).

**O-12 — Form of the nullifier-set commitment.** The design says "as a digest" and no more. §4.8
uses a running hash in insertion order, which costs two hashes per transaction; the alternative in
the style of the balance root, a hash over the whole sorted set in every block, grows without
bound because the set is never pruned. *Recommendation:* confirm the running hash; note that a
node which obtains state from a snapshot must then receive the nullifiers in insertion order to
check them against the commitment.

**O-13 — Research names in frozen constants.** The binding context string ends in `research-0` and
the transcript starts with `"SHIELD-3"`. Both are harmless labels, and both are kept because
changing either invalidates test vectors (the first: two primitive vectors; the second: every
proof). *Recommendation:* keep both; if they are to be renamed, do it once, before testnet, and
regenerate every vector.

**O-14 — The prover still takes a caller-supplied seed.** §5.6 forbids it; the research function
`prove_spend(trace, public, seed)` and the WebAssembly exports do not comply, and two exports can
panic. *Recommendation:* before any wallet integration, wrap or change the prover so that the seed
is drawn inside it, add the hedging of §5.6 item 4, remove the panics, and have the change
reviewed — it touches the only entropy of the proof's privacy. *Status 2026-10-06 (W-1, W-7):*
implemented — `prove_spend(witness, public)` behind the `prover` feature, seed drawn inside,
hedged, no panic on caller data, length cap and self-verification; the seeded function survives
only in the test configuration. **The review this item asks for has not happened yet**, and the
research WebAssembly exports are not used by the new package (`core/shield-v2-wasm`).

**O-15 — Missing test vectors and tests.** See §8.1. *Recommendation:* generate vectors for the
body, binding, note encryption, key derivation and the state-root section from the first node and
wallet implementations, cross-check them between the two, and add them here; make the regression
pair of §4.2 the first node test. *Status 2026-10-06 (W-8):* done — §8.4; the regression pair
is the node's first V2 test.

### 9.2 Values fixed by this document without an input fixing them **[P]**

To be confirmed or changed by the owner before the first testnet activation.

| Value | Where | Chosen |
|---|---|---|
| Payload field names | §3.1 | `shield_v2_body`, `shield_v2_proof`; lowercase hexadecimal |
| Envelope of signer-less types | §3.1 | empty `from_pub_key` and `sig`, `nonce` 0, envelope `fee` 0.0 |
| Body layout outside the public inputs | §3.2 | version byte, kind byte, SHA-256 of the chain id, expiry height, `account`, two ciphertext pairs; 2,546 bytes |
| Shield fee model | §3.5 | fee inside `v_in` (O-4) |
| Note encryption parameters | §3.4 | HKDF-SHA256 with info `rouge-shield/v2/note`, zero nonce, `aad = cm_out_j`, plaintext `value ‖ r` (O-10) |
| Key derivation construction | §5.2 | HKDF-SHA256 over the BIP-39 seed, 64-bit words reduced mod p (O-9) |
| `SHIELD_V2_MIN_FEE_QUANTA` | §3.5 | 1,000,000,000 (O-6) |
| `SHIELD_V2_MAX_TX_PER_BLOCK` | §4.7 | 8 (O-7) |
| `SHIELD_V2_ANCHOR_WINDOW` | §4.3 | 128, the design's estimate (O-8) |
| `SHIELD_V2_POOL_CAP_QUANTA` on testnet | §4.4 | the same 10^15 as mainnet; the owner's decision names mainnet only |
| State-root tag and layout | §4.8 | `rougechain.stateroot.shield_v2.v1`, running nullifier hash (O-12) |
| Shielded address text | §5.3 | bech32m, prefix `rshield`, no length limit, of `0x02 ‖ pk ‖ ek ‖ check`: 1,974 characters; `check` = first 8 bytes of SHA-256(`"rouge-shield/v2/address-check/v1"` ‖ `0x02` ‖ `pk` ‖ `ek`); fingerprint = first 8 bytes of SHA-256 of `pk ‖ ek` (O-11, W-4, W-9) |
| Wallet defaults (not consensus) | §5.4, §5.5 | state-check quorum = a strict majority of the CONFIGURED nodes, at least 2; `expiry_height` = confirmed height + 64, at most + 128; **embargo after a restore = 128 blocks above a base at most 256 blocks above the quorum's tip** (W-19); the client loop's B = 64 blocks per page, K = 3 rounds, W = 5 rounds (W-20); fee ceiling 10 × the minimum fee; minimum stored note value = the minimum fee; cap of 65,536 unspent notes from others, at most 4,096 spent notes kept (W-10, W-11, W-14 … W-20) |
| Node-local ciphertext hash (not consensus) | §5.4 | tag `rougechain.shield_v2.ciphertext_acc.node_local.v1`; SHA-256 over `acc ‖ cm_out ‖ kem_ct ‖ note_ct` per output in tree order, from 32 zero bytes; reported as `report.ciphertext_acc`; outside §4.8 (W-16) |
