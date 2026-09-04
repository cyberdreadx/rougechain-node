import { ethers } from "hardhat";

// Retire the OLD single-owner XRGE vault (V1) by reclaiming its XRGE via the
// contract's own 48h-timelocked emergencyWithdraw. Run by the vault OWNER (0x78e6).
//
// State machine (run the same command now, then again after 48h):
//   - not requested        -> calls requestEmergencyWithdraw() (starts the 48h clock)
//   - requested + elapsed   -> calls emergencyWithdraw(XRGE) (sweeps to owner)
//   - requested + waiting   -> prints time remaining
//
// The reclaimed XRGE goes to the vault's owner() (0x78e6). Move it from there afterwards.

const OLD_VAULT = "0xb3f52f2C1bD5692494655cF59d8EE296D23bFAb5";
const XRGE = "0x147120faEC9277ec02d957584CFCD92B56A24317";

const ABI = [
  "function owner() view returns (address)",
  "function emergencyWithdrawRequested() view returns (bool)",
  "function emergencyWithdrawRequestedAt() view returns (uint256)",
  "function EMERGENCY_TIMELOCK() view returns (uint256)",
  "function vaultBalance() view returns (uint256)",
  "function requestEmergencyWithdraw() external",
  "function cancelEmergencyWithdraw() external",
  "function emergencyWithdraw(address token) external",
];

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 8453) throw new Error(`Expected Base mainnet (8453), got ${net.chainId}.`);

  const [signer] = await ethers.getSigners();
  const v = new ethers.Contract(OLD_VAULT, ABI, signer);

  const owner: string = await v.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase())
    throw new Error(`Signer ${signer.address} is not the vault owner ${owner}. Use the custody key (0x78e6…).`);

  const requested: boolean = await v.emergencyWithdrawRequested();
  const timelock: bigint = await v.EMERGENCY_TIMELOCK();
  const bal: bigint = await v.vaultBalance();
  const now = BigInt(Math.floor(Date.now() / 1000));

  console.log("OLD vault:", OLD_VAULT, "| XRGE held:", ethers.formatUnits(bal, 18));
  console.log("owner:", owner, "(you)");

  if (!requested) {
    console.log("\nNo pending request → starting the 48h emergency-withdraw timelock…");
    const tx = await v.requestEmergencyWithdraw();
    console.log("  tx:", tx.hash);
    await tx.wait();
    const at: bigint = await v.emergencyWithdrawRequestedAt();
    const executeAfter = at + timelock;
    console.log("✓ Timelock started. Executable after:", new Date(Number(executeAfter) * 1000).toISOString());
    console.log("  Re-run this same command after that time to sweep the XRGE to your owner address.");
    return;
  }

  const at: bigint = await v.emergencyWithdrawRequestedAt();
  const executeAfter = at + timelock;
  if (now < executeAfter) {
    const mins = Number(executeAfter - now) / 60;
    console.log(`\nTimelock in progress — executable at ${new Date(Number(executeAfter) * 1000).toISOString()} (~${(mins / 60).toFixed(1)}h left). Re-run then.`);
    return;
  }

  console.log("\nTimelock elapsed → sweeping XRGE to owner…");
  const tx = await v.emergencyWithdraw(XRGE);
  console.log("  tx:", tx.hash);
  await tx.wait();
  const after: bigint = await v.vaultBalance();
  console.log("✓ Swept. Old vault XRGE now:", ethers.formatUnits(after, 18), "→ funds sent to owner", owner);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
