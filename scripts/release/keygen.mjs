#!/usr/bin/env node
// Generate the RougeChain release signing keys (Ed25519 + ML-DSA-65).
//
// Run ONCE, on the release owner's own machine — never on a server. The private keys are
// written only inside a passphrase-encrypted key file (scrypt + AES-256-GCM).
//
//   node keygen.mjs --out ~/rougechain-release-keys.json [--pub-dir <dir>]
//
// --out        encrypted key file to create (refuses to overwrite)
// --pub-dir    also write release-ed25519.pub.pem + release-mldsa65.pub there
//              (use <repo>/releases/keys to publish them; refuses to overwrite)
// Passphrase: hidden prompt, or --passphrase-file <path>, or RELEASE_KEY_PASSPHRASE.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { die, getPassphrase, parseArgs } from './lib/cli.mjs';
import { ED25519_PUB_FILE, MLDSA65_PUB_FILE, encryptKeyFile, generateKeys } from './lib/keys.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2), { out: 'string', 'pub-dir': 'string', 'passphrase-file': 'string', help: 'boolean' });
  if (args.help || !args.out) {
    process.stdout.write('usage: node keygen.mjs --out <encrypted-key-file> [--pub-dir <dir>] [--passphrase-file <path>]\n');
    process.exit(args.help ? 0 : 1);
  }
  const out = resolve(args.out);
  if (existsSync(out)) die(`${out} already exists — refusing to overwrite a key file`);
  const pubDir = args['pub-dir'] ? resolve(args['pub-dir']) : null;
  const pubFiles = pubDir ? [join(pubDir, ED25519_PUB_FILE), join(pubDir, MLDSA65_PUB_FILE)] : [];
  for (const f of pubFiles) if (existsSync(f)) die(`${f} already exists — refusing to replace a published release key`);

  const passphrase = await getPassphrase(args, { confirm: true });
  const keys = generateKeys();
  const text = encryptKeyFile(keys, passphrase);
  // wx: fail if the file appeared meanwhile; 0600: owner-only.
  writeFileSync(out, text, { flag: 'wx', mode: 0o600 });

  if (pubDir) {
    mkdirSync(pubDir, { recursive: true });
    writeFileSync(pubFiles[0], keys.public.ed25519_pem, { flag: 'wx' });
    writeFileSync(pubFiles[1], keys.public.mldsa65_hex + '\n', { flag: 'wx' });
  }

  const p = keys.public;
  process.stdout.write(
    [
      `Encrypted key file written: ${out}`,
      '  Keep it (and the passphrase) on your own machine and in an offline backup.',
      '  Never copy it to a server or into the repository.',
      '',
      'Public keys',
      `  Ed25519   fingerprint (sha256 of the raw 32-byte key):   ${p.ed25519_fingerprint}`,
      `            raw key, base64 (installer constant):          ${p.ed25519_raw_b64}`,
      `  ML-DSA-65 fingerprint (sha256 of the raw 1952-byte key): ${p.mldsa65_fingerprint}`,
      pubDir ? `  written to ${pubDir}/` : '  (print them again any time with: node sign-manifest.mjs --key <file> --show-public)',
      '',
      'Next: commit the public keys under releases/keys/, record both fingerprints in',
      'releases/keys/README.md, and embed the Ed25519 key in the installer:',
      '  node scripts/release/embed-installer-key.mjs',
      '',
    ].join('\n'),
  );
}

main().catch((e) => die(e.message));
