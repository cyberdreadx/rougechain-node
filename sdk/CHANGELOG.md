# Changelog

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
