# Regenerate Community Votes API

Interim governance for the RougeChain Regenerate treasury. Proposals and votes are hosted by the node, outside consensus, until on-chain governance ships. Every vote is a wallet-signed request, stored with its signature so anyone can recount.

## Rules

Set per proposal when it opens, and never changed afterwards:

| Rule | Default | Node setting |
|---|---|---|
| Voting weight | XRGE balance when the proposal opened (snapshot) | — |
| Excluded wallets | Team, treasury and exchange wallets | `QV_REGEN_EXCLUDED`, `QV_REGEN_TREASURY` |
| Per-wallet cap | 5% of eligible supply | `QV_REGEN_CAP_BPS` |
| Turnout to pass | 10% of eligible supply (yes + no + abstain) | `QV_REGEN_TURNOUT_BPS` |
| Majority | More yes than no | — |
| Voting window | 7 days (1–30) | `QV_REGEN_DEFAULT_DAYS` |
| Opening a proposal | Curator, or 10,000 XRGE and one open proposal at a time | `QV_REGEN_CURATORS`, `QV_REGEN_MIN_CREATOR_XRGE` |

Balances acquired after a proposal opens carry no vote on it. A wallet can change its vote until the window closes; the latest vote counts.

## Read endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/regen/config` | Treasury, cap, turnout, default window, excluded wallets, curators |
| `GET /api/regen/proposals` | Every proposal, newest first, with tally and status |
| `GET /api/regen/proposals/:id` | One proposal with every vote, including `signedPayload` and `signature` |
| `GET /api/regen/proposals/:id/weight/:who` | A wallet's snapshot weight, eligibility and current vote (`:who` is a rouge1 address or public key) |

Status is one of `open`, `passed`, `failed`, `paid` or `cancelled`. Quanta amounts are decimal strings (1 XRGE = 10⁹ quanta); `summaryXrge` repeats the totals in XRGE.

## Signed endpoints

All use the standard [signed request format](messenger.md#signed-request-format) (`payload` with `from`, `timestamp`, `nonce`; ML-DSA-65 `signature`; `public_key`).

| Endpoint | Payload | Who |
|---|---|---|
| `POST /api/v2/regen/proposals` | `title`, `summary`, optional `territory`, `recipient` (rouge1), `requestedXrge`, `link` (https), `durationDays` | Curator or eligible holder |
| `POST /api/v2/regen/votes` | `proposalId`, `choice` (`yes`, `no`, `abstain`) | Any wallet with snapshot weight |
| `POST /api/v2/regen/proposals/payout` | `proposalId`, `txId` | Curator, for a passed proposal |
| `POST /api/v2/regen/proposals/cancel` | `proposalId`, optional `reason` | Curator, or the creator before any votes |

A payout is accepted only if `txId` is an on-chain XRGE transfer from the treasury, and to the proposal's recipient when one is set.

## Recounting

Fetch `GET /api/regen/proposals/:id`. For each vote, verify `signature` over the sorted-key JSON of `signedPayload` against `publicKey`, derive the rouge1 address from `publicKey`, and sum weights by choice. Weights come from the snapshot taken at `snapshotHeight`.
