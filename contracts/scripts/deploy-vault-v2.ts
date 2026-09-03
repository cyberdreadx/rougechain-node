import { ethers, network } from "hardhat";

// Deploy BridgeVaultV2 (role-split vault) to Base Sepolia (rehearsal) or Base mainnet.
//
// Owner  = the M-of-N Safe multisig (cold governance).
// Relayer = the hot key allowed to call release() within the on-chain caps.
//
// Required env (contracts/.env, gitignored):
//   SAFE_OWNER      = 0x… the Safe multisig address that will govern the vault
//   RELAYER_ADDR    = 0x… the hot relayer address (NOT a Safe signer)
//   MAX_PER_TX      = whole XRGE per single release (e.g. 5)
//   DAILY_LIMIT     = whole XRGE per rolling 24h (e.g. 50; 0 = no daily cap)
//   XRGE_TOKEN      = optional override; else the per-network default below
//   DEPLOYER_PRIVATE_KEY = funded deployer (pays gas only)

const TOKEN_BY_CHAIN: Record<number, { name: string; addr: string }> = {
  84532: { name: "testXRGE @ Base Sepolia", addr: "0xF9e744a43608AB7D64a106df84e52915e8Efa27E" },
  8453:  { name: "XRGE @ Base mainnet",      addr: "0x147120faEC9277ec02d957584CFCD92B56A24317" },
};

function reqAddr(name: string): string {
  const v = process.env[name] || "";
  if (!ethers.isAddress(v)) throw new Error(`${name} must be a valid address (got ${JSON.stringify(v)}). Set it in contracts/.env`);
  return ethers.getAddress(v);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const tk = TOKEN_BY_CHAIN[chainId];
  if (!tk) throw new Error(`Unsupported chainId ${chainId}. Use --network baseSepolia or base.`);

  const token = process.env.XRGE_TOKEN && ethers.isAddress(process.env.XRGE_TOKEN)
    ? ethers.getAddress(process.env.XRGE_TOKEN) : tk.addr;
  const owner = reqAddr("SAFE_OWNER");
  const relayer = reqAddr("RELAYER_ADDR");
  if (owner.toLowerCase() === relayer.toLowerCase())
    throw new Error("SAFE_OWNER and RELAYER_ADDR must differ — the whole point is to split roles.");

  const maxPerTx = BigInt(process.env.MAX_PER_TX ?? "0");
  const dailyLimit = BigInt(process.env.DAILY_LIMIT ?? "0");
  if (maxPerTx === 0n) throw new Error("MAX_PER_TX must be > 0 or release() is disabled. Set a whole-XRGE cap.");
  const maxPerTxWei = maxPerTx * 10n ** 18n;
  const dailyLimitWei = dailyLimit * 10n ** 18n;

  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log(`Network:     ${network.name} (chainId ${chainId})`);
  console.log(`XRGE token:  ${token}  [${chainId === 84532 && token === tk.addr ? tk.name : token === TOKEN_BY_CHAIN[8453].addr ? "REAL XRGE" : "custom"}]`);
  console.log(`Owner (Safe):${owner}`);
  console.log(`Relayer hot: ${relayer}`);
  console.log(`Caps:        maxPerTx=${maxPerTx} XRGE  dailyLimit=${dailyLimit === 0n ? "none" : dailyLimit + " XRGE"}`);
  console.log(`Deployer:    ${deployer.address}  (${ethers.formatEther(bal)} ETH)`);
  if (bal === 0n) throw new Error("Deployer has 0 ETH — fund it before deploying.");

  // Guard: real-mainnet deploy must not use an EOA owner (that would recreate the V1 flaw).
  if (chainId === 8453) {
    const code = await ethers.provider.getCode(owner);
    if (code === "0x") throw new Error("MAINNET REFUSED: SAFE_OWNER has no contract code — it is an EOA, not a Safe. Deploy the multisig first.");
  }

  console.log(`\nDeploying BridgeVaultV2 …`);
  const V2 = await ethers.getContractFactory("BridgeVaultV2");
  const vault = await V2.deploy(token, owner, relayer, maxPerTxWei, dailyLimitWei);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();

  console.log(`\n✓ BridgeVaultV2: ${addr}`);
  console.log(`  owner():     ${await vault.owner()}`);
  console.log(`  relayer():   ${await vault.relayer()}`);
  console.log(`  maxPerTx():  ${(await vault.maxPerTx()) / 10n ** 18n} XRGE`);
  console.log(`  paused():    ${await vault.paused()}`);

  console.log(`\n=== NODE ENV (testnet drop-in / mainnet checklist) ===`);
  console.log(`QV_BRIDGE_CHAIN_ID=${chainId}`);
  console.log(`XRGE_BRIDGE_TOKEN=${token}`);
  console.log(`XRGE_BRIDGE_VAULT=${addr}`);
  console.log(`QV_BASE_SEPOLIA_RPC=${chainId === 84532 ? "https://sepolia.base.org" : "https://mainnet.base.org"}`);
  console.log(`# relayer service: point VAULT_ADDRESS=${addr} and use the RELAYER hot key (${relayer})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
