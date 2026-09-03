// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BridgeVaultV2
 * @notice Lock-and-unlock vault for bridging XRGE between Base and RougeChain L1,
 *         with the custody trust split into two roles so no single hot key can drain it.
 *
 *   Base → L1:  user deposit(amount, l1Pubkey) locks XRGE; the relayer credits L1.
 *   L1 → Base:  user burns XRGE on L1; the RELAYER calls release(to, amount, l1TxId).
 *
 *   TRUST MODEL (the point of V2):
 *     - owner  = an M-of-N multisig (Safe). COLD. The only authority that can rotate
 *                the relayer, change caps, pause, or drain the vault (drain is also
 *                48h-timelocked). No single signer can do any of these.
 *     - relayer = a HOT key that may ONLY call release(), and only within the on-chain
 *                 maxPerTx + rolling dailyLimit, and only while not paused.
 *
 *   A compromised relayer key therefore leaks at most `dailyLimit` before the multisig
 *   rotates or pauses it — bounded, not catastrophic. In V1 the single owner key both
 *   signed every release AND could drain everything; V2 removes that single point of loss.
 *
 *   The processedL1Txs(string) mapping is preserved so the off-chain refund guard /
 *   reconciliation (which reads it to prevent double-payouts) keeps working unchanged.
 */
