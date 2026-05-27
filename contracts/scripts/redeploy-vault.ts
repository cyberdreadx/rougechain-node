import { ethers } from "hardhat";

const XRGE_ADDRESS = "0x147120faEC9277ec02d957584CFCD92B56A24317";
const RELAYER = "0x78e604cB377a50a81F4508E4f6FbFA6C5d2b127C";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH");

    console.log("\nDeploying BridgeVault v2 (underflow fix)...");
    const Vault = await ethers.getContractFactory("BridgeVault");
    const vault = await Vault.deploy(XRGE_ADDRESS);
    await vault.waitForDeployment();
    const addr = await vault.getAddress();
    console.log("✓ BridgeVault v2:", addr);

    console.log("Waiting for confirmation...");
    await new Promise(r => setTimeout(r, 8000));

    console.log("Transferring ownership to relayer...");
    const tx = await vault.transferOwnership(RELAYER);
    await tx.wait();
    console.log("✓ Owner:", await vault.owner());

    console.log("\n=== UPDATE RELAYER ENV ===");
    console.log(`XRGE_BRIDGE_VAULT=${addr}`);
}

main().catch(e => { console.error(e); process.exit(1); });
