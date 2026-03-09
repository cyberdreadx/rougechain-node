// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TestXRGE
 * @notice Testnet ERC-20 representation of XRGE on Base Sepolia.
 *         The contract owner (bridge relayer) can mint tokens when users
 *         bridge XRGE from RougeChain L1 → Base, and any holder can burn
 *         their tokens to initiate the reverse bridge (Base → L1).
 *
 *         This is a TESTNET token — no real value.
 */
contract TestXRGE is ERC20, Ownable {
    event BridgeMint(address indexed to, uint256 amount);
    event BridgeBurn(address indexed from, uint256 amount, string rougechainPubkey);

    constructor(uint256 initialSupply) ERC20("RougeChain XRGE (Testnet)", "testXRGE") Ownable(msg.sender) {
        _mint(msg.sender, initialSupply);
    }

    /**
     * @notice Mint tokens — only callable by bridge relayer (owner).
     * @param to     Recipient EVM address
     * @param amount Amount in smallest units (18 decimals)
     */
    function bridgeMint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
        emit BridgeMint(to, amount);
    }

    /**
     * @notice Burn tokens to initiate bridge from Base → RougeChain L1.
     *         Emits a BridgeBurn event that the relayer watches to credit
     *         XRGE on the L1 side.
     * @param amount           Amount to burn (18 decimals)
     * @param rougechainPubkey Recipient's RougeChain L1 public key (hex)
     */
    function bridgeBurn(uint256 amount, string calldata rougechainPubkey) external {
        require(bytes(rougechainPubkey).length > 0, "Empty RougeChain pubkey");
        _burn(msg.sender, amount);
        emit BridgeBurn(msg.sender, amount, rougechainPubkey);
    }

    /**
     * @notice Standard burn (no bridge event).
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
