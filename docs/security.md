# Security Overview

An honest summary of what is post-quantum-secured today and what is not. For live/pending status
see [Status & Roadmap](status.md). _Last reviewed: 2026-10-06._

## RougeChain L1 — post-quantum-secured

- Accounts, transactions, validator block signatures and staking operations use **ML-DSA-65**
  (FIPS 204). Messaging and mail use **ML-KEM-768** (FIPS 203).
- Transactions are signed client-side; private keys do not leave the wallet.
- In the web wallet, setting a password (min 8 characters) is **required** to finish creating or
  importing a wallet, and keys are written to browser storage only encrypted (AES-256-GCM). A wallet
  an older version stored unencrypted must be secured with a password before it can be used again.
  See [Create a Wallet](getting-started/create-wallet.md#key-storage).
- Messages and mail are encrypted to each participant's **long-term** ML-KEM-768 key. There is no
  forward secrecy: anyone who later obtains that key can decrypt the stored messages and mail it
  was used for, both received and sent.
- These algorithms are quantum-resistant under current cryptographic understanding. No system can
  promise more than that, and implementation bugs remain possible.
- **Shielded transfers are not available.** The V1 shielded pool is suspended since block 245: its
  STARK proof established value balance only, did not bind a withdrawal to a specific note, and its
  prover has no zero-knowledge mode, so it did not deliver privacy. The mainnet pool was empty. A
  redesigned pool (V2, Plonky3-based with a hiding mode, launching under a 1,000,000 XRGE cap) is in
  development and **unaudited**; nothing may claim audited privacy until an external audit covers it.
- **Messenger and mail are node-hosted, not on-chain.** Since node release 1.6.3 a directory entry can
  be replaced only by the signing key that owns it, an encryption key registered to another wallet is
  refused, and the unauthenticated legacy read routes return `410 Gone`. Nodes before 1.6.3 do not
  enforce this.

<a id="network-binding"></a>

## Signatures commit to the network

Mainnet (`rougechain-mainnet-1`) and testnet (`rougechain-devnet-1`) accept the same keys, and the
web wallet uses one key on both. From node release **1.6.4** and the wallet releases listed in the
[changelog](changelog.md), every payload a wallet signs for a node — transactions and signed requests
(mail, messenger, names, votes) — carries the chain id of the network it is meant for (`chainId`;
`chain_id` in a `rougechain` CLI envelope), inside the signed bytes. A signature therefore commits to
one network.

- **Node rule (release 1.6.4, no fork).** A node refuses a signed payload that names another chain id
  (`CHAIN_ID_MISMATCH`), at the API, at mempool admission and when producing. A payload that names no
  network is still accepted while wallets update; operators turn on
  [`REQUIRE_SIGNED_CHAIN_ID`](running-a-node/configuration.md) to refuse those too
  (`CHAIN_ID_REQUIRED`).
- **Wallets** take the chain id from their network setting, compare it once per session with the
  node's `GET /api/health` → `chain_id`, and refuse to sign if the two differ. The extension and
  Qwalla show the network a request is for and refuse one for a network other than the selected one.
- **Consensus rule (CHAIN_ID_BINDING, not scheduled).** From an activation height to be announced,
  a block is invalid if any transaction's signed bytes do not commit to the chain id; node-signed
  transactions switch to a network-bound signing format at the same height. Until then consensus is
  unchanged. See the [upgrade schedule](running-a-node/upgrade-schedule.md#chain-id-binding).
- **Sign-in messages** already carry a `Chain ID` line; verifiers must check it
  ([Wallet Authentication](advanced/wallet-authentication.md#what-a-verifier-must-check)).
- **Contracts** that verify signatures themselves can read the chain id with `host_get_chain_id` from
  the CONTRACT_CHAIN_ID upgrade (not scheduled) — see
  [Smart Contracts](advanced/smart-contracts.md#chain-id).

## Bridges — mixed

| Path | Today |
|---|---|
| RougeChain side of every bridge | ML-DSA-65-signed withdrawals |
| XRGE on Base (`BridgeVaultV2`) | **Classical** Base-side authorization (Safe multisig + capped relayer key). Hardened R1 architecture. |
| qETH / qUSDC on Base (`RougeBridge`) | **Classical** Base-side authorization: single operator owner/release key, with a 2-of-3 Safe multisig guardian that can pause the bridge and cancel queued large releases |
| Bitcoin (qBTC) | Separate bridge; Bitcoin custody uses Bitcoin's classical signatures |

So: assets held **on RougeChain** are protected by post-quantum signatures. The **Base-side
custody** of bridged assets is not post-quantum today. The bridges are operator-run (deposit
watcher, relayers and the `bridge_mint` key), the ETH/USDC contract is owned by a single hot key, and
**no bridge component has been externally audited**. ETH/USDC deposits go through the contract's
`depositETH` / `depositERC20` and are claimed automatically; the manual claim route is closed at the
public endpoint. Bitcoin deposits are live; Bitcoin withdrawals are switched off in the site.

## What V3 will change (not activated)

The [V3 XRGE bridge](bridge/v3-xrge-bridge.md) changes the **XRGE** authorization path on Base to
on-chain-verified ML-DSA-65 signatures from an M-of-N authority. It has been built, frozen as an
audit candidate and rehearsed, but is **not deployed or activated**, and it has not yet been
externally audited.

- **qETH and qUSDC remain outside the V3 post-quantum scope.**
- **The Bitcoin bridge is separate** from the Base bridge architecture and from V3.

## Finality

Verified BFT finality ([FINALITY_V2](staking/finality.md)) is **live since block 150**: every block
carries a certificate of ML-DSA-65 precommits from more than two thirds of stake for its parent, and
nodes reject blocks without one. Stake is still concentrated in few keys — three validators are
staked and one holds more than 99.9 % of the stake, so its own vote is the quorum — which limits what
any BFT guarantee means until the validator set broadens.

**No slashing is active.** Missed-block slashing is frozen since block 100, the legacy `slash`
transaction is rejected since block 245, and evidence-based slashing does not exist yet. The 10,000
XRGE minimum stake is enforced by the node API, not by consensus.

## Decentralization

Validator stake and bridge operation are currently concentrated in a small operator set. This is a
known limitation and part of the roadmap: a consensus redesign (rotating proposers, a capped validator
set, a consensus-enforced minimum stake, evidence-based slashing) was decided on 2026-10-06 and is
**not built**; see [Status & Roadmap](status.md#consensus-redesign--decided-2026-10-06-not-built).
