# Changelog

## 1.12.0

Client side of the node's TOKEN_MINTING upgrade (mintable custom tokens, creator-only capped minting). The upgrade is built into the node but **not scheduled on any network yet**; until it activates the node refuses the new fields and `mint_tokens` with "token minting is not active yet".

### Fixed
- `rc.mintTokens` now posts a properly **signed** `mint_tokens` transaction (`{ type: "mint_tokens", token_symbol, amount, fee, from, timestamp, nonce }`) to `POST /api/v2/token/mint`. Up to 1.11.0 it posted an unsigned `{ symbol, amount, signature: "" }` body, which the node always rejected.
- `rc.createToken` now sends `CreateTokenParams.mintable` / `maxSupply`. They were declared but silently dropped. They are signed as `mintable: true` and `max_supply` only when `mintable` is true, so a fixed-supply token's payload is unchanged.

### Added
- `createSignedTokenMint(wallet, symbol, amount, fee = 1, accountNonce?)`. The symbol is trimmed and upper-cased. `amount` must be a positive integer of at most 2^53 - 1.
- `createSignedTokenCreation(..., image?, options?)`: a new 7th argument `{ mintable?, maxSupply?, description? }`. It is also exported from the package index now.
- `tokenMintFields(initialSupply, { mintable, maxSupply })` validates the mint options the way the node does and returns the exact fields to sign. A cap without `mintable`, a cap below the initial supply, non-integers and values above 2^53 - 1 all throw. `rc.createToken` / `rc.mintTokens` return `{ success: false, error }` for invalid input without posting anything.
- `rc.isTokenMintingActive()` and the pure `tokenMintingActive(stats)` read `/api/stats` `upgrade_schedule.token_minting` (`null` = not scheduled) and the current `network_height`.
- `CreateTokenParams.description`, `MintTokenParams.accountNonce`.
- Constants `TOKEN_MINT_MAX_AMOUNT`, `TOKEN_MINT_FEE_XRGE` (1) and `TOKEN_CREATE_FEE_XRGE` (100).
- Types: `UpgradeSchedule`, `NodeStats.upgrade_schedule`, the `"mint_tokens"` `TransactionType`, and `TokenMetadata` mint fields (`mintable`, `max_supply`, `total_minted`, `initial_supply`, `mint_enabled_height`, plus `decimals` and `frozen`).

## 1.11.0

### Fixed
- `rc.nft.batchMint` / `createSignedNftBatchMint` now sign per-NFT attributes as the payload's `attributes` field, the one the node reads. Up to 1.10.0 they were sent as `batchAttributes`, which the node ignores, so batch-minted NFTs got no attributes.
- `createSignedTokenCreation` (and `rc.createToken` without `fee`) now defaults to a fee of **100** XRGE, the fixed fee the node charges for `create_token`. It defaulted to 10 (the signed value is informational; the node always charged 100).

### Added
- `BatchMintNftParams.attributes` (and the `attributes` option of `createSignedNftBatchMint`). `batchAttributes` still works as a deprecated alias.

## 1.10.0

### Added
- Payable contract calls (node payable-calls upgrade, from block 190). A signed `contract_call` can pay the contract.
  - `rc.contracts.execute(wallet, addr, method, args, { gasLimit?, attach?: { symbol, amount } })`. `amount` is an integer: quanta for XRGE (1 XRGE = 1,000,000,000 quanta), raw units for tokens. It accepts a `bigint`, a safe-integer `number` or a digit string. The SDK signs it inside the payload as `"attach": {"symbol": "XRGE", "amount": <JSON integer>}`. The payment moves to the contract only if the call succeeds. A failing or trapping call keeps it with the caller, and the gas fee is still charged. The node refuses the call if the wallet can't cover the gas fee plus an XRGE payment, or the token amount.
  - Gas auto-sizing (no `gasLimit`) now runs the preview query with the attachment, so the contract sees the payment in the dry run.
  - `rc.contracts.query(addr, method, args, caller?, { attach? })` previews a paid call. A `caller` is required when attaching.
  - `game(addr, wallet).call(method, args, { attach })` and `.query(method, args, { attach })`.
  - `createSignedContractCall(wallet, addr, method, args, gasLimit, accountNonce?, attach?)`.
  - `xrgeToQuanta(x)` converts a decimal string or number to `bigint` quanta exactly. It uses no float math and allows at most 9 decimals. `quantaToXrge(q)` returns an exact decimal string. The constant `QUANTA_PER_XRGE` is exported too.
  - `normalizeContractAttach(attach)` upper-cases the symbol. It throws a clear error if the amount is not an integer, is ≤ 0, or is above `Number.MAX_SAFE_INTEGER` (the node reads the amount as an exact u64 JSON number).
  - `ExecuteContractResult.attach` holds the attachment that was signed.
  - New types: `ContractAttach`, `NormalizedContractAttach`, `QueryContractOptions`.

## 1.9.0

