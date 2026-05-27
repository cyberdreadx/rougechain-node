// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BridgeVault
 * @notice Lock-and-unlock vault for bridging XRGE between Base and RougeChain L1.
 *
 *         Base → L1:  User calls deposit(amount, l1Pubkey).
 *                     Vault locks their XRGE and emits BridgeDeposit.
 *                     Off-chain relayer credits XRGE on the L1 side.
 *
 *         L1 → Base:  User burns XRGE on L1.
 *                     Relayer calls release(to, amount) to unlock tokens.
 */
contract BridgeVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable xrgeToken;

    /// @notice Total XRGE currently locked in the vault
    uint256 public totalLocked;

    /// @notice Tracks nonces to prevent duplicate deposits
    mapping(address => uint256) public depositNonce;

    /// @notice Tracks processed L1 tx IDs to prevent duplicate releases
    mapping(string => bool) public processedL1Txs;

    /// @notice Emergency withdrawal timelock
    uint256 public emergencyWithdrawRequestedAt;
    bool public emergencyWithdrawRequested;
    uint256 public constant EMERGENCY_TIMELOCK = 48 hours;

    // ── Events ──────────────────────────────────────────────────────

    /// @notice Emitted when a user locks XRGE to bridge to L1
    event BridgeDeposit(
        address indexed sender,
        uint256 amount,
        string  rougechainPubkey,
        uint256 nonce
    );

    /// @notice Emitted when the relayer releases XRGE back to a user (L1 → Base)
    event BridgeRelease(
        address indexed recipient,
        uint256 amount,
        string  l1TxId
    );

    /// @notice Emitted on emergency withdrawal
    event EmergencyWithdraw(address indexed token, uint256 amount);
    event EmergencyWithdrawRequested(uint256 executeAfter);
    event EmergencyWithdrawCancelled();

    // ── Errors ──────────────────────────────────────────────────────

    error ZeroAmount();
    error EmptyPubkey();
    error InsufficientVaultBalance();
    error AlreadyProcessed();

    // ── Constructor ─────────────────────────────────────────────────

    /**
     * @param _xrgeToken Address of the XRGE ERC-20 token on this chain
     */
    constructor(address _xrgeToken) Ownable(msg.sender) {
        xrgeToken = IERC20(_xrgeToken);
    }

    // ── User-facing ─────────────────────────────────────────────────

    /**
     * @notice Lock XRGE in the vault to bridge to RougeChain L1.
     *         Caller must first approve this contract to spend `amount`.
     * @param amount           Amount of XRGE to lock (18 decimals)
     * @param rougechainPubkey Recipient's RougeChain L1 public key (hex string)
     */
    function deposit(uint256 amount, string calldata rougechainPubkey) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (bytes(rougechainPubkey).length == 0) revert EmptyPubkey();

        uint256 nonce = depositNonce[msg.sender]++;
        totalLocked += amount;

        xrgeToken.safeTransferFrom(msg.sender, address(this), amount);

        emit BridgeDeposit(msg.sender, amount, rougechainPubkey, nonce);
    }

    // ── Relayer-only (owner) ────────────────────────────────────────

    /**
     * @notice Release locked XRGE to a user (called by relayer after L1 burn).
     * @param to     Recipient EVM address
     * @param amount Amount to release
     * @param l1TxId The L1 transaction ID that triggered this release
     */
    function release(address to, uint256 amount, string calldata l1TxId) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (processedL1Txs[l1TxId]) revert AlreadyProcessed();
        processedL1Txs[l1TxId] = true;

        uint256 balance = xrgeToken.balanceOf(address(this));
        if (balance < amount) revert InsufficientVaultBalance();

        if (totalLocked >= amount) {
            totalLocked -= amount;
        } else {
            totalLocked = 0;
        }
        xrgeToken.safeTransfer(to, amount);

        emit BridgeRelease(to, amount, l1TxId);
    }

    // ── Admin ───────────────────────────────────────────────────────

    /// @notice Request emergency token withdrawal (starts 48h timelock)
    function requestEmergencyWithdraw() external onlyOwner {
        emergencyWithdrawRequestedAt = block.timestamp;
        emergencyWithdrawRequested = true;
        emit EmergencyWithdrawRequested(block.timestamp + EMERGENCY_TIMELOCK);
    }

    /// @notice Execute emergency withdrawal after timelock
    function emergencyWithdraw(address token) external onlyOwner {
        require(emergencyWithdrawRequested, "No pending request");
        require(
            block.timestamp >= emergencyWithdrawRequestedAt + EMERGENCY_TIMELOCK,
            "Timelock not expired"
        );
        emergencyWithdrawRequested = false;
        IERC20 t = IERC20(token);
        uint256 bal = t.balanceOf(address(this));
        t.safeTransfer(owner(), bal);
        if (token == address(xrgeToken)) {
            totalLocked = 0;
        }
        emit EmergencyWithdraw(token, bal);
    }

    /// @notice Cancel a pending emergency withdrawal
    function cancelEmergencyWithdraw() external onlyOwner {
        emergencyWithdrawRequested = false;
        emit EmergencyWithdrawCancelled();
    }

    /**
     * @notice View: how much XRGE the vault actually holds on-chain.
     */
    function vaultBalance() external view returns (uint256) {
        return xrgeToken.balanceOf(address(this));
    }
}
