#!/usr/bin/env node
// Verify a release manifest: schema + BOTH detached signatures (Ed25519 and ML-DSA-65) against
// the committed public keys, and optionally the binary / genesis files it describes.
//
//   node verify-manifest.mjs releases/manifest-mainnet.json
//   node verify-manifest.mjs --binary /srv/rougechain-releases/<file> releases/manifest-mainnet.json
//
// Exit codes (gate on them):
//   0  VERIFIED — schema valid, both signatures valid, every file given matches
//   1  INVALID  — anything wrong (bad schema, bad/missing/garbage signature, wrong key, file mismatch)
//   2  UNSIGNED — schema valid but there are no signature files
// --allow-unsigned turns exit 2 into exit 0, but ONLY while the release keys are not provisioned
// (no public key files in the keys directory). Once keys exist, a manifest without signatures
// is INVALID, with or without the flag.
//
// --keys-dir <dir>        public keys (default: <repo>/releases/keys)
// --binary <file>         check sha256 + size of the binary against the manifest
// --cli <file>            check sha256 + size of the rougechain CLI against the manifest
// --genesis <file>        check sha256 + size of the genesis file against the manifest
// --network <name>        require the manifest to be for this network
// --check-installer <sh>  require the Ed25519 key embedded in install-validator.sh to equal the
//                         committed one (or to be the placeholder while keys are not provisioned)
// --allow-http            accept http:// URLs in the manifest (tests only)
// --quiet                 print only the verdict line

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/cli.mjs';
import {
  ED25519_PUB_FILE,
  ED25519_SIG_LEN,
  ED25519_SIG_SUFFIX,
  MLDSA65_PUB_FILE,
  MLDSA65_SIG_LEN,
  MLDSA65_SIG_SUFFIX,
  decodeSigFile,
  ed25519RawFromPem,
  fingerprint,
  mldsa65PubFromFile,
  verifyEd25519,
  verifyMldsa65,
} from './lib/keys.mjs';
import { checkFileAgainst, parseManifestBytes, summarize, validateManifest } from './lib/manifest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const INSTALLER_PLACEHOLDER = 'PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED';
export const INSTALLER_KEY_RE = /^RELEASE_ED25519_PUBKEY_B64="([^"]*)"$/m;

/**
 * Verify. Returns { status: 'verified' | 'unsigned' | 'invalid', problems: string[], manifest, info: string[] }.
 */
