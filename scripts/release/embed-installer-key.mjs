#!/usr/bin/env node
// Embed the committed Ed25519 release public key in scripts/install-validator.sh.
//
//   node embed-installer-key.mjs [--key releases/keys/release-ed25519.pub.pem] [--installer scripts/install-validator.sh]
//
// Rewrites the single line  RELEASE_ED25519_PUBKEY_B64="…"  (the raw 32-byte key, base64).
// Replacing an already-embedded real key (a key rotation) requires --rotate.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, parseArgs } from './lib/cli.mjs';
import { ED25519_PUB_FILE, ed25519RawFromPem, fingerprint } from './lib/keys.mjs';
import { INSTALLER_KEY_RE, INSTALLER_PLACEHOLDER } from './verify-manifest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let args;
try {
  args = parseArgs(process.argv.slice(2), { key: 'string', installer: 'string', rotate: 'boolean', help: 'boolean' });
} catch (e) {
  die(e.message);
}
if (args.help) {
  process.stdout.write('usage: node embed-installer-key.mjs [--key <pub.pem>] [--installer <install-validator.sh>] [--rotate]\n');
  process.exit(0);
}
const keyPath = resolve(args.key ?? join(REPO_ROOT, 'releases', 'keys', ED25519_PUB_FILE));
const installer = resolve(args.installer ?? join(REPO_ROOT, 'scripts', 'install-validator.sh'));
if (!existsSync(keyPath)) die(`${keyPath}: not found — run keygen.mjs with --pub-dir releases/keys first`);
if (!existsSync(installer)) die(`${installer}: not found`);

let raw;
try {
  raw = ed25519RawFromPem(readFileSync(keyPath, 'utf8'));
} catch (e) {
  die(`${keyPath}: ${e.message}`);
}
const b64 = raw.toString('base64');
const text = readFileSync(installer, 'utf8');
const m = INSTALLER_KEY_RE.exec(text);
if (!m) die(`${installer}: RELEASE_ED25519_PUBKEY_B64="…" line not found`);
if (text.match(new RegExp(INSTALLER_KEY_RE.source, 'gm')).length !== 1) die(`${installer}: more than one RELEASE_ED25519_PUBKEY_B64 line`);
if (m[1] === b64) {
  process.stdout.write(`${installer}: already embeds this key (${fingerprint(raw)})\n`);
  process.exit(0);
}
if (m[1] !== INSTALLER_PLACEHOLDER && !args.rotate) {
  die(`${installer} already embeds a different release key — pass --rotate to replace it (existing installs keep trusting the old key until they fetch the new installer)`);
}
writeFileSync(installer, text.replace(INSTALLER_KEY_RE, `RELEASE_ED25519_PUBKEY_B64="${b64}"`));
process.stdout.write(`${installer}: embedded Ed25519 release key, fingerprint ${fingerprint(raw)}\n`);
