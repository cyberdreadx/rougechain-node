import { ethers } from "hardhat";

/**
 * Mainnet deploy script for Base:
 *   1. Deploys RougeBridge (multi-asset bridge with timelock + guardian)
 *   2. Adds XRGE as a supported token
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (funded with Base ETH)
 *   - GUARDIAN_ADDRESS in .env (or defaults to deployer)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-mainnet.ts --network base
 *
 * After deployment:
 *   - Verify on Basescan:
 *     npx hardhat verify --network base <BRIDGE_ADDRESS> <GUARDIAN_ADDRESS>
 *   - Fund the bridge with XRGE for release operations
 *   - Configure the bridge-relayer with the deployed address
 */

// Real XRGE contract on Base mainnet
const XRGE_ADDRESS = "0x147120faEC9277ec02d957584CFCD92B56A24317";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("=== RougeChain Bridge — Base Mainnet Deploy ===\n");
    console.log("Deployer:", deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH");

    if (balance < ethers.parseEther("0.005")) {
        console.error("\n⚠ Low balance! Need at least ~0.005 ETH for deployment gas.");
        process.exit(1);
    }

    const guardian = process.env.GUARDIAN_ADDRESS || deployer.address;
    console.log("Guardian:", guardian);
    console.log("XRGE Token:", XRGE_ADDRESS);

    // ── 1. Deploy RougeBridge ────────────────────────────────────
    console.log("\nDeploying RougeBridge...");
    const Bridge = await ethers.getContractFactory("RougeBridge");
    const bridge = await Bridge.deploy(guardian);
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log("RougeBridge deployed to:", bridgeAddress);

    // ── 2. Add XRGE as supported token ──────────────────────────
    console.log("\nAdding XRGE as supported token...");
    const tx = await bridge.setSupportedToken(XRGE_ADDRESS, true);
    await tx.wait();
    console.log("XRGE added as supported token ✓");

    // ── Summary ─────────────────────────────────────────────────
    console.log("\n========================================");
    console.log("  DEPLOYMENT COMPLETE");
    console.log("========================================");
    console.log("  RougeBridge:  ", bridgeAddress);
    console.log("  XRGE Token:   ", XRGE_ADDRESS);
    console.log("  Owner/Relayer:", deployer.address);
    console.log("  Guardian:     ", guardian);
    console.log("========================================");
    console.log("\nNext steps:");
    console.log("  1. Verify on Basescan:");
    console.log(`     npx hardhat verify --network base ${bridgeAddress} ${guardian}`);
    console.log("  2. Fund bridge with XRGE for release operations");
    console.log("  3. Update .env on relay servers:");
    console.log(`     BRIDGE_CONTRACT_ADDRESS=${bridgeAddress}`);
    console.log("  4. Start bridge-relayer.ts");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
