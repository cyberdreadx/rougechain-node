/**
 * Group messages interoperate with Qwalla: the site's v2 wrapped-CEK package (messenger-crypto-v2)
 * against Qwalla's encryptMailV2 / decryptMailV2 (packages/qwalla-core/pq/encryption.ts, noble),
 * ported verbatim below.
 */
import { describe, expect, it } from "vitest";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { decryptV2Package, encryptAndSignV2, isV2Package, verifyPackageSignature } from "@/lib/messenger-crypto-v2";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const qwallaMsgEnvelope = (body: string) => JSON.stringify({ v: 1, k: "msg", b: body });
const GIPHY_URL = "https://media4.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif";

const WRAP_INFO = new TextEncoder().encode("pqc-cek-wrap");
function qwallaEncryptMailV2(pt: string, recipients: string[], sender: string): string {
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = gcm(cek, iv).encrypt(new TextEncoder().encode(pt));
  const wrappedKeys: Record<string, { kemCipherText: string; wrappedCek: string; wrappedIv: string }> = {};
  for (const k of [...new Set([...recipients, sender])]) {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(unhex(k));
    const wrapKey = hkdf(sha256, sharedSecret, new Uint8Array(32), WRAP_INFO, 32);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    wrappedKeys[k] = { kemCipherText: hex(cipherText), wrappedCek: hex(gcm(wrapKey, wrapIv).encrypt(cek)), wrappedIv: hex(wrapIv) };
  }
  return JSON.stringify({ version: 2, iv: hex(iv), encryptedContent: hex(encrypted), wrappedKeys });
}
function qwallaDecryptMailV2(json: string, priv: string, pub: string): string {
  const pkg = JSON.parse(json);
  const mine = pkg.wrappedKeys[pub];
  const ss = ml_kem768.decapsulate(unhex(mine.kemCipherText), unhex(priv));
  const wrapKey = hkdf(sha256, ss, new Uint8Array(32), WRAP_INFO, 32);
  const cek = gcm(wrapKey, unhex(mine.wrappedIv)).decrypt(unhex(mine.wrappedCek));
  return new TextDecoder().decode(gcm(cek, unhex(pkg.iv)).decrypt(unhex(pkg.encryptedContent)));
}
const kem = () => { const k = ml_kem768.keygen(); return { pub: hex(k.publicKey), priv: hex(k.secretKey) }; };

describe("group messages interoperate with Qwalla (v2 wrapped-CEK)", () => {
  const alice = kem(); // site sender
  const bob = kem();
  const carol = kem();
  const signer = ml_dsa65.keygen();

  it("site → Qwalla: every member (and the sender) can open the site's package; signature verifies", async () => {
    const plaintext = qwallaMsgEnvelope("gm group 👋");
    const { encryptedPackage, signature } = await encryptAndSignV2(plaintext, [bob.pub, carol.pub], alice.pub, hex(signer.secretKey));
    expect(isV2Package(encryptedPackage)).toBe(true);
    const pkg = JSON.parse(encryptedPackage);
    expect(Object.keys(pkg).sort()).toEqual(["encryptedContent", "iv", "version", "wrappedKeys"]);
    expect(Object.keys(pkg.wrappedKeys).sort()).toEqual([alice.pub, bob.pub, carol.pub].sort());
    expect(qwallaDecryptMailV2(encryptedPackage, bob.priv, bob.pub)).toBe(plaintext);
    expect(qwallaDecryptMailV2(encryptedPackage, carol.priv, carol.pub)).toBe(plaintext);
    expect(await decryptV2Package(encryptedPackage, alice.priv, alice.pub)).toBe(plaintext);
    // Qwalla verifies ml_dsa65.verify(sig, utf8(encryptedPackage), signingPub)
    expect(ml_dsa65.verify(unhex(signature), new TextEncoder().encode(encryptedPackage), signer.publicKey)).toBe(true);
    expect(verifyPackageSignature(encryptedPackage, signature, hex(signer.publicKey))).toBe(true);
  });

  it("Qwalla → site: the site opens a Qwalla group package", async () => {
    const plaintext = qwallaMsgEnvelope(GIPHY_URL);
    const pkg = qwallaEncryptMailV2(plaintext, [alice.pub, carol.pub], bob.pub);
    expect(await decryptV2Package(pkg, alice.priv, alice.pub)).toBe(plaintext);
    await expect(decryptV2Package(pkg, kem().priv, kem().pub)).rejects.toThrow();
  });

  it("1:1 packages are not mistaken for group packages", () => {
    expect(isV2Package(JSON.stringify({ kemCipherText: "aa", iv: "bb", encryptedContent: "cc" }))).toBe(false);
    expect(isV2Package("not json")).toBe(false);
  });
});

