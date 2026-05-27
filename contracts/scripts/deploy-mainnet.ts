import { ethers } from "hardhat";

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  RougeChain Bridge — Base Mainnet Deployment                    │
 * ├──────────────────────────────────────────────────────────────────┤
 * │                                                                  │
 * │  Security model:                                                 │
 * │    Owner (relayer key)  → automated releases (no manual signing) │
 * │    Guardian (Safe addr) → emergency pause + cancel timelocks     │
 * │    Timelock (24h)       → large withdrawals auto-delayed         │
 * │                                                                  │
 * │  Prerequisites:                                                  │
 * │    1. DEPLOYER_PRIVATE_KEY in .env (funded with ~0.01 Base ETH)  │
 * │    2. GUARDIAN_ADDRESS in .env (Gnosis Safe multisig on Base)    │
 * │       - Create at https://app.safe.global (Base network)         │
 * │       - Use 2-of-3 or 3-of-5 signer threshold                   │
 * │    3. BASESCAN_API_KEY in .env (for verification)                │
 * │                                                                  │
 * │  Usage:                                                          │
 * │    npx hardhat run scripts/deploy-mainnet.ts --network base      │
 * │                                                                  │
 * │  After deploy:                                                   │
 * │    1. Verify on Basescan (command printed below)                 │
 * │    2. Fund bridge with ETH + approve XRGE for releases           │
 * │    3. Set relayer env vars on server                              │
 * │    4. Start bridge-relayer.ts                                    │
 * └──────────────────────────────────────────────────────────────────┘
 */

// Real XRGE contract on Base mainnet
const XRGE_ADDRESS = "0x147120faEC9277ec02d957584CFCD92B56A24317";

// USDC on Base mainnet
const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Your Gnosis Safe multisig on Base mainnet
const SAFE_ADDRESS = "0xDa31C963E979495f4374979127c34E980eF3184e";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║  RougeChain Bridge — Base Mainnet Deploy         ║");
    console.log("╚══════════════════════════════════════════════════╝\n");
    console.log("Deployer:", deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH");

    if (balance < ethers.parseEther("0.005")) {
        console.error("\n⚠ Need at least ~0.005 ETH on Base for deployment gas.");
        process.exit(1);
    }

    const guardian = process.env.GUARDIAN_ADDRESS || SAFE_ADDRESS;
    console.log("Guardian (Safe):", guardian);
    console.log("Ownership target:", SAFE_ADDRESS);
    console.log("XRGE Token:", XRGE_ADDRESS);

    // ── 1. Deploy BridgeVault (XRGE lock/unlock) ────────────────
    console.log("\n[1/5] Deploying BridgeVault...");
    const Vault = await ethers.getContractFactory("BridgeVault");
    const vault = await Vault.deploy(XRGE_ADDRESS);
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();
    console.log("✓ BridgeVault deployed:", vaultAddress);

    // ── 2. Deploy RougeBridge (ETH + ERC-20) ────────────────────
    console.log("\n[2/5] Deploying RougeBridge...");
    const Bridge = await ethers.getContractFactory("RougeBridge");
    const bridge = await Bridge.deploy(guardian);
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log("✓ RougeBridge deployed:", bridgeAddress);

    // ── 3. Configure supported tokens ───────────────────────────
    console.log("\n[3/5] Configuring supported tokens...");
    const tx1 = await bridge.setSupportedToken(XRGE_ADDRESS, true);
    await tx1.wait();
    console.log("✓ XRGE added as supported token");

    const tx2 = await bridge.setSupportedToken(USDC_BASE_MAINNET, true);
    await tx2.wait();
    console.log("✓ USDC added as supported token");

    // ── 4. Set large withdrawal threshold ───────────────────────
    console.log("\n[4/5] Setting large withdrawal threshold to 0.5 ETH...");
    const tx3 = await bridge.setLargeWithdrawalThreshold(ethers.parseEther("0.5"));
    await tx3.wait();
    console.log("✓ Threshold set (withdrawals ≥ 0.5 ETH get 24h timelock)");

    // ── 5. Transfer ownership to Safe ───────────────────────────
    console.log("\n[5/5] Transferring ownership to Safe multisig...");
    const tx4 = await bridge.transferOwnership(SAFE_ADDRESS);
    await tx4.wait();
    console.log("✓ RougeBridge ownership → Safe");

    const tx5 = await vault.transferOwnership(SAFE_ADDRESS);
    await tx5.wait();
    console.log("✓ BridgeVault ownership → Safe");

    // ── Verify ──────────────────────────────────────────────────
    const bridgeOwner = await bridge.owner();
    const vaultOwner = await vault.owner();
    console.log("\n✓ RougeBridge owner:", bridgeOwner);
    console.log("✓ BridgeVault owner:", vaultOwner);

    if (bridgeOwner.toLowerCase() !== SAFE_ADDRESS.toLowerCase() ||
        vaultOwner.toLowerCase() !== SAFE_ADDRESS.toLowerCase()) {
        console.error("⚠ WARNING: Ownership transfer may have failed!");
    }

    // ── Summary ─────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║  DEPLOYMENT COMPLETE                             ║");
    console.log("╠══════════════════════════════════════════════════╣");
    console.log(`║  BridgeVault:   ${vaultAddress}`);
    console.log(`║  RougeBridge:   ${bridgeAddress}`);
    console.log(`║  XRGE Token:    ${XRGE_ADDRESS}`);
    console.log(`║  USDC Token:    ${USDC_BASE_MAINNET}`);
    console.log(`║  Owner (Safe):  ${SAFE_ADDRESS}`);
    console.log(`║  Guardian:      ${guardian}`);
    console.log("╚══════════════════════════════════════════════════╝");

    console.log("\n── Relayer ENV ─────────────────────────────────────\n");
    console.log(`ROUGE_BRIDGE_ADDRESS=${bridgeAddress}`);
    console.log(`XRGE_BRIDGE_VAULT=${vaultAddress}`);
    console.log(`BASE_CHAIN=mainnet`);
    console.log(`CORE_API_URL=https://testnet.rougechain.io`);
    console.log(`BRIDGE_DATA_DIR=/opt/rougechain/bridge`);
    console.log(`BRIDGE_RELAYER_SECRET=<your_secret>`);
    console.log(`BRIDGE_CUSTODY_PRIVATE_KEY=<relayer_key>`);

    console.log("\n── IMPORTANT ──────────────────────────────────────\n");
    console.log("⚠ The deployer key is NO LONGER the owner.");
    console.log("  All admin actions (releases, pause, emergency) now");
    console.log("  require Safe multisig approval.");
    console.log("");
    console.log("  The relayer key needs to be added as a Safe signer,");
    console.log("  or use Safe Transaction Service API for auto-releases.");

    console.log("\n── Verify on Basescan ──────────────────────────────\n");
    console.log(`npx hardhat verify --network base ${vaultAddress} ${XRGE_ADDRESS}`);
    console.log(`npx hardhat verify --network base ${bridgeAddress} ${guardian}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
