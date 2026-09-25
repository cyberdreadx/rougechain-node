/**
 * MAINNET custody-key rotation — Base mainnet (chainId 8453).
 *
 * Transfers ownership of the BridgeVault + RougeBridge from the CURRENT custody key to a NEW
 * address you control. Heavily guarded:
 *   - refuses to run off Base mainnet (8453)
 *   - refuses unless the signer IS the known current custody key
 *   - validates NEW_OWNER (real address, not zero, not the same key)
 *   - DRY-RUN by default — prints the plan and sends nothing; you must pass CONFIRM_ROTATE=yes
 *   - verifies owner() actually moved after each transfer, aborts on mismatch
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY = the CURRENT custody key (signs the transfers)
 *   NEW_OWNER            = the NEW owner address you control (generate it securely, off this box)
 *   CONFIRM_ROTATE=yes   = actually execute (omit for a dry run)
 *
 * Dry run:
 *   DEPLOYER_PRIVATE_KEY=<current custody key> NEW_OWNER=0xYourNewAddr \
 *     npx hardhat run scripts/rotate-custody-mainnet.ts --network base
 * Execute: add CONFIRM_ROTATE=yes
 */
import { ethers } from "hardhat";

const VAULT = "0xb3f52f2C1bD5692494655cF59d8EE296D23bFAb5";        // BridgeVault (holds XRGE)
const ROUGE_BRIDGE = "0x0c09C764AdC024497729cd452ECfeE8869d35d83"; // RougeBridge (ETH/ERC20)
const EXPECTED_CUSTODY = "0x78e604cB377a50a81F4508E4f6FbFA6C5d2b127C"; // current (exposed) owner

const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner) external",
];

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
  if (Number(net.chainId) !== 8453) {
    throw new Error(`This is the MAINNET rotation — expected Base mainnet (8453), got ${net.chainId}. Use --network base.`);
  }

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  console.log("Network: Base mainnet (8453)");
  console.log("Signer (should be current custody key):", signerAddr);
  if (signerAddr.toLowerCase() !== EXPECTED_CUSTODY.toLowerCase()) {
    throw new Error(`Signer ${signerAddr} is NOT the known custody key ${EXPECTED_CUSTODY}. Wrong key — aborting.`);
  }

  const raw = process.env.NEW_OWNER || "";
  if (!ethers.isAddress(raw)) throw new Error("Set NEW_OWNER to a valid address you control.");
  const newOwner = ethers.getAddress(raw);
  if (newOwner === ethers.ZeroAddress) throw new Error("NEW_OWNER is the zero address — that would brick the contracts.");
  if (newOwner.toLowerCase() === signerAddr.toLowerCase()) throw new Error("NEW_OWNER equals the current key — nothing to rotate.");

  const vault = new ethers.Contract(VAULT, OWNABLE_ABI, signer);
  const bridge = new ethers.Contract(ROUGE_BRIDGE, OWNABLE_ABI, signer);

  const vaultOwner = await readRetry(() => vault.owner(), "vault.owner");
  const bridgeOwner = await readRetry(() => bridge.owner(), "bridge.owner");
  const you = (a: string) => (a.toLowerCase() === signerAddr.toLowerCase() ? "(you) ✓" : "(NOT you ✗)");
  console.log("\nCurrent owners:");
  console.log("  BridgeVault :", vaultOwner, you(vaultOwner));
  console.log("  RougeBridge :", bridgeOwner, you(bridgeOwner));
  console.log("\n>>> Will transfer ownership of BOTH to:", newOwner);
  console.log("    (double-check that address char-by-char — transferOwnership is irreversible)");

  if (process.env.CONFIRM_ROTATE !== "yes") {
    console.log("\n*** DRY RUN *** — nothing sent. Re-run with CONFIRM_ROTATE=yes to execute.");
    return;
  }

  for (const [name, c, owner, addr] of [
    ["BridgeVault", vault, vaultOwner, VAULT],
    ["RougeBridge", bridge, bridgeOwner, ROUGE_BRIDGE],
  ] as const) {
    if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
      console.log(`\n${name} ${addr}: skipped — not owned by the signer.`);
      continue;
    }
    console.log(`\ntransferOwnership(${newOwner}) on ${name} ${addr}…`);
    const tx = await c.transferOwnership(newOwner);
    console.log("  tx:", tx.hash, "→ waiting 2 confirmations…");
    await tx.wait(2);
    const now = await readRetry(() => c.owner(), `${name}.owner`);
    const ok = now.toLowerCase() === newOwner.toLowerCase();
    console.log("  owner() now:", now, ok ? "✓" : "✗ MISMATCH");
    if (!ok) throw new Error(`${name} ownership did NOT move to ${newOwner} — STOP and investigate.`);
  }

  console.log("\n✓ ROTATION COMPLETE — both contracts now owned by", newOwner);
  console.log("\nNext (off-chain):");
  console.log("  1. Put the NEW private key into bridge-relayer.env (the custody-key entry), perms 0600.");
  console.log("  2. Restart your bridge relayer process(es) so they sign with the new key.");
  console.log("  3. Confirm a withdrawal releases, then sweep the old key's leftover gas and retire it.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n✗", e.message); process.exit(1); });