export async function verifyManifest(manifestPath, opts = {}) {
  const keysDir = opts.keysDir ?? join(REPO_ROOT, 'releases', 'keys');
  const problems = [];
  const info = [];
  const result = (status, manifest = null) => ({ status, problems, manifest, info });

  if (!existsSync(manifestPath)) {
    problems.push(`${manifestPath}: not found`);
    return result('invalid');
  }
  const bytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = parseManifestBytes(bytes);
  } catch (e) {
    problems.push(e.message);
    return result('invalid');
  }
  problems.push(...validateManifest(manifest, { allowHttp: opts.allowHttp === true }));
  if (problems.length) return result('invalid', manifest);
  if (opts.network && manifest.network !== opts.network) problems.push(`network: manifest is for ${manifest.network}, expected ${opts.network}`);

  // ── keys ──
  const edPubPath = join(keysDir, ED25519_PUB_FILE);
  const mlPubPath = join(keysDir, MLDSA65_PUB_FILE);
  const haveEdPub = existsSync(edPubPath);
  const haveMlPub = existsSync(mlPubPath);
  const keysProvisioned = haveEdPub || haveMlPub;
  let edPubPem = null;
  let mlPub = null;
  if (keysProvisioned) {
    if (!haveEdPub) problems.push(`${edPubPath}: missing (ML-DSA-65 key is present; both are required)`);
    if (!haveMlPub) problems.push(`${mlPubPath}: missing (Ed25519 key is present; both are required)`);
    try {
      if (haveEdPub) {
        edPubPem = readFileSync(edPubPath, 'utf8');
        info.push(`Ed25519 key   ${fingerprint(ed25519RawFromPem(edPubPem))}`);
      }
    } catch (e) {
      problems.push(`${edPubPath}: ${e.message}`);
      edPubPem = null;
    }
    try {
      if (haveMlPub) {
        mlPub = mldsa65PubFromFile(readFileSync(mlPubPath, 'utf8'));
        info.push(`ML-DSA-65 key ${fingerprint(mlPub)}`);
      }
    } catch (e) {
      problems.push(`${mlPubPath}: ${e.message}`);
      mlPub = null;
    }
  }

  // ── installer key consistency ──
  if (opts.checkInstaller) {
    const m = existsSync(opts.checkInstaller) ? INSTALLER_KEY_RE.exec(readFileSync(opts.checkInstaller, 'utf8')) : null;
    if (!m) problems.push(`${opts.checkInstaller}: RELEASE_ED25519_PUBKEY_B64="…" line not found`);
    else if (edPubPem) {
      if (m[1] !== ed25519RawFromPem(edPubPem).toString('base64')) {
        problems.push(`${opts.checkInstaller}: embedded Ed25519 key does not match ${edPubPath} (run embed-installer-key.mjs)`);
      }
    } else if (m[1] !== INSTALLER_PLACEHOLDER) {
      problems.push(`${opts.checkInstaller}: embeds a release key but ${edPubPath} is not committed`);
    }
  }

  // ── files described by the manifest ──
  if (opts.binary) problems.push(...(await checkFileAgainst(manifest.binary, opts.binary, 'binary')));
  if (opts.cli) {
    if (manifest.cli === null) problems.push('cli: a file was given but the manifest has no cli');
    else problems.push(...(await checkFileAgainst(manifest.cli, opts.cli, 'cli')));
  }
  if (opts.genesis) {
    if (manifest.genesis === null) problems.push('genesis: a file was given but the manifest has no genesis');
    else problems.push(...(await checkFileAgainst(manifest.genesis, opts.genesis, 'genesis')));
  }

  // ── signatures ──
  const edSigPath = manifestPath + ED25519_SIG_SUFFIX;
  const mlSigPath = manifestPath + MLDSA65_SIG_SUFFIX;
  const haveEdSig = existsSync(edSigPath);
  const haveMlSig = existsSync(mlSigPath);

  if (!haveEdSig && !haveMlSig) {
    if (keysProvisioned) {
      problems.push(`no signature files (${ED25519_SIG_SUFFIX}, ${MLDSA65_SIG_SUFFIX}) — release keys are provisioned, so a manifest must be signed`);
      return result('invalid', manifest);
    }
    return result(problems.length ? 'invalid' : 'unsigned', manifest);
  }
  if (!keysProvisioned) {
    problems.push(`signature file(s) present but no public keys in ${keysDir} to verify them with`);
    return result('invalid', manifest);
  }

  // Each signature is independently required.
  if (!haveEdSig) problems.push(`${edSigPath}: missing (the Ed25519 signature is required)`);
  else if (edPubPem) {
    try {
      const sig = decodeSigFile(readFileSync(edSigPath, 'utf8'), ED25519_SIG_LEN, 'Ed25519 signature');
      if (!verifyEd25519(bytes, sig, edPubPem)) problems.push('Ed25519 signature: does NOT verify against the release key');
      else info.push('Ed25519 signature   OK');
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (!haveMlSig) problems.push(`${mlSigPath}: missing (the ML-DSA-65 signature is required)`);
  else if (mlPub) {
    try {
      const sig = decodeSigFile(readFileSync(mlSigPath, 'utf8'), MLDSA65_SIG_LEN, 'ML-DSA-65 signature');
      if (!verifyMldsa65(bytes, sig, mlPub)) problems.push('ML-DSA-65 signature: does NOT verify against the release key');
      else info.push('ML-DSA-65 signature OK');
    } catch (e) {
      problems.push(e.message);
    }
  }
  return result(problems.length ? 'invalid' : 'verified', manifest);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), {
      'keys-dir': 'string',
      binary: 'string',
      cli: 'string',
      genesis: 'string',
      network: 'string',
      'check-installer': 'string',
      'allow-unsigned': 'boolean',
      'allow-http': 'boolean',
      quiet: 'boolean',
      help: 'boolean',
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  if (args.help || args._.length !== 1) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 24).join('\n') + '\n');
    process.exit(args.help ? 0 : 1);
  }
  const manifestPath = resolve(args._[0]);
  const r = await verifyManifest(manifestPath, {
    keysDir: args['keys-dir'] ? resolve(args['keys-dir']) : undefined,
    binary: args.binary,
    cli: args.cli,
    genesis: args.genesis,
    network: args.network,
    checkInstaller: args['check-installer'],
    allowHttp: args['allow-http'] === true,
  });
  const say = (s) => process.stdout.write(s + '\n');
  if (!args.quiet && r.manifest && r.status !== 'invalid') say(summarize(r.manifest));
  if (!args.quiet) for (const i of r.info) say(`  ${i}`);
  if (r.status === 'verified') {
    say(`VERIFIED: ${manifestPath}`);
    process.exit(0);
  }
  if (r.status === 'unsigned') {
    say(`UNSIGNED: ${manifestPath} — schema valid, no signatures (release keys are not provisioned yet). Do not install from it.`);
    process.exit(args['allow-unsigned'] ? 0 : 2);
  }
  for (const p of r.problems) process.stderr.write(`  ✗ ${p}\n`);
  process.stderr.write(`INVALID: ${manifestPath}\n`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  });
}
