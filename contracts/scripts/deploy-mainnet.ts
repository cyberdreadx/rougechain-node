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

    // Guardian = Safe multisig address (emergency pause role)
    const guardian = process.env.GUARDIAN_ADDRESS;
    if (!guardian) {
        console.error("\n⚠ GUARDIAN_ADDRESS is required. Create a Safe multisig at https://app.safe.global");
        console.error("  Then set GUARDIAN_ADDRESS=0x... in your .env");
        process.exit(1);
    }
    console.log("Guardian (Safe):", guardian);
    console.log("XRGE Token:", XRGE_ADDRESS);

    // ── 1. Deploy RougeBridge ────────────────────────────────────
    console.log("\n[1/3] Deploying RougeBridge...");
    const Bridge = await ethers.getContractFactory("RougeBridge");
    const bridge = await Bridge.deploy(guardian);
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log("✓ RougeBridge deployed:", bridgeAddress);

    // ── 2. Add XRGE as supported token ──────────────────────────
    console.log("\n[2/3] Adding XRGE as supported token...");
    const tx1 = await bridge.setSupportedToken(XRGE_ADDRESS, true);
    await tx1.wait();
    console.log("✓ XRGE added");

    // ── 3. Set large withdrawal threshold ───────────────────────
    console.log("\n[3/3] Setting large withdrawal threshold to 0.5 ETH...");
    const tx2 = await bridge.setLargeWithdrawalThreshold(ethers.parseEther("0.5"));
    await tx2.wait();
    console.log("✓ Threshold set (withdrawals ≥ 0.5 ETH get 24h timelock)");

    // ── Summary ─────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║  DEPLOYMENT COMPLETE                             ║");
    console.log("╠══════════════════════════════════════════════════╣");
    console.log(`║  RougeBridge:   ${bridgeAddress}  ║`);
    console.log(`║  XRGE Token:    ${XRGE_ADDRESS}  ║`);
    console.log(`║  Owner/Relayer: ${deployer.address}  ║`);
    console.log(`║  Guardian:      ${guardian}  ║`);
    console.log("╚══════════════════════════════════════════════════╝");

    console.log("\n── Next Steps ──────────────────────────────────────\n");

    console.log("1. Verify on Basescan:");
    console.log(`   npx hardhat verify --network base ${bridgeAddress} ${guardian}\n`);

    console.log("2. Fund the bridge:");
    console.log(`   - Send ETH to ${bridgeAddress} for ETH release operations`);
    console.log(`   - Send XRGE to ${bridgeAddress} for XRGE release operations\n`);

    console.log("3. Set relayer env on your server:");
    console.log(`   ROUGE_BRIDGE_ADDRESS=${bridgeAddress}`);
    console.log(`   BRIDGE_CUSTODY_PRIVATE_KEY=<deployer_private_key>`);
    console.log(`   BASE_CHAIN=mainnet`);
    console.log(`   CORE_API_URL=https://testnet.rougechain.io`);
    console.log(`   BRIDGE_RELAYER_SECRET=<your_secret>\n`);

    console.log("4. Start the relayer:");
    console.log("   npx tsx scripts/bridge-relayer.ts\n");

    console.log("── Security Model ─────────────────────────────────\n");
    console.log("  Relayer key (owner): auto-processes releases — no manual signing");
    console.log("  Safe multisig (guardian): emergency pause + cancel suspicious timelocks");
    console.log("  Timelock: withdrawals ≥ 0.5 ETH are delayed 24h, guardian can cancel");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
