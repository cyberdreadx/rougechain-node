import { ethers } from "hardhat";

/**
 * Deploy ALL bridge contracts to Base Sepolia:
 *   1. TestXRGE     — testnet ERC-20 mock of XRGE
 *   2. BridgeVault  — locks/releases XRGE between Base ↔ RougeChain L1
 *   3. RougeBridge  — multi-asset bridge for ETH + USDC (with pause, timelock, guardian)
 *
 * After deployment, configure USDC as a supported token on RougeBridge.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-all.ts --network baseSepolia
 */

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function waitForConfirmation(label: string) {
    console.log(`  Waiting for ${label} to confirm...`);
    await new Promise(resolve => setTimeout(resolve, 15000));
    console.log(`  ${label} confirmed.\n`);
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH\n");

    // ── 1. TestXRGE ──────────────────────────────────────────────
    let xrgeAddress = process.env.XRGE_ADDRESS || "";

    if (!xrgeAddress) {
        console.log("Deploying TestXRGE (testnet mock)...");
        const initialSupply = ethers.parseUnits("36000000000", 18); // 36 billion
        const TestXRGE = await ethers.getContractFactory("TestXRGE");
        const testToken = await TestXRGE.deploy(initialSupply);
        await testToken.waitForDeployment();
        xrgeAddress = await testToken.getAddress();
        console.log("  TestXRGE deployed to:", xrgeAddress);
        await waitForConfirmation("TestXRGE");
    } else {
        console.log("Using existing XRGE at:", xrgeAddress);
    }

    // ── 2. BridgeVault (XRGE bridge) ─────────────────────────────
    let vaultAddress = process.env.BRIDGE_VAULT_ADDRESS || "";

    if (!vaultAddress) {
        console.log("Deploying BridgeVault...");
        const BridgeVault = await ethers.getContractFactory("BridgeVault");
        const vault = await BridgeVault.deploy(xrgeAddress);
        await vault.waitForDeployment();
        vaultAddress = await vault.getAddress();
        console.log("  BridgeVault deployed to:", vaultAddress);
        await waitForConfirmation("BridgeVault");
    } else {
        console.log("Using existing BridgeVault at:", vaultAddress);
    }

    // ── 3. RougeBridge (ETH + USDC bridge) ───────────────────────
    console.log("Deploying RougeBridge...");
    const RougeBridge = await ethers.getContractFactory("RougeBridge");
    const bridge = await RougeBridge.deploy(deployer.address); // deployer = guardian
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log("  RougeBridge deployed to:", bridgeAddress);
    await waitForConfirmation("RougeBridge");

    // ── 4. Configure USDC as supported token ─────────────────────
    console.log("\nConfiguring USDC as supported token on RougeBridge...");
    const setSupportedTx = await bridge.setSupportedToken(USDC_BASE_SEPOLIA, true);
    await setSupportedTx.wait();
    console.log("  USDC whitelisted:", USDC_BASE_SEPOLIA);

    // ── Summary ──────────────────────────────────────────────────
    console.log("\n" + "=".repeat(60));
    console.log("  DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log("");
    console.log("  TestXRGE:         ", xrgeAddress);
    console.log("  BridgeVault:      ", vaultAddress);
    console.log("  RougeBridge:      ", bridgeAddress);
    console.log("  USDC (Base Sep):  ", USDC_BASE_SEPOLIA);
    console.log("  Owner / Guardian: ", deployer.address);
    console.log("");
    console.log("=".repeat(60));
    console.log("  ENV VARS FOR YOUR SERVER");
    console.log("=".repeat(60));
    console.log("");
    console.log("  # Daemon (.env or systemd)");
    console.log(`  QV_BRIDGE_CUSTODY_ADDRESS=${bridgeAddress}`);
    console.log(`  XRGE_BRIDGE_VAULT=${vaultAddress}`);
    console.log(`  BRIDGE_RELAYER_SECRET=<pick-a-secret>`);
    console.log("");
    console.log("  # Relayer (.env or systemd)");
    console.log(`  BRIDGE_CUSTODY_PRIVATE_KEY=<your-deployer-private-key>`);
    console.log(`  ROUGE_BRIDGE_ADDRESS=${bridgeAddress}`);
    console.log(`  XRGE_BRIDGE_VAULT=${vaultAddress}`);
    console.log(`  XRGE_CONTRACT_ADDRESS=${xrgeAddress}`);
    console.log(`  USDC_ADDRESS=${USDC_BASE_SEPOLIA}`);
    console.log(`  BRIDGE_RELAYER_SECRET=<same-secret-as-daemon>`);
    console.log(`  CORE_API_URL=http://localhost:5101`);
    console.log(`  BASE_SEPOLIA_RPC=https://sepolia.base.org`);
    console.log("");
    console.log("=".repeat(60));
    console.log("  NEXT STEPS");
    console.log("=".repeat(60));
    console.log("");
    console.log("  1. Fund RougeBridge with testnet ETH:");
    console.log(`     Send ETH to ${bridgeAddress}`);
    console.log("");
    console.log("  2. Fund BridgeVault with TestXRGE:");
    console.log(`     Transfer TestXRGE to ${vaultAddress}`);
    console.log("");
    console.log("  3. Set env vars on your VPS and restart daemon");
    console.log("  4. Start the bridge relayer:");
    console.log("     npx tsx scripts/bridge-relayer.ts");
    console.log("");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
