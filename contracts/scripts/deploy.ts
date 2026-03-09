import { ethers } from "hardhat";

/**
 * Deploy script for Base Sepolia testnet:
 *   1. Deploys TestXRGE (mock of real XRGE for testing)
 *   2. Deploys BridgeVault pointing at the TestXRGE address
 *
 * For mainnet, skip step 1 and pass the real XRGE address:
 *   XRGE_ADDRESS=0x147120faEC9277ec02d957584CFCD92B56A24317
 */
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH\n");

    // ── 1. Token ──────────────────────────────────────────────────
    let xrgeAddress = process.env.XRGE_ADDRESS || "";

    if (!xrgeAddress) {
        // No real XRGE address provided → deploy TestXRGE for testing
        console.log("No XRGE_ADDRESS set — deploying TestXRGE for testing...");
        const initialSupply = ethers.parseUnits("36000000000", 18); // 36 billion
        const TestXRGE = await ethers.getContractFactory("TestXRGE");
        const testToken = await TestXRGE.deploy(initialSupply);
        await testToken.waitForDeployment();
        xrgeAddress = await testToken.getAddress();
        console.log("TestXRGE deployed to:", xrgeAddress);
    } else {
        console.log("Using existing XRGE at:", xrgeAddress);
    }

    // ── 2. Bridge Vault ───────────────────────────────────────────
    console.log("\nDeploying BridgeVault...");
    const BridgeVault = await ethers.getContractFactory("BridgeVault");
    const vault = await BridgeVault.deploy(xrgeAddress);
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();

    console.log("\n========================================");
    console.log("BridgeVault deployed to:", vaultAddress);
    console.log("XRGE token:           ", xrgeAddress);
    console.log("Owner (relayer):      ", deployer.address);
    console.log("========================================");
    console.log("\nAdd to your .env:");
    console.log(`XRGE_BRIDGE_VAULT=${vaultAddress}`);
    console.log(`XRGE_CONTRACT_ADDRESS=${xrgeAddress}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
