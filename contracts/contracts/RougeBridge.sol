// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title RougeBridge
 * @notice Multi-asset bridge contract for RougeChain. Supports ETH and ERC-20
 *         deposits/releases with pause capability, timelock on large withdrawals,
 *         and a guardian role for emergency pauses.
 *
 *         Deposit flow:  User calls depositETH / depositERC20 -> funds locked ->
 *                        relayer mints wrapped token on RougeChain L1.
 *
 *         Release flow:  User burns wrapped token on L1 -> relayer calls
 *                        releaseETH / releaseERC20 -> funds sent to user.
 */
contract RougeBridge is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    address public guardian;

    uint256 public largeWithdrawalThreshold = 1 ether;

    uint256 public timelockDuration = 24 hours;

    struct TimelockRequest {
        address token; // address(0) for ETH
        address to;
        uint256 amount;
        bytes32 l1TxId;
        uint256 executeAfter;
        bool executed;
        bool cancelled;
    }

    mapping(bytes32 => bool) public processedL1Txs;

    TimelockRequest[] public timelockQueue;

    mapping(address => bool) public supportedTokens;

    // -- Events --

    event BridgeDepositETH(
        address indexed sender,
        uint256 amount,
        string rougechainPubkey
    );

    event BridgeDepositERC20(
        address indexed sender,
        address indexed token,
        uint256 amount,
        string rougechainPubkey
    );

    event BridgeReleaseETH(
        address indexed recipient,
        uint256 amount,
        bytes32 l1TxId
    );

    event BridgeReleaseERC20(
        address indexed recipient,
        address indexed token,
        uint256 amount,
        bytes32 l1TxId
    );

    event TimelockQueued(uint256 indexed requestId, uint256 executeAfter);
    event TimelockExecuted(uint256 indexed requestId);
    event TimelockCancelled(uint256 indexed requestId);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);
    event TokenSupported(address indexed token, bool supported);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // -- Errors --

    error ZeroAmount();
    error EmptyPubkey();
    error AlreadyProcessed();
    error NotGuardian();
    error UnsupportedToken();
    error InsufficientBalance();
    error TimelockNotReady();
    error TimelockAlreadyHandled();
    error InvalidRequest();

    // -- Modifiers --

    modifier onlyGuardian() {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _;
    }

    // -- Constructor --

    constructor(address _guardian) Ownable(msg.sender) {
        guardian = _guardian;
    }

    // -- Deposit functions --

    function depositETH(string calldata rougechainPubkey) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        if (bytes(rougechainPubkey).length == 0) revert EmptyPubkey();
        emit BridgeDepositETH(msg.sender, msg.value, rougechainPubkey);
    }

    function depositERC20(
        address token,
        uint256 amount,
        string calldata rougechainPubkey
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (bytes(rougechainPubkey).length == 0) revert EmptyPubkey();
        if (!supportedTokens[token]) revert UnsupportedToken();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit BridgeDepositERC20(msg.sender, token, amount, rougechainPubkey);
    }

    // -- Release functions (owner / multisig) --

    function releaseETH(
        address to,
        uint256 amount,
        bytes32 l1TxId
    ) external onlyOwner nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (processedL1Txs[l1TxId]) revert AlreadyProcessed();

        if (amount >= largeWithdrawalThreshold) {
            _queueTimelock(address(0), to, amount, l1TxId);
            return;
        }

        processedL1Txs[l1TxId] = true;
        if (address(this).balance < amount) revert InsufficientBalance();
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit BridgeReleaseETH(to, amount, l1TxId);
    }

    function releaseERC20(
        address token,
        address to,
        uint256 amount,
        bytes32 l1TxId
    ) external onlyOwner nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (processedL1Txs[l1TxId]) revert AlreadyProcessed();
        if (!supportedTokens[token]) revert UnsupportedToken();

        uint256 thresholdInTokenDecimals = largeWithdrawalThreshold;
        if (amount >= thresholdInTokenDecimals) {
            _queueTimelock(token, to, amount, l1TxId);
            return;
        }

        processedL1Txs[l1TxId] = true;
        IERC20(token).safeTransfer(to, amount);
        emit BridgeReleaseERC20(to, token, amount, l1TxId);
    }

    // -- Timelock --

    function _queueTimelock(address token, address to, uint256 amount, bytes32 l1TxId) internal {
        uint256 executeAfter = block.timestamp + timelockDuration;
        timelockQueue.push(TimelockRequest({
            token: token,
            to: to,
            amount: amount,
            l1TxId: l1TxId,
            executeAfter: executeAfter,
            executed: false,
            cancelled: false
        }));
        uint256 requestId = timelockQueue.length - 1;
        emit TimelockQueued(requestId, executeAfter);
    }

    function executeTimelock(uint256 requestId) external onlyOwner nonReentrant whenNotPaused {
        if (requestId >= timelockQueue.length) revert InvalidRequest();
        TimelockRequest storage req = timelockQueue[requestId];
        if (req.executed || req.cancelled) revert TimelockAlreadyHandled();
        if (block.timestamp < req.executeAfter) revert TimelockNotReady();

        req.executed = true;
        processedL1Txs[req.l1TxId] = true;

        if (req.token == address(0)) {
            if (address(this).balance < req.amount) revert InsufficientBalance();
            (bool ok,) = req.to.call{value: req.amount}("");
            require(ok, "ETH transfer failed");
            emit BridgeReleaseETH(req.to, req.amount, req.l1TxId);
        } else {
            IERC20(req.token).safeTransfer(req.to, req.amount);
            emit BridgeReleaseERC20(req.to, req.token, req.amount, req.l1TxId);
        }
        emit TimelockExecuted(requestId);
    }

    function cancelTimelock(uint256 requestId) external onlyGuardian {
        if (requestId >= timelockQueue.length) revert InvalidRequest();
        TimelockRequest storage req = timelockQueue[requestId];
        if (req.executed || req.cancelled) revert TimelockAlreadyHandled();
        req.cancelled = true;
        emit TimelockCancelled(requestId);
    }

    function getTimelockQueueLength() external view returns (uint256) {
        return timelockQueue.length;
    }

    // -- Guardian / Admin --

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupported(token, supported);
    }

    function setLargeWithdrawalThreshold(uint256 newThreshold) external onlyOwner {
        emit ThresholdUpdated(largeWithdrawalThreshold, newThreshold);
        largeWithdrawalThreshold = newThreshold;
    }

    function setTimelockDuration(uint256 newDuration) external onlyOwner {
        timelockDuration = newDuration;
    }

    function emergencyWithdrawETH() external onlyOwner {
        uint256 bal = address(this).balance;
        (bool ok,) = owner().call{value: bal}("");
        require(ok, "ETH transfer failed");
    }

    function emergencyWithdrawERC20(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), bal);
    }

    receive() external payable {}
}
