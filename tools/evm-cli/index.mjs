#!/usr/bin/env node
/**
 * rougechain-evm — terminal Base/EVM wallet for RougeChain.
 *
 * One seed, two chains: this derives your Base (secp256k1) account from the SAME
 * BIP-39 mnemonic that backs your RougeChain PQC wallet, using the standard Ethereum
 * path m/44'/60'/0'/0/0 — identical to browser-extension/src/lib/evm-wallet.ts. So the
 * address this prints is the same one the wallet extension shows.
 *
 * Signing uses the audited micro-eth-signer library (never hand-rolled RLP).
 *
 * The mnemonic is read from the ROUGECHAIN_MNEMONIC environment variable ONLY — never
 * pass it as a command-line argument (args leak into shell history and `ps`).
 *
 *   export ROUGECHAIN_MNEMONIC="word1 word2 ... word24"
 *   rougechain-evm address
 *   rougechain-evm balance                       # ETH + XRGE on Base mainnet
 *   rougechain-evm balance --net sepolia
 *   rougechain-evm balance --token 0xTokenAddr
 *   rougechain-evm send-eth   <to> <amountEth>            [--net sepolia]
 *   rougechain-evm send-token <token> <to> <amount> [--decimals 18] [--net sepolia]
 */
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { addr, Transaction } from "micro-eth-signer";

const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

const NETS = {
  mainnet:    { chainId: 8453,     rpc: "https://mainnet.base.org", name: "Base",             scan: "https://basescan.org" },
  sepolia:    { chainId: 84532,    rpc: "https://sepolia.base.org", name: "Base Sepolia",     scan: "https://sepolia.basescan.org" },
  ethsepolia: { chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", name: "Ethereum Sepolia", scan: "https://sepolia.etherscan.io" },
};

// Known RougeChain token addresses on Base (for convenience in `balance`).
const XRGE_TOKEN = "0x147120faEC9277ec02d957584CFCD92B56A24317";

// ── helpers ───────────────────────────────────────────────────────────────

function die(msg) { console.error("error: " + msg); process.exit(1); }

function toHexKey(bytes) {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deriveAccount() {
  const m = (process.env.ROUGECHAIN_MNEMONIC || "").trim();
  if (!m) die("set ROUGECHAIN_MNEMONIC (the 24-word phrase) in the environment first.");
  if (!validateMnemonic(m, wordlist)) die("ROUGECHAIN_MNEMONIC is not a valid BIP-39 phrase.");
  const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(m)).derive(ETH_DERIVATION_PATH);
  if (!hd.privateKey) die("failed to derive private key.");
  const privateKey = toHexKey(hd.privateKey);
  return { address: addr.fromPrivateKey(privateKey), privateKey };
}

function parseFlags(args) {
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; }
    else pos.push(args[i]);
  }
  return { flags, pos };
}

function net(flags) {
  const n = (flags.net || flags.network || "mainnet").toLowerCase();
  if (!NETS[n]) die(`unknown --net "${n}" (use mainnet or sepolia).`);
  return NETS[n];
}

async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

