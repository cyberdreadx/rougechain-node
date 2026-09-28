/**
 * Group (multi-recipient) messenger encryption — the "v2 wrapped-CEK" package Qwalla sends for any
 * conversation with 2+ other members (Qwalla packages/qwalla-core/pq/encryption.ts encryptMailV2 /
 * decryptMailV2 / decryptAny):
 *
 *   {"version":2,"iv":<hex>,"encryptedContent":<hex>,
 *    "wrappedKeys":{"<encPubHex>":{"kemCipherText":<hex>,"wrappedCek":<hex>,"wrappedIv":<hex>},...}}
 *
 * A random 32-byte CEK encrypts the plaintext with AES-256-GCM; for every member (sender included)
 * the CEK is wrapped with AES-256-GCM under HKDF-SHA256(ML-KEM-768 shared secret, salt=zeros(32),
 * info="pqc-cek-wrap"). The sender signs the package JSON string with ML-DSA-65, exactly like 1:1.
 * Same format as the site's mail (src/lib/pqc-mail.ts), kept separate so the messenger owns it.
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

const WRAP_INFO = new TextEncoder().encode("pqc-cek-wrap");

export interface V2WrappedKey {
  kemCipherText: string;
  wrappedCek: string;
  wrappedIv: string;
}

export interface V2Package {
  version: 2;
  iv: string;
  encryptedContent: string;
  wrappedKeys: Record<string, V2WrappedKey>;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** A standalone copy WebCrypto accepts (also across realms, e.g. under jsdom in tests). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function wrapKey(sharedSecret: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", buf(sharedSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: buf(WRAP_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** True when a ciphertext string is a v2 wrapped-CEK package (a group message). */
export function isV2Package(encryptedPackage: string): boolean {
  try {
    const o = JSON.parse(encryptedPackage) as { version?: unknown; wrappedKeys?: unknown };
    return o?.version === 2 && !!o.wrappedKeys && typeof o.wrappedKeys === "object";
  } catch {
    return false;
  }
}

/** Encrypt `plaintext` for every key in `recipientEncPubKeys` plus the sender's own key. */
export async function encryptV2Package(
  plaintext: string,
  recipientEncPubKeys: string[],
  senderEncPubKey: string,
): Promise<string> {
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const contentKey = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, contentKey, buf(new TextEncoder().encode(plaintext)));

  const wrappedKeys: Record<string, V2WrappedKey> = {};
  for (const encPubKey of [...new Set([...recipientEncPubKeys, senderEncPubKey])]) {
    if (!encPubKey) continue;
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromHex(encPubKey));
    const key = await wrapKey(sharedSecret, "encrypt");
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedCek = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(wrapIv) }, key, buf(cek));
    wrappedKeys[encPubKey] = {
      kemCipherText: toHex(cipherText),
      wrappedCek: toHex(new Uint8Array(wrappedCek)),
      wrappedIv: toHex(wrapIv),
    };
  }

  const pkg: V2Package = { version: 2, iv: toHex(iv), encryptedContent: toHex(new Uint8Array(encrypted)), wrappedKeys };
  return JSON.stringify(pkg);
}

/** Encrypt for a group and sign the package (ML-DSA-65 over the package JSON, as Qwalla does). */
export async function encryptAndSignV2(
  plaintext: string,
  recipientEncPubKeys: string[],
  senderEncPubKey: string,
  senderSigningPrivateKey: string,
): Promise<{ encryptedPackage: string; signature: string }> {
  const encryptedPackage = await encryptV2Package(plaintext, recipientEncPubKeys, senderEncPubKey);
  const signature = ml_dsa65.sign(new TextEncoder().encode(encryptedPackage), fromHex(senderSigningPrivateKey));
  return { encryptedPackage, signature: toHex(signature) };
}

/** Decrypt a v2 package with my encryption keypair (my public key selects my wrapped CEK). */
export async function decryptV2Package(encryptedPackage: string, myEncPrivKey: string, myEncPubKey: string): Promise<string> {
  const pkg = JSON.parse(encryptedPackage) as V2Package;
  const mine = pkg.wrappedKeys?.[myEncPubKey];
  if (!mine) throw new Error("No wrapped key for this recipient");
  const sharedSecret = ml_kem768.decapsulate(fromHex(mine.kemCipherText), fromHex(myEncPrivKey));
  const key = await wrapKey(sharedSecret, "decrypt");
  const cek = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromHex(mine.wrappedIv)) }, key, buf(fromHex(mine.wrappedCek)));
  const contentKey = await crypto.subtle.importKey("raw", new Uint8Array(cek), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromHex(pkg.iv)) }, contentKey, buf(fromHex(pkg.encryptedContent)));
  return new TextDecoder().decode(pt);
}

/** Verify the ML-DSA-65 signature over a package; false on any error. */
export function verifyPackageSignature(encryptedPackage: string, signatureHex: string, signerSigningPubKey: string): boolean {
  if (!signatureHex || !signerSigningPubKey) return false;
  try {
    return ml_dsa65.verify(fromHex(signatureHex), new TextEncoder().encode(encryptedPackage), fromHex(signerSigningPubKey));
  } catch {
    return false;
  }
}
