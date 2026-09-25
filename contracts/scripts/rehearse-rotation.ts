/**
 * CUSTODY-KEY ROTATION REHEARSAL — Base Sepolia only.
 *
 * Runs the EXACT flow you'd run on mainnet, on a throwaway BridgeVault, so you can watch
 * ownership move from the "old" key to a "new" key and confirm nothing breaks — before ever
 * touching the real contracts.
 *
 * What it proves:
 *   1. Deploy a BridgeVault (same contract type as mainnet) — owner = your test key ("old owner").
 *   2. transferOwnership(newOwner) — signed by the old key (exactly the mainnet step).
 *   3. owner() flips to the new address.
 *   4. The OLD key is now locked out of onlyOwner calls (reverts).
 *   5. The NEW key can call onlyOwner calls (succeeds).  ← the cutover, proven safe.
 *
 * Run:
 *   cd contracts
 *   DEPLOYER_PRIVATE_KEY=<a funded Base-Sepolia test key> \
 *     npx hardhat run scripts/rehearse-rotation.ts --network baseSepolia
 *
 * Prereq: fund that test key with a little Base Sepolia ETH (faucet). It never uses your real
 * custody key. It refuses to run on anything but Base Sepolia (chainId 84532).
 */
import { ethers, network } from "hardhat";

// A placeholder "token" for the vault constructor — irrelevant to ownership mechanics.
const DUMMY_TOKEN = "0x000000000000000000000000000000000000dEaD";

// Public Base Sepolia RPCs are load-balanced and can briefly return empty ("0x") for a read
// right after the state changes (the node you hit hasn't caught up). Retry reads a few times.
async function readRetry<T>(fn: () => Promise<T>, label: string, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error(`${label} failed after ${tries} retries: ${(last as Error)?.message ?? last}`);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  // ── HARD SAFETY GUARD ─────────────────────────────────────────────────────
  if (chainId !== 84532 || network.name === "base" || network.name === "mainnet") {
    throw new Error(
      `REFUSING TO RUN: this rehearsal is Base-Sepolia-only (chainId 84532). ` +
      `Got chainId ${chainId} on network "${network.name}". Never run this against mainnet.`
    );
  }
  console.log(`Network: Base Sepolia (${chainId}) ✓ (safe testnet)\n`);

  const [oldOwner] = await ethers.getSigners();
  const oldBal = await ethers.provider.getBalance(oldOwner.address);
  console.log("OLD owner (your test key):", oldOwner.address);
  console.log("  balance:", ethers.formatEther(oldBal), "ETH");
  if (oldBal === 0n) throw new Error("Test key has 0 Sepolia ETH — fund it from a faucet first.");

  // Step 1 — deploy a BridgeVault (same contract as mainnet). owner = deployer.
  console.log("\n[1/5] Deploying a throwaway BridgeVault (owner = old key)…");
  const Vault = await ethers.getContractFactory("BridgeVault");
  const vault = await Vault.deploy(DUMMY_TOKEN);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("      vault:", vaultAddr);
  // Wait for a couple confirmations so the public RPC nodes have the contract code, then read.
  const depTx = vault.deploymentTransaction();
  if (depTx) await depTx.wait(2);
  console.log("      owner():", await readRetry(() => vault.owner(), "owner()"));

  // Step 2 — generate the NEW key (on mainnet you'd generate this offline + fund it).
  const newOwner = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log("\n[2/5] Generated NEW owner key:", newOwner.address);

  // Step 3 — transferOwnership(newOwner), signed by the OLD key. THE mainnet step.
  console.log("\n[3/5] transferOwnership(newOwner) — signed by the old key…");
  const tx = await vault.connect(oldOwner).transferOwnership(newOwner.address);
  console.log("      tx:", tx.hash, "→ waiting…");
  await tx.wait(2);
  const ownerNow = await readRetry(() => vault.owner(), "owner()");
  console.log("      owner() now:", ownerNow);
  if (ownerNow.toLowerCase() !== newOwner.address.toLowerCase()) {
    throw new Error("FAIL: owner() did not change to the new address.");
  }
  console.log("      ✓ ownership moved to the new key.");

  // Step 4 — prove the OLD key is now locked out of onlyOwner calls.
  console.log("\n[4/5] Old key tries an onlyOwner call (should REVERT)…");
  try {
    await vault.connect(oldOwner).requestEmergencyWithdraw.staticCall();
    throw new Error("FAIL: old key was NOT locked out — it could still call onlyOwner!");
  } catch (e: any) {
    if (String(e.message).includes("FAIL:")) throw e;
    console.log("      ✓ old key rejected (locked out), as expected.");
  }

  // Step 5 — prove the NEW key IS in control. Fund it a little gas, then call onlyOwner.
  console.log("\n[5/5] New key takes control (fund gas, then onlyOwner call)…");
  const fund = await oldOwner.sendTransaction({ to: newOwner.address, value: ethers.parseEther("0.00005") });
  await fund.wait(2);
  const call = await vault.connect(newOwner).requestEmergencyWithdraw();
  await call.wait();
  console.log("      ✓ new key executed an onlyOwner call — it is in control.");

  console.log("\n──────────────────────────────────────────────");
  console.log("REHEARSAL PASSED ✓  Ownership rotated cleanly, old key locked out, new key in control.");
  console.log("──────────────────────────────────────────────");
  console.log(`
On MAINNET the same three lines apply, run from your current custody key
(0x78e604cB377a50a81F4508E4f6FbFA6C5d2b127C) to a NEW address you control:

  vault.transferOwnership(NEW)      // BridgeVault  0xb3f52f2C1bD5692494655cF59d8EE296D23bFAb5
  rougeBridge.transferOwnership(NEW)// RougeBridge  0x0c09C764AdC024497729cd452ECfeE8869d35d83

Sequence: fund NEW key for gas → point the custody private-key env var at the NEW key in
bridge-relayer.env (don't restart yet) → transferOwnership on both → restart the relayer →
verify owner() equals the NEW address → sweep the old key's leftover gas → retire the old key.

Deposits are unaffected (they go to the contracts, not the key). Worst case if mis-sequenced:
withdrawals pause and queue — never lost.
`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n✗", e.message); process.exit(1); });
