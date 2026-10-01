// Release signing keys: Ed25519 (node:crypto) + ML-DSA-65 (@noble/post-quantum).
//
// Public key files (committed under releases/keys/):
//   release-ed25519.pub.pem   standard SPKI PEM — usable directly with `openssl pkeyutl -verify`
//   release-mldsa65.pub       one line: hex of the raw 1952-byte ML-DSA-65 (FIPS 204) public key
// Signature files (next to the manifest):
//   <manifest>.ed25519.sig    base64 of the raw 64-byte Ed25519 signature
//   <manifest>.mldsa65.sig    base64 of the raw 3309-byte ML-DSA-65 signature (empty context)
// Private keys live ONLY in an encrypted key file on the release owner's machine
// (scrypt + AES-256-GCM); they are never written in plaintext.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

export const ED25519_SIG_LEN = 64;
export const MLDSA65_PUB_LEN = 1952;
export const MLDSA65_SIG_LEN = 3309;
export const ED25519_SIG_SUFFIX = '.ed25519.sig';
export const MLDSA65_SIG_SUFFIX = '.mldsa65.sig';
export const ED25519_PUB_FILE = 'release-ed25519.pub.pem';
export const MLDSA65_PUB_FILE = 'release-mldsa65.pub';

const KEYFILE_FORMAT = 'rougechain-release-signing-keys';
const KEYFILE_VERSION = 1;
// scrypt cost: N = 2^17, r = 8, p = 1 (~128 MiB, well under a second on a laptop).
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// ── public keys ──────────────────────────────────────────────────────────────

/** Raw 32-byte Ed25519 public key from an SPKI PEM. Throws on anything that is not Ed25519. */
export function ed25519RawFromPem(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key is not Ed25519');
  const der = key.export({ type: 'spki', format: 'der' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) {
    throw new Error('unexpected Ed25519 SPKI encoding');
  }
  return Buffer.from(der.subarray(12));
}

export function ed25519PemFromRaw(raw) {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const der = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' });
}

/** Parse the release-mldsa65.pub file (hex, optional `#` comment lines). */
export function mldsa65PubFromFile(text) {
  const hex = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join('');
  if (!/^[0-9a-f]+$/.test(hex) || hex.length !== MLDSA65_PUB_LEN * 2) {
    throw new Error(`ML-DSA-65 public key must be ${MLDSA65_PUB_LEN} bytes of lowercase hex`);
  }
  return Buffer.from(hex, 'hex');
}

/** Fingerprint = SHA-256 of the RAW public key bytes, lowercase hex. */
export const fingerprint = (rawPub) => sha256hex(rawPub);

// ── key generation + encrypted key file ──────────────────────────────────────

export function generateKeys() {
  const ed = generateKeyPairSync('ed25519');
  const edPubPem = ed.publicKey.export({ type: 'spki', format: 'pem' });
  const edPrivPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const mldsaSeed = randomBytes(32);
  const ml = ml_dsa65.keygen(mldsaSeed);
  return {
    secret: { ed25519_pkcs8_pem: edPrivPem, mldsa65_seed_hex: mldsaSeed.toString('hex') },
    public: publicInfo(edPubPem, Buffer.from(ml.publicKey)),
  };
}

function publicInfo(edPubPem, mldsaPub) {
  const edRaw = ed25519RawFromPem(edPubPem);
  return {
    ed25519_pem: edPubPem,
    ed25519_raw_b64: edRaw.toString('base64'),
    ed25519_fingerprint: fingerprint(edRaw),
    mldsa65_hex: mldsaPub.toString('hex'),
    mldsa65_fingerprint: fingerprint(mldsaPub),
  };
}

function deriveKey(passphrase, salt, params) {
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r,
  });
}

/** Encrypt the secret keys with a passphrase. Returns the key-file JSON text. */
export function encryptKeyFile(keys, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('passphrase must be at least 12 characters');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = {
    format: KEYFILE_FORMAT,
    version: KEYFILE_VERSION,
    created: new Date().toISOString(),
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') },
    public: keys.public,
  };
  const key = deriveKey(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // The header (incl. the public keys and KDF parameters) is authenticated as AAD.
  cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(keys.secret), 'utf8'), cipher.final()]);
  return (
    JSON.stringify({ ...header, ciphertext: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, null, 2) +
    '\n'
  );
}

/** Decrypt a key file. Throws a generic error on a wrong passphrase or a modified file. */
export function decryptKeyFile(text, passphrase) {
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error('key file is not valid JSON');
  }
  if (f.format !== KEYFILE_FORMAT || f.version !== KEYFILE_VERSION) throw new Error('not a RougeChain release key file (format/version)');
  if (f.kdf?.name !== 'scrypt' || f.cipher?.name !== 'aes-256-gcm') throw new Error('unsupported key file KDF/cipher');
  const { ciphertext, tag, ...header } = f;
  const { N, r, p } = f.kdf;
  if (!Number.isInteger(N) || N < 1 << 15 || N > 1 << 22 || r !== 8 || p !== 1) throw new Error('key file has unacceptable scrypt parameters');
  const key = deriveKey(passphrase, Buffer.from(f.kdf.salt, 'base64'), { N, r, p });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(f.cipher.iv, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let secret;
  try {
    secret = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('could not decrypt the key file: wrong passphrase, or the file was modified');
  }
  // Re-derive the public keys from the secrets and require them to match the (authenticated) header.
  const edPubPem = createPublicKey(createPrivateKey(secret.ed25519_pkcs8_pem)).export({ type: 'spki', format: 'pem' });
  const ml = ml_dsa65.keygen(Buffer.from(secret.mldsa65_seed_hex, 'hex'));
  const pub = publicInfo(edPubPem, Buffer.from(ml.publicKey));
  if (pub.ed25519_raw_b64 !== f.public.ed25519_raw_b64 || pub.mldsa65_hex !== f.public.mldsa65_hex) {
    throw new Error('key file public keys do not match its private keys');
  }
  return { secret, public: pub };
}

// ── sign / verify ────────────────────────────────────────────────────────────

/** Sign exact bytes with both keys. Returns base64 signatures. */
export function signBytes(bytes, secret) {
  const ed = edSign(null, bytes, createPrivateKey(secret.ed25519_pkcs8_pem));
  const ml = ml_dsa65.keygen(Buffer.from(secret.mldsa65_seed_hex, 'hex'));
  const pq = ml_dsa65.sign(bytes, ml.secretKey);
  return { ed25519_b64: Buffer.from(ed).toString('base64'), mldsa65_b64: Buffer.from(pq).toString('base64') };
}

/** Strictly decode a signature file: one base64 line of exactly `len` bytes. */
export function decodeSigFile(text, len, label) {
  const b64 = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error(`${label}: not base64`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('base64') !== b64) throw new Error(`${label}: not canonical base64`);
  if (buf.length !== len) throw new Error(`${label}: expected ${len} bytes, got ${buf.length}`);
  return buf;
}

export function verifyEd25519(bytes, sig, pubPem) {
  ed25519RawFromPem(pubPem); // type check
  return edVerify(null, bytes, createPublicKey(pubPem), sig);
}

export function verifyMldsa65(bytes, sig, pubRaw) {
  try {
    return ml_dsa65.verify(sig, bytes, pubRaw) === true;
  } catch {
    return false;
  }
}
