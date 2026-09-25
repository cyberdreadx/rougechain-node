# RougeBridge Contract

The `RougeBridge.sol` contract is a multi-asset bridge contract deployed on Base mainnet (`0x0c09C764AdC024497729cd452ECfeE8869d35d83`) that handles ETH and ERC-20 deposits/releases with enhanced security features.

## Features

- **Multi-token support** — ETH and any ERC-20 token (USDC, etc.)
- **Pausable** — Guardian can pause all operations in emergencies
- **Timelock** — Large withdrawals require a delay period before execution
- **Guardian role** — Separate from owner; can pause but cannot withdraw
- **Replay protection** — Processed L1 transaction IDs are tracked to prevent double-releases
- **Owner = multisig** — Deploy with a Gnosis Safe as owner for production

## Key Functions

### Deposits

```solidity
function depositETH(string calldata rougechainPubkey) external payable;
function depositERC20(address token, uint256 amount, string calldata rougechainPubkey) external;
```

Users call these to lock assets in the contract. Events are emitted for the relayer to pick up.

### Releases (Owner Only)

```solidity
function releaseETH(address to, uint256 amount, bytes32 l1TxId) external;
function releaseERC20(address token, address to, uint256 amount, bytes32 l1TxId) external;
```

The relayer (owner) calls these to release assets when a user burns their wrapped tokens on L1. If the amount exceeds `largeWithdrawalThreshold`, a timelock is queued instead.

### Timelock

```solidity
function executeTimelock(uint256 requestId) external;  // Owner, after delay
function cancelTimelock(uint256 requestId) external;    // Guardian
```

Large releases are queued with a configurable delay (default 24 hours). The guardian can cancel suspicious requests during the delay window.

### Admin

```solidity
function pause() external;                              // Guardian or Owner
function unpause() external;                             // Owner only
function setGuardian(address newGuardian) external;      // Owner
function setSupportedToken(address token, bool) external;// Owner
function setLargeWithdrawalThreshold(uint256) external;  // Owner
```

## Events

| Event | Description |
|-------|-------------|
| `BridgeDepositETH` | ETH deposited for bridging |
| `BridgeDepositERC20` | ERC-20 deposited for bridging |
| `BridgeReleaseETH` | ETH released to user |
| `BridgeReleaseERC20` | ERC-20 released to user |
| `TimelockQueued` | Large release queued with delay |
| `TimelockExecuted` | Queued release executed |
| `TimelockCancelled` | Queued release cancelled by guardian |

## Deployment

The XRGE bridge is live on **Base mainnet** (chain ID 8453) as `BridgeVaultV2` at `0x7BB10752E99e8872d7D2DE5D92bfd43cd935Cd2D`. Its owner is a **Gnosis Safe multisig (2-of-3)** — no single key can move or drain the vault. Routine releases are signed by a *separate* hot relayer key that may only call `release()` within on-chain per-transaction and rolling daily caps and only while unpaused; the multisig alone can rotate that key, change the caps, pause, or (behind a 48-hour timelock) emergency-withdraw. The ETH/USDC custody contract is at `0x0c09C764AdC024497729cd452ECfeE8869d35d83`. Base Sepolia (chain ID 84532) is used for testing.

> **Migration note:** the previous single-owner XRGE vault (`0xb3f5…bFAb5`) is being retired in favor of `BridgeVaultV2`; do not deposit to the old address.

## Daemon Withdraw Guardrails

Independent of the on-chain contract, the RougeChain daemon enforces its own withdraw
guardrails via environment variables:

- `QV_BRIDGE_WITHDRAW_PAUSED` — emergency kill-switch; blocks all withdrawals when `true`
- `QV_BRIDGE_MAX_WITHDRAW_UNITS` — per-transaction withdrawal cap (0/unset = no cap)
- `QV_BRIDGE_MIN_CONFIRMATIONS` — required Base confirmation depth for deposit claims (default 6)
