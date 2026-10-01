#!/usr/bin/env node
// Sign a release manifest with BOTH release keys. Runs on the release OWNER's machine, offline.
//
//   node sign-manifest.mjs --key ~/rougechain-release-keys.json releases/manifest-mainnet.json
//
// Shows what is about to be signed, asks you to type the version to confirm, decrypts the key
// file with your passphrase, and writes next to the manifest:
//   <manifest>.ed25519.sig   base64, raw 64-byte Ed25519 signature
//   <manifest>.mldsa65.sig   base64, raw 3309-byte ML-DSA-65 signature
// Both signatures cover the exact bytes of the manifest file. Nothing is sent anywhere.
//
// --yes            skip the confirmation prompt (automation/tests)
// --force          replace existing signature files
// --show-public    print the public keys + fingerprints of the key file and exit
// --allow-http     accept http:// URLs in the manifest (tests only)
// Passphrase: hidden prompt, or --passphrase-file <path>, or RELEASE_KEY_PASSPHRASE.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { confirmWord, die, getPassphrase, parseArgs } from './lib/cli.mjs';
import {
  ED25519_SIG_LEN,
  ED25519_SIG_SUFFIX,
  MLDSA65_SIG_LEN,
  MLDSA65_SIG_SUFFIX,
  decodeSigFile,
  decryptKeyFile,
  mldsa65PubFromFile,
  signBytes,
  verifyEd25519,
  verifyMldsa65,
} from './lib/keys.mjs';
import { parseManifestBytes, summarize, validateManifest } from './lib/manifest.mjs';

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), {
      key: 'string',
      'passphrase-file': 'string',
      yes: 'boolean',
      force: 'boolean',
      'show-public': 'boolean',
      'allow-http': 'boolean',
      help: 'boolean',
    });
  } catch (e) {
    die(e.message);
  }
  if (args.help || !args.key || (!args['show-public'] && args._.length !== 1)) {
    process.stdout.write('usage: node sign-manifest.mjs --key <encrypted-key-file> [--yes] [--force] <manifest.json>\n       node sign-manifest.mjs --key <encrypted-key-file> --show-public\n');
    process.exit(args.help ? 0 : 1);
  }
  if (!existsSync(args.key)) die(`${args.key}: key file not found`);
  const keyText = readFileSync(args.key, 'utf8');

  if (args['show-public']) {
    // The public half is stored in clear in the key file header; no passphrase needed.
    const pub = JSON.parse(keyText).public;
    process.stdout.write(
      `Ed25519   fingerprint ${pub.ed25519_fingerprint}\n          raw base64  ${pub.ed25519_raw_b64}\n${pub.ed25519_pem}ML-DSA-65 fingerprint ${pub.mldsa65_fingerprint}\n${pub.mldsa65_hex}\n`,
    );
    return;
  }

  const manifestPath = resolve(args._[0]);
  if (!existsSync(manifestPath)) die(`${manifestPath}: manifest not found`);
  const bytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = parseManifestBytes(bytes);
  } catch (e) {
    die(e.message);
  }
  const errors = validateManifest(manifest, { allowHttp: args['allow-http'] === true });
  if (errors.length) die(`refusing to sign an invalid manifest:\n  ${errors.join('\n  ')}`);

  const edSigPath = manifestPath + ED25519_SIG_SUFFIX;
  const mlSigPath = manifestPath + MLDSA65_SIG_SUFFIX;
  if (!args.force) for (const p of [edSigPath, mlSigPath]) if (existsSync(p)) die(`${p} already exists — pass --force to replace it`);

  process.stderr.write(`\nAbout to sign ${manifestPath}\n${summarize(manifest)}\n\n`);
  if (!args.yes) {
    process.stderr.write('Check the sha256 against your own build record before continuing.\n');
    let ok = false;
    try {
      ok = await confirmWord(`Type the version (${manifest.version}) to sign, anything else to abort: `, manifest.version);
    } catch (e) {
      die(`${e.message} — run interactively, or pass --yes`);
    }
    if (!ok) die('aborted — nothing was signed');
  }

  let keys;
  try {
    keys = decryptKeyFile(keyText, await getPassphrase(args));
  } catch (e) {
    die(e.message);
  }
  const sig = signBytes(bytes, keys.secret);

  // Self-check before writing anything: both signatures must verify against the key file's public keys.
  const edOk = verifyEd25519(bytes, decodeSigFile(sig.ed25519_b64, ED25519_SIG_LEN, 'ed25519'), keys.public.ed25519_pem);
  const mlOk = verifyMldsa65(bytes, decodeSigFile(sig.mldsa65_b64, MLDSA65_SIG_LEN, 'mldsa65'), mldsa65PubFromFile(keys.public.mldsa65_hex));
  if (!edOk || !mlOk) die('internal error: a freshly made signature did not verify — nothing written');

  writeFileSync(edSigPath, sig.ed25519_b64 + '\n');
  writeFileSync(mlSigPath, sig.mldsa65_b64 + '\n');
  process.stdout.write(
    [
      `Signed ${manifestPath}`,
      `  ${edSigPath}`,
      `  ${mlSigPath}`,
      `  Ed25519 key   ${keys.public.ed25519_fingerprint}`,
      `  ML-DSA-65 key ${keys.public.mldsa65_fingerprint}`,
      'Next: put both .sig files next to the manifest in the repo and run verify-manifest.mjs.',
      '',
    ].join('\n'),
  );
}

main().catch((e) => die(e.message));
