#!/usr/bin/env node
/**
 * Seed testnet with qUSDC and qBTC tokens and create XRGE liquidity pools.
 *
 * Usage:
 *   node scripts/seed-testnet-tokens.mjs
 *
 * Requires ROUGECHAIN_PRIVATE_KEY and ROUGECHAIN_PUBLIC_KEY env vars
 * (or edit the defaults below for your testnet wallet).
 */
import { RougeChain } from "@rougechain/sdk";

const NODE_URL =
  process.env.ROUGECHAIN_NODE || "https://testnet.rougechain.io/api";
const PRIVATE_KEY = process.env.ROUGECHAIN_PRIVATE_KEY;
const PUBLIC_KEY = process.env.ROUGECHAIN_PUBLIC_KEY;

if (!PRIVATE_KEY || !PUBLIC_KEY) {
  console.error(
    "Set ROUGECHAIN_PRIVATE_KEY and ROUGECHAIN_PUBLIC_KEY env vars"
  );
  process.exit(1);
}

const rc = new RougeChain({ nodeUrl: NODE_URL });
const wallet = {
  signingPublicKey: PUBLIC_KEY,
  signingPrivateKey: PRIVATE_KEY,
};

const TOKENS = [
  {
    name: "Quantum USDC",
    symbol: "qUSDC",
    supply: 10_000_000,
    poolSeed: 500_000, // 500k qUSDC
    xrgeSeed: 100_000, // 100k XRGE (implies $5/XRGE)
  },
  {
    name: "Quantum Bitcoin",
    symbol: "qBTC",
    supply: 21_000,
    poolSeed: 100, // 100 qBTC
    xrgeSeed: 200_000, // 200k XRGE (implies 1 qBTC = 2000 XRGE)
  },
];

async function main() {
  for (const t of TOKENS) {
    console.log(`\n── Creating ${t.symbol} ──`);
    try {
      const res = await rc.createToken(wallet, {
        tokenName: t.name,
        tokenSymbol: t.symbol,
        initialSupply: t.supply,
      });
      if (res.success) {
        console.log(`  ✓ ${t.symbol} created (supply: ${t.supply})`);
      } else {
        console.log(`  ⚠ ${res.error || "already exists?"}`);
      }
    } catch (e) {
      console.log(`  ⚠ ${e.message}`);
    }

    // Wait a block
    await sleep(6000);

    console.log(`  Creating XRGE/${t.symbol} pool...`);
    try {
      const poolRes = await rc.dex.createPool(wallet, {
        tokenA: "XRGE",
        tokenB: t.symbol,
        amountA: t.xrgeSeed,
        amountB: t.poolSeed,
      });
      if (poolRes.success) {
        console.log(
          `  ✓ Pool created: ${t.xrgeSeed} XRGE + ${t.poolSeed} ${t.symbol}`
        );
      } else {
        console.log(`  ⚠ ${poolRes.error || "pool may already exist"}`);
      }
    } catch (e) {
      console.log(`  ⚠ ${e.message}`);
    }

    await sleep(3000);
  }

  console.log("\n✓ Done! Tokens and pools seeded.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