function parseUnits(s, decimals) {
  if (!/^\d+(\.\d+)?$/.test(s)) die(`invalid amount "${s}".`);
  const [i, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

function formatUnits(v, decimals) {
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, -decimals);
  const f = s.slice(-decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

const pad32 = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, "0");
const addrArg = (a) => pad32(a.replace(/^0x/, ""));
const uintArg = (v) => pad32(v.toString(16));

async function erc20Balance(url, token, owner) {
  const data = "0x70a08231" + addrArg(owner);
  const res = await rpc(url, "eth_call", [{ to: token, data }, "latest"]);
  return BigInt(res || "0x0");
}

async function erc20Decimals(url, token) {
  try {
    const res = await rpc(url, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
    return Number(BigInt(res || "0x12"));
  } catch { return 18; }
}

/** Fill fees/nonce/gas, sign an EIP-1559 tx, and broadcast. Returns the tx hash. */
async function signAndSend(account, network, { to, value = 0n, data = "0x" }) {
  const url = network.rpc;
  const from = account.address;
  const nonce = BigInt(await rpc(url, "eth_getTransactionCount", [from, "pending"]));
  const block = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas || "0x0");
  const priority = 1_000_000_000n;                 // 1 gwei tip
  const maxFee = baseFee * 2n + priority;
  let gas;
  try {
    gas = BigInt(await rpc(url, "eth_estimateGas", [{
      from, to, value: "0x" + value.toString(16), data,
    }]));
  } catch (e) {
    die("gas estimation failed (tx would revert): " + e.message);
  }
  gas = gas + gas / 5n;                             // +20% headroom

  const tx = Transaction.prepare({
    type: "eip1559",
    chainId: BigInt(network.chainId),
    nonce,
    to,
    value,
    data,
    gasLimit: gas,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priority,
  });
  const raw = tx.signBy(account.privateKey).toHex();
  return rpc(url, "eth_sendRawTransaction", [raw]);
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdNew() {
  const mnemonic = generateMnemonic(wordlist, 256); // 24 words
  const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(ETH_DERIVATION_PATH);
  const privateKey = toHexKey(hd.privateKey);
  const address = addr.fromPrivateKey(privateKey);
  console.log("# New wallet (SAVE THE PHRASE — it controls both your RougeChain and Base addresses)");
  console.log("Mnemonic: " + mnemonic);
  console.log("Base addr: " + address);
  console.log("\nUse it with:\n  export ROUGECHAIN_MNEMONIC=\"" + mnemonic + "\"");
}

async function cmdAddress() {
  const a = deriveAccount();
  console.log(a.address);
}

async function cmdBalance(flags) {
  const n = net(flags);
  const a = deriveAccount();
  const url = n.rpc;
  const wei = BigInt(await rpc(url, "eth_getBalance", [a.address, "latest"]));
  console.log(`Address:  ${a.address}`);
  console.log(`Network:  ${n.name} (chainId ${n.chainId})`);
  console.log(`ETH:      ${formatUnits(wei, 18)}`);

  const tokens = [];
  if (flags.token) tokens.push({ label: "TOKEN", addr: flags.token });
  else tokens.push({ label: "XRGE", addr: XRGE_TOKEN });
  for (const t of tokens) {
    try {
      const dec = await erc20Decimals(url, t.addr);
      const bal = await erc20Balance(url, t.addr, a.address);
      console.log(`${t.label.padEnd(9)} ${formatUnits(bal, dec)}   (${t.addr})`);
    } catch (e) {
      console.log(`${t.label.padEnd(9)} <unavailable: ${e.message}>`);
    }
  }
}

async function cmdSendEth(pos, flags) {
  const [to, amount] = pos;
  if (!to || !amount) die("usage: rougechain-evm send-eth <to> <amountEth> [--net sepolia]");
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) die(`invalid recipient address "${to}".`);
  const n = net(flags);
  const a = deriveAccount();
  const value = parseUnits(amount, 18);
  console.log(`Sending ${amount} ETH  ${a.address} -> ${to}  on ${n.name} ...`);
  const hash = await signAndSend(a, n, { to, value, data: "0x" });
  console.log(`tx: ${hash}`);
  console.log(`    ${n.scan}/tx/${hash}`);
}

async function cmdSendToken(pos, flags) {
  const [token, to, amount] = pos;
  if (!token || !to || !amount) die("usage: rougechain-evm send-token <token> <to> <amount> [--decimals 18] [--net sepolia]");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) die(`invalid token address "${token}".`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) die(`invalid recipient address "${to}".`);
  const n = net(flags);
  const a = deriveAccount();
  const decimals = flags.decimals != null ? Number(flags.decimals) : await erc20Decimals(n.rpc, token);
  const units = parseUnits(amount, decimals);
  // transfer(address,uint256)
  const data = "0xa9059cbb" + addrArg(to) + uintArg(units);
  console.log(`Sending ${amount} token(${decimals}dp)  ${a.address} -> ${to}  via ${token}  on ${n.name} ...`);
  const hash = await signAndSend(a, n, { to: token, value: 0n, data });
  console.log(`tx: ${hash}`);
  console.log(`    ${n.scan}/tx/${hash}`);
}

function usage() {
  console.log(`rougechain-evm — terminal Base wallet (derives from ROUGECHAIN_MNEMONIC)

Commands:
  new                                        Generate a fresh 24-word wallet + Base address
  address                                    Print your Base address
  balance [--net mainnet|sepolia] [--token 0x..]   ETH + XRGE (or a custom token) balance
  send-eth   <to> <amountEth>            [--net sepolia]
  send-token <token> <to> <amount> [--decimals 18] [--net sepolia]

Set the phrase first (never as an argument):
  export ROUGECHAIN_MNEMONIC="word1 ... word24"`);
}

// ── main ──────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseFlags(rest);

const run = {
  new: () => cmdNew(),
  address: () => cmdAddress(),
  balance: () => cmdBalance(flags),
  "send-eth": () => cmdSendEth(pos, flags),
  "send-token": () => cmdSendToken(pos, flags),
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }
if (!run[cmd]) { console.error(`unknown command "${cmd}"\n`); usage(); process.exit(1); }
run[cmd]().catch((e) => die(e.message));