contract BridgeVaultV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable xrgeToken;

    /// @notice Hot key allowed to call release() within the caps below. Rotated by the owner.
    address public relayer;

    // ── On-chain guardrails (enforced no matter what a compromised relayer or daemon does) ──

    /// @notice Max XRGE a single release() may pay out. 0 disables release() entirely (fail closed).
    uint256 public maxPerTx;
    /// @notice Max XRGE releasable per rolling 24h window. 0 = no daily cap.
    uint256 public dailyLimit;
    /// @notice Amount released in the current window.
    uint256 public releasedInWindow;
    /// @notice Start timestamp of the current 24h window.
    uint256 public windowStart;
    /// @notice When true, release() is blocked. Owner-controlled kill switch.
    bool public paused;

    /// @notice XRGE currently accounted as locked by deposits.
    uint256 public totalLocked;
    /// @notice Lifetime XRGE released back to Base.
    uint256 public totalReleased;
    /// @notice Per-depositor nonce for deposit events.
    mapping(address => uint256) public depositNonce;
    /// @notice Processed L1 tx ids — idempotency guard against duplicate releases.
    mapping(string => bool) public processedL1Txs;

    // ── Emergency withdrawal (owner-only, 48h timelock) ──
    uint256 public emergencyRequestedAt;
    bool public emergencyRequested;
    uint256 public constant EMERGENCY_TIMELOCK = 48 hours;

    // ── Events ──────────────────────────────────────────────────────
    event BridgeDeposit(address indexed sender, uint256 amount, string rougechainPubkey, uint256 nonce);
    event BridgeRelease(address indexed recipient, uint256 amount, string l1TxId);
    event RelayerChanged(address indexed previous, address indexed current);
    event CapsChanged(uint256 maxPerTx, uint256 dailyLimit);
    event PausedSet(bool paused);
    event EmergencyWithdrawRequested(uint256 executeAfter);
    event EmergencyWithdrawCancelled();
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    // ── Errors ──────────────────────────────────────────────────────
    error NotRelayer();
    error IsPaused();
    error ZeroAmount();
    error ZeroAddress();
    error EmptyPubkey();
    error AlreadyProcessed();
    error InsufficientVaultBalance();
    error ExceedsPerTxCap();
    error ExceedsDailyLimit();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    /**
     * @param _xrgeToken XRGE ERC-20 on this chain.
     * @param _owner     The M-of-N multisig (Safe) that will govern the vault.
     * @param _relayer   The hot key permitted to call release() within caps.
     * @param _maxPerTx  Initial per-tx cap (0 = release disabled until the owner sets it).
     * @param _dailyLimit Initial rolling 24h cap (0 = no daily cap).
     */
    constructor(
        address _xrgeToken,
        address _owner,
        address _relayer,
        uint256 _maxPerTx,
        uint256 _dailyLimit
    ) Ownable(_owner) {
        if (_xrgeToken == address(0) || _owner == address(0) || _relayer == address(0)) revert ZeroAddress();
        xrgeToken = IERC20(_xrgeToken);
        relayer = _relayer;
        maxPerTx = _maxPerTx;
        dailyLimit = _dailyLimit;
        windowStart = block.timestamp;
        emit RelayerChanged(address(0), _relayer);
        emit CapsChanged(_maxPerTx, _dailyLimit);
    }

    // ── User-facing (Base → L1) ─────────────────────────────────────

    /// @notice Lock XRGE to bridge to RougeChain L1. Caller must approve `amount` first.
    function deposit(uint256 amount, string calldata rougechainPubkey) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (bytes(rougechainPubkey).length == 0) revert EmptyPubkey();

        uint256 nonce = depositNonce[msg.sender]++;
        totalLocked += amount;
        xrgeToken.safeTransferFrom(msg.sender, address(this), amount);
        emit BridgeDeposit(msg.sender, amount, rougechainPubkey, nonce);
    }

    // ── Relayer-only (L1 → Base), hot but bounded ───────────────────

    /// @notice Release locked XRGE to a user after their L1 burn. Bounded by caps + pause.
    function release(address to, uint256 amount, string calldata l1TxId) external onlyRelayer nonReentrant {
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (maxPerTx == 0 || amount > maxPerTx) revert ExceedsPerTxCap();
        if (processedL1Txs[l1TxId]) revert AlreadyProcessed();

        // Rolling 24h window accounting.
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            releasedInWindow = 0;
        }
        if (dailyLimit != 0 && releasedInWindow + amount > dailyLimit) revert ExceedsDailyLimit();

        uint256 balance = xrgeToken.balanceOf(address(this));
        if (balance < amount) revert InsufficientVaultBalance();

        processedL1Txs[l1TxId] = true;
        releasedInWindow += amount;
        totalReleased += amount;
        if (totalLocked >= amount) {
            totalLocked -= amount;
        } else {
            totalLocked = 0;
        }
        xrgeToken.safeTransfer(to, amount);
        emit BridgeRelease(to, amount, l1TxId);
    }

    // ── Owner (multisig guardian) ───────────────────────────────────

    /// @notice Rotate the hot relayer key. Use this the instant a relayer key is suspect.
    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert ZeroAddress();
        emit RelayerChanged(relayer, newRelayer);
        relayer = newRelayer;
    }

    /// @notice Update the release guardrails.
    function setCaps(uint256 _maxPerTx, uint256 _dailyLimit) external onlyOwner {
        maxPerTx = _maxPerTx;
        dailyLimit = _dailyLimit;
        emit CapsChanged(_maxPerTx, _dailyLimit);
    }

    /// @notice Kill switch for releases.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Begin the 48h timelock before an emergency drain becomes executable.
    function requestEmergencyWithdraw() external onlyOwner {
        emergencyRequestedAt = block.timestamp;
        emergencyRequested = true;
        emit EmergencyWithdrawRequested(block.timestamp + EMERGENCY_TIMELOCK);
    }

    /// @notice Cancel a pending emergency drain.
    function cancelEmergencyWithdraw() external onlyOwner {
        emergencyRequested = false;
        emit EmergencyWithdrawCancelled();
    }

    /// @notice Drain a token to the owner (the multisig) after the timelock. The only drain path.
    function emergencyWithdraw(address token) external onlyOwner {
        require(emergencyRequested, "No pending request");
        require(block.timestamp >= emergencyRequestedAt + EMERGENCY_TIMELOCK, "Timelock not expired");
        emergencyRequested = false;
        IERC20 t = IERC20(token);
        uint256 bal = t.balanceOf(address(this));
        t.safeTransfer(owner(), bal);
        if (token == address(xrgeToken)) {
            totalLocked = 0;
        }
        emit EmergencyWithdraw(token, owner(), bal);
    }

    // ── Views ───────────────────────────────────────────────────────

    /// @notice XRGE the vault actually holds on-chain.
    function vaultBalance() external view returns (uint256) {
        return xrgeToken.balanceOf(address(this));
    }

    /// @notice How much more can be released in the current rolling window right now.
    function remainingDailyAllowance() external view returns (uint256) {
        if (dailyLimit == 0) return type(uint256).max;
        if (block.timestamp >= windowStart + 1 days) return dailyLimit;
        if (releasedInWindow >= dailyLimit) return 0;
        return dailyLimit - releasedInWindow;
    }
}
