#!/usr/bin/env node
// Embed the committed release public keys in scripts/install-validator.sh.
//
//   node embed-installer-key.mjs [--key releases/keys/release-ed25519.pub.pem]
//                                [--mldsa-key releases/keys/release-mldsa65.pub]
//                                [--installer scripts/install-validator.sh] [--rotate]
//
// Rewrites exactly two lines of the installer:
//   RELEASE_ED25519_PUBKEY_B64="…"   the raw 32-byte Ed25519 key, base64  (checked with OpenSSL)
//   RELEASE_MLDSA65_PUBKEY_HEX="…"   the raw 1952-byte ML-DSA-65 key, hex (checked with the
//                                    installed `rougechain release verify`)
// Replacing an already-embedded real key (a key rotation) requires --rotate.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, parseArgs } from './lib/cli.mjs';
import { ED25519_PUB_FILE, MLDSA65_PUB_FILE, ed25519RawFromPem, fingerprint, mldsa65PubFromFile } from './lib/keys.mjs';
import { INSTALLER_KEY_RE, INSTALLER_MLDSA_KEY_RE, INSTALLER_PLACEHOLDER } from './verify-manifest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let args;
try {
  args = parseArgs(process.argv.slice(2), { key: 'string', 'mldsa-key': 'string', installer: 'string', rotate: 'boolean', help: 'boolean' });
} catch (e) {
  die(e.message);
}
if (args.help) {
  process.stdout.write('usage: node embed-installer-key.mjs [--key <ed25519.pub.pem>] [--mldsa-key <mldsa65.pub>] [--installer <install-validator.sh>] [--rotate]\n');
  process.exit(0);
}
const keyPath = resolve(args.key ?? join(REPO_ROOT, 'releases', 'keys', ED25519_PUB_FILE));
const mlKeyPath = resolve(args['mldsa-key'] ?? join(REPO_ROOT, 'releases', 'keys', MLDSA65_PUB_FILE));
const installer = resolve(args.installer ?? join(REPO_ROOT, 'scripts', 'install-validator.sh'));
for (const p of [keyPath, mlKeyPath]) if (!existsSync(p)) die(`${p}: not found — run keygen.mjs with --pub-dir releases/keys first`);
if (!existsSync(installer)) die(`${installer}: not found`);

let edRaw;
let mlRaw;
try {
  edRaw = ed25519RawFromPem(readFileSync(keyPath, 'utf8'));
} catch (e) {
  die(`${keyPath}: ${e.message}`);
}
try {
  mlRaw = mldsa65PubFromFile(readFileSync(mlKeyPath, 'utf8'));
} catch (e) {
  die(`${mlKeyPath}: ${e.message}`);
}

const KEYS = [
  { what: 'Ed25519', name: 'RELEASE_ED25519_PUBKEY_B64', re: INSTALLER_KEY_RE, value: edRaw.toString('base64'), fpr: fingerprint(edRaw) },
  { what: 'ML-DSA-65', name: 'RELEASE_MLDSA65_PUBKEY_HEX', re: INSTALLER_MLDSA_KEY_RE, value: mlRaw.toString('hex'), fpr: fingerprint(mlRaw) },
];

let text = readFileSync(installer, 'utf8');
// Check everything first, write once: the installer never ends up with one key rotated and one not.
for (const k of KEYS) {
  const m = k.re.exec(text);
  if (!m) die(`${installer}: ${k.name}="…" line not found`);
  if (text.match(new RegExp(k.re.source, 'gm')).length !== 1) die(`${installer}: more than one ${k.name} line`);
  k.current = m[1];
  if (k.current !== k.value && k.current !== INSTALLER_PLACEHOLDER && !args.rotate) {
    die(`${installer} already embeds a different ${k.what} release key — pass --rotate to replace it (existing installs keep trusting the old key until they fetch the new installer)`);
  }
}
let changed = false;
for (const k of KEYS) {
  if (k.current === k.value) {
    process.stdout.write(`${installer}: already embeds this ${k.what} key (${k.fpr})\n`);
    continue;
  }
  text = text.replace(k.re, `${k.name}="${k.value}"`);
  changed = true;
  process.stdout.write(`${installer}: embedded ${k.what} release key, fingerprint ${k.fpr}\n`);
}
if (changed) writeFileSync(installer, text);