### Added
- `rc.contracts`: WASM smart contracts with player-signed transactions (node GAME_READY, active on mainnet since block 150).
  - `publish(wallet, wasm, { nonce? })` signs a `contract_deploy` (`POST /api/v2/contract/publish`, 10 XRGE). Returns the node's `address` plus a locally computed `predictedAddress` and the signed `nonce`.
  - `execute(wallet, addr, method, args?, { gasLimit?, accountNonce? })` signs a `contract_call` (`POST /api/v2/contract/execute`, fee `gasLimit × 0.000001` XRGE). With no `gasLimit`, it queries first and signs `min(ceil(gasUsed × 1.5) + 1000, 10_000_000)`. Node refusals ("call would fail: …") come back as `{ success: false, error }`.
  - `query(addr, method, args?, caller?)`: a free read-only call (`POST /api/contract/:addr/query`).
  - `get`, `state(addr, key?)`, `events(addr, { limit, before, tx })`, `list`.
  - `subscribe(addr, cb, { onStatus })`: live `contract_event` frames over one shared WebSocket, with auto-reconnect and resubscribe. Returns an unsubscribe function.
  - `waitForReceipt(txId, { timeoutMs, intervalMs })` polls `GET /api/tx/:id/receipt` until the tx is included. A `contract_call` that reverted in its block is still included (fee charged) and reports `status: { Failed: "<error>" }`; a completed call reports `"Success"`.
  - `game(addr, wallet?)` returns a `{ call, query, state, on(topic | '*') }` handle for game code.
- `predictContractAddress(from, nonce, wasm)`: the node's `contract_address_v2` derivation, tested against vectors from the Rust code.
- Builders and helpers `createSignedContractCall`, `createSignedContractPublish`, `suggestGasLimit`, `contractCallFee`, `bytesToBase64`, `base64ToBytes`, constants `CONTRACT_MAX_GAS`, `CONTRACT_GAS_PRICE_XRGE`, `CONTRACT_DEPLOY_FEE_XRGE`.
- `RougeChainOptions.WebSocket`: a WebSocket constructor for runtimes without a global one.
- `SignedTransaction.payload_bytes_hex` (optional). Contract requests send the exact signed bytes.
- `npm test` (node:test) for the contracts namespace.

### Changed
- `ContractMetadata` and `ContractEvent` now match what the node actually returns (`code_hash`, `created_at`, `wasm_size`, `contract_addr`, `block_height`, `tx_hash`). The old camelCase fields never matched the wire format.

### Deprecated
- `rc.shielded.deployContract` / `callContract` / `getContract*` / `listContracts`. The node-signed deploy endpoint now returns 410, and `/v2/contract/call` is a dry run only. Use `rc.contracts`.

## 1.8.1

### Fixed
- `messenger.getConversations()` conversations now carry their members. The node returns them as `participant_ids`, but the `MessengerConversation` type declared `participants`, so apps reading `participants` got `undefined`. They showed every thread as a conversation with yourself and merged all threads into one. The SDK now fills in both `participant_ids` and `participants`.
- `MessengerConversation` type matches the node: adds `participant_ids`, `created_by`, `name`, `is_group`, `deleted_by`; `created_at` is an RFC 3339 string (was typed as a number); `last_message_preview` may be `null`.

## 1.8.0

### Added
- `messenger.subscribe(wallet, onMessage, { onStatus })`: real-time new-message events over the node WebSocket. The socket authenticates with a signed `messenger_ws_subscribe` request, so the node sends each wallet only its own events. Events carry routing data (conversation/message ids, sender + participant signing keys), never content. Reconnects and re-authenticates automatically.
- `messenger.realtimeAuth(wallet)`: the signed `{ auth }` frame, for apps that manage their own socket.
- `messenger.restoreConversation(wallet, conversationId)` and `messenger.restoreMessage(wallet, messageId, conversationId)`.
- `messenger.getConversations(wallet, { folder })`: `"inbox"` (default), `"trash"` or `"all"`.
- `messenger.deleteConversation(wallet, conversationId, { purge })`: delete is per participant and recoverable for 30 days unless `purge: true`.
- Types `MessengerFolder`, `MessengerNewMessageEvent`.

Pairs with node 9eea813 (private WebSocket events) and 59478e6 (recoverable delete).

## 1.7.0

### Added
- `social.getUserFollowers(pubkey, limit?, offset?)` — paginated followers list, mirroring `getUserFollowing`. Backed by the new `GET /api/social/user/:pubkey/followers` endpoint (default 50, max 200).

## 1.6.0

### Added
- `messenger.updateConversation(wallet, conversationId, { name })` — rename a group conversation (or clear its name).
- `messenger.addParticipants(wallet, conversationId, participantIds)` — add members to an existing conversation. Future messages encrypt to new members automatically; they do not receive prior history.
- `messenger.registerWallet(...)` now accepts an optional `avatarUrl` (base64 data URI) shared via the directory so peers can render a custom avatar. `MessengerWallet` gains the `avatarUrl` / `avatar_url` field.

These pair with daemon endpoints `POST /v2/messenger/conversations/update`, `POST /v2/messenger/conversations/participants`, and avatar persistence on `/v2/messenger/wallets/register`.

## 1.5.0

### Added
- `getValidatorStatus()` — one-shot validator health for a key.
