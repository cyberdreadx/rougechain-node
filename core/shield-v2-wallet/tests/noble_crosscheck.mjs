// REVIEW_WALLET_1: cross-check of the committed wallet vectors (spec §8.4) against
// `@noble/post-quantum` (ML-KEM-768), `@noble/hashes` (HKDF / SHA-256 / PBKDF2) and Node's own
// AES-256-GCM — an implementation that shares no code with `fips203` / `aes-gcm` / `hkdf` (Rust).
//
// Read-only. Nothing is installed or written. Usage:
//
//   NOBLE_ROOT=/path/to/node_modules node core/shield-v2-wallet/tests/noble_crosscheck.mjs
//
// Exit code 0 iff every check passes.
import { readFileSync } from "node:fs";
import { createDecipheriv, createCipheriv } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = process.env.NOBLE_ROOT;
if (!root) {
  console.error("set NOBLE_ROOT to a node_modules directory that contains @noble/post-quantum and @noble/hashes");
  process.exit(2);
}
const load = (p) => import(pathToFileURL(join(root, p)).href);
const { ml_kem768 } = await load("@noble/post-quantum/ml-kem.js");
// @noble/hashes moved its entry points between majors; take whichever this tree has
const firstOf = async (...paths) => {
  for (const p of paths) {
    try {
      return await load(p);
    } catch {}
  }
  throw new Error("none of " + paths.join(", "));
};
const { hkdf } = await firstOf("@noble/hashes/hkdf.js", "@noble/hashes/hkdf");
const { sha256 } = await firstOf("@noble/hashes/sha2.js", "@noble/hashes/sha256.js", "@noble/hashes/sha256");
const { sha512 } = await firstOf("@noble/hashes/sha2.js", "@noble/hashes/sha512.js", "@noble/hashes/sha512");
const { pbkdf2 } = await firstOf("@noble/hashes/pbkdf2.js", "@noble/hashes/pbkdf2");

const here = dirname(fileURLToPath(import.meta.url));
const vec = (f) => JSON.parse(readFileSync(join(here, "../../shield-v2/vectors/wallet", f), "utf8"));
const hex = (b) => Buffer.from(b).toString("hex");
const bin = (h) => new Uint8Array(Buffer.from(h, "hex"));
const utf8 = (s) => new TextEncoder().encode(s);

let checks = 0;
let failed = 0;
const eq = (name, got, want) => {
  checks++;
  if (got !== want) {
    failed++;
    console.error(`FAIL ${name}\n  got  ${String(got).slice(0, 96)}\n  want ${String(want).slice(0, 96)}`);
  }
};

const P = 0x7f000001n; // KoalaBear
const keys = vec("keys.json");
const byName = {};
for (const w of keys.wallets) {
  byName[w.name] = w;
  // BIP-39 seed (PBKDF2-HMAC-SHA512, 2,048 rounds, salt "mnemonic" ‖ passphrase)
  const seed = pbkdf2(sha512, utf8(w.recovery_phrase), utf8("mnemonic" + w.passphrase), { c: 2048, dkLen: 64 });
  eq(`${w.name} bip39 seed`, hex(seed), w.bip39_seed);
  // sk: HKDF-SHA256(seed, no salt, "rouge-shield/sk", 64) — the wallet's existing idiom
  const okm = hkdf(sha256, seed, undefined, utf8(w.sk_hkdf_info), 64);
  eq(`${w.name} sk okm`, hex(okm), w.sk_okm);
  const dv = new DataView(okm.buffer, okm.byteOffset, 64);
  const els = [...Array(8)].map((_, i) => Number(dv.getBigUint64(8 * i, true) % P));
  eq(`${w.name} sk elements`, JSON.stringify(els), JSON.stringify(w.sk_elements));
  const skb = Buffer.alloc(32);
  els.forEach((e, i) => skb.writeUInt32LE(e, 4 * i));
  eq(`${w.name} sk bytes`, hex(skb), w.sk);
  // viewing key: d ‖ z, then ML-KEM-768.KeyGen_internal(d, z)
  const dz = hkdf(sha256, seed, undefined, utf8(w.view_hkdf_info), 64);
  eq(`${w.name} view okm`, hex(dz), w.view_okm);
  eq(`${w.name} d`, hex(dz.slice(0, 32)), w.ml_kem_768_d);
  eq(`${w.name} z`, hex(dz.slice(32)), w.ml_kem_768_z);
  const kp = ml_kem768.keygen(dz);
  eq(`${w.name} ML-KEM ek (keygen from seed)`, hex(kp.publicKey), w.ml_kem_768_ek);
  eq(`${w.name} ML-KEM dk (keygen from seed)`, hex(kp.secretKey), w.ml_kem_768_dk);
  eq(`${w.name} dk sha256`, hex(sha256(kp.secretKey)), w.ml_kem_768_dk_sha256);
  // address bytes pk ‖ ek and the fingerprint
  const addr = new Uint8Array([...bin(w.pk), ...kp.publicKey]);
  eq(`${w.name} address sha256`, hex(sha256(addr)), w.address_bytes_sha256);
  eq(`${w.name} fingerprint`, hex(sha256(addr)).slice(0, 16), w.address_fingerprint);
  // a fresh encapsulation made by noble opens with the Rust-derived dk (and the reverse below)
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(bin(w.ml_kem_768_ek));
  eq(`${w.name} noble encaps → decaps with the vector dk`, hex(ml_kem768.decapsulate(cipherText, bin(w.ml_kem_768_dk))), hex(sharedSecret));
}

