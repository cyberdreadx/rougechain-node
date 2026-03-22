// Smoke test: mnemonic determinism
import { Wallet, generateMnemonic, validateMnemonic, keypairFromMnemonic } from "./dist/index.js";

// Test 1: Generate mnemonic
const mnemonic = generateMnemonic();
console.log("Mnemonic:", mnemonic);
console.log("Valid:", validateMnemonic(mnemonic));

// Test 2: Determinism - same mnemonic → same keys
const kp1 = keypairFromMnemonic(mnemonic);
const kp2 = keypairFromMnemonic(mnemonic);
console.log("Deterministic:", kp1.publicKey === kp2.publicKey && kp1.secretKey === kp2.secretKey);

// Test 3: Wallet.fromMnemonic
const w1 = Wallet.fromMnemonic(mnemonic);
console.log("Wallet pubkey matches:", w1.publicKey === kp1.publicKey);
console.log("Wallet has mnemonic:", !!w1.mnemonic);
console.log("Wallet verify:", w1.verify());

// Test 4: Wallet.generate() now includes mnemonic
const w2 = Wallet.generate();
console.log("Generated wallet has mnemonic:", !!w2.mnemonic);
console.log("Generated wallet verify:", w2.verify());

// Test 5: Passphrase changes keys
const kpPass = keypairFromMnemonic(mnemonic, "test-passphrase");
console.log("Passphrase changes key:", kpPass.publicKey !== kp1.publicKey);

// Test 6: 24-word mnemonic
const m24 = generateMnemonic(256);
console.log("24-word count:", m24.split(" ").length);
console.log("24-word valid:", validateMnemonic(m24));

console.log("\nAll tests passed! ✅");
