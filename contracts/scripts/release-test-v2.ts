import { ethers, network } from "hardhat";

// Isolated mainnet proof: the fresh relayer key can pay out real XRGE from BridgeVaultV2
// within the on-chain caps — without touching the production daemon/relayer.
//
// Run in YOUR OWN terminal with the RELAYER key inline (never in chat):
//   cd /srv/rougechain/contracts && \
//   RELEASE_TO=0x... RELEASE_AMOUNT=1 \
//   DEPLOYER_PRIVATE_KEY=<your 0x8216 relayer key, 0x-prefixed> \
//   npx hardhat run scripts/release-test-v2.ts --network base
//
// RELEASE_TO defaults to the caller (round-trips the test XRGE back to you).

const VAULT = "0x7BB10752E99e8872d7D2DE5D92bfd43cd935Cd2D";

const VAULT_ABI = [
  "function relayer() view returns (address)",
  "function maxPerTx() view returns (uint256)",
  "function paused() view returns (bool)",
  "function vaultBalance() view returns (uint256)",
  "function processedL1Txs(string) view returns (bool)",
  "function release(address to, uint256 amount, string l1TxId) external",
];

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 8453) throw new Error(`Expected Base mainnet (8453), got ${net.chainId}.`);

  const [signer] = await ethers.getSigners();
  const vault = new ethers.Contract(VAULT, VAULT_ABI, signer);

  const relayer: string = await vault.relayer();
  const paused: boolean = await vault.paused();
  const maxPerTx: bigint = await vault.maxPerTx();
  const bal: bigint = await vault.vaultBalance();

  const to = process.env.RELEASE_TO && ethers.isAddress(process.env.RELEASE_TO)
    ? ethers.getAddress(process.env.RELEASE_TO) : signer.address;
  const amountXrge = BigInt(process.env.RELEASE_AMOUNT ?? "1");
  const amountWei = amountXrge * 10n ** 18n;
  const l1TxId = process.env.RELEASE_ID ?? `mainnet-v2-proof-${Date.now()}`;

  console.log("Vault:        ", VAULT);
  console.log("Signer:       ", signer.address, signer.address.toLowerCase() === relayer.toLowerCase() ? "✓ is the vault relayer" : "✗ NOT the relayer — release() will revert");
  console.log("paused:       ", paused);
  console.log("maxPerTx:     ", Number(maxPerTx) / 1e18, "XRGE");
  console.log("vaultBalance: ", Number(bal) / 1e18, "XRGE");
  console.log("Releasing:    ", amountXrge.toString(), "XRGE →", to);
  console.log("l1TxId:       ", l1TxId);

  if (signer.address.toLowerCase() !== relayer.toLowerCase())
    throw new Error("Signer is not the vault relayer — use the 0x8216 relayer key.");
  if (paused) throw new Error("Vault is paused.");
  if (amountWei > maxPerTx) throw new Error(`Amount ${amountXrge} exceeds maxPerTx ${Number(maxPerTx) / 1e18}.`);
  if (amountWei > bal) throw new Error(`Vault only holds ${Number(bal) / 1e18} XRGE — fund it first.`);

  console.log("\nSending release()…");
  const tx = await vault.release(to, amountWei, l1TxId);
  console.log("  tx:", tx.hash);
  const rc = await tx.wait();
  console.log("  status:", rc?.status === 1 ? "✓ success" : "✗ reverted");

  const balAfter: bigint = await vault.vaultBalance();
  console.log("\nvaultBalance after:", Number(balAfter) / 1e18, "XRGE  (−" + Number(bal - balAfter) / 1e18 + ")");
  console.log("✓ Real XRGE paid out from V2 by the fresh relayer key, within caps.");
  console.log("Now try RELEASE_AMOUNT larger than", Number(maxPerTx) / 1e18, "→ it must revert ExceedsPerTxCap.");
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