const noteKey = (ss) => hkdf(sha256, ss, new Uint8Array(32), utf8("rouge-shield/v2/note"), 32);
const open = (key, ct56, aad) => {
  const d = createDecipheriv("aes-256-gcm", key, new Uint8Array(12));
  d.setAAD(aad);
  d.setAuthTag(ct56.slice(40));
  try {
    return new Uint8Array(Buffer.concat([d.update(ct56.slice(0, 40)), d.final()]));
  } catch {
    return null;
  }
};

// note_encryption.json: Encaps with the given m, the shared secret, the key, the ciphertext
const ne = vec("note_encryption.json");
const w1 = byName["wallet-1"];
{
  const enc = ml_kem768.encapsulate(bin(w1.ml_kem_768_ek), bin(ne.ml_kem_768_encaps_randomness_m));
  eq("note: kem_ct (Encaps with m)", hex(enc.cipherText), ne.kem_ct);
  eq("note: shared secret (Encaps)", hex(enc.sharedSecret), ne.shared_secret);
  const ss = ml_kem768.decapsulate(bin(ne.kem_ct), bin(w1.ml_kem_768_dk));
  eq("note: shared secret (Decaps of the committed kem_ct)", hex(ss), ne.shared_secret);
  const key = noteKey(ss);
  eq("note: AES key (salt = 32 zero bytes)", hex(key), ne.aes_256_gcm_key);
  eq("note: AES key (no salt) is the same input", hex(hkdf(sha256, ss, undefined, utf8(ne.hkdf_info), 32)), ne.aes_256_gcm_key);
  const pt = open(key, bin(ne.note_ct), bin(ne.aad));
  eq("note: plaintext (AES-256-GCM open, aad = cm_out)", pt && hex(pt), ne.plaintext);
  eq("note: value", pt && new DataView(pt.buffer).getBigUint64(0, true).toString(), ne.value);
  eq("note: r", pt && hex(pt.slice(8)), ne.r);
  const c = createCipheriv("aes-256-gcm", key, new Uint8Array(12));
  c.setAAD(bin(ne.aad));
  const body = Buffer.concat([c.update(bin(ne.plaintext)), c.final(), c.getAuthTag()]);
  eq("note: note_ct (AES-256-GCM seal)", hex(body), ne.note_ct);
  // a changed aad or a foreign key does not open
  const aad2 = bin(ne.aad);
  aad2[0] ^= 1;
  eq("note: wrong aad does not open", open(key, bin(ne.note_ct), aad2), null);
  const ss2 = ml_kem768.decapsulate(bin(ne.kem_ct), bin(byName["wallet-2"].ml_kem_768_dk));
  eq("note: wallet-2 gets an unrelated secret (implicit rejection)", hex(ss2) !== ne.shared_secret, true);
  eq("note: wallet-2 cannot open", open(noteKey(ss2), bin(ne.note_ct), bin(ne.aad)), null);
}

// transactions.json: every slot a wallet is said to read opens with noble + Node, to the recorded
// (value, r); every other (wallet, slot) pair does not open.
const txs = vec("transactions.json");
for (const t of txs.transactions) {
  const body = bin(t.body);
  const kem = [body.slice(258, 1346), body.slice(1402, 2490)];
  const ct = [body.slice(1346, 1402), body.slice(2490, 2546)];
  const cm = [bin(t.cm_out1), bin(t.cm_out2)];
  let opened = 0;
  for (const w of keys.wallets) {
    for (const j of [0, 1]) {
      const pt = open(noteKey(ml_kem768.decapsulate(kem[j], bin(w.ml_kem_768_dk))), ct[j], cm[j]);
      if (!pt) continue;
      opened++;
      const rec = t.outputs.find((o) => o.slot === j);
      eq(`tx ${t.name}: ${w.name} slot ${j} value`, new DataView(pt.buffer).getBigUint64(0, true).toString(), rec.value);
      eq(`tx ${t.name}: ${w.name} slot ${j} r`, hex(pt.slice(8)), rec.r);
      eq(`tx ${t.name}: ${w.name} slot ${j} is a recorded reader`, rec.role !== "dummy" && w.name in (t.readable_by || {}), true);
    }
  }
  eq(`tx ${t.name}: number of (wallet, slot) pairs that open`, opened, t.outputs.filter((o) => o.role !== "dummy").length);
}

console.log(`${checks - failed} of ${checks} checks passed`);
process.exit(failed ? 1 : 0);
