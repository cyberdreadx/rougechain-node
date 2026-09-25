# Changelog

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
