#!/usr/bin/env node
// Build a release manifest (schema 1) for one network. Runs where the binary was built.
//
//   node make-manifest.mjs --network mainnet --version 1.6.0 \
//     --binary /srv/rougechain-releases/quantum-vault-daemon-mint-royalty-03613ef \
//     --cli /home/cyberdreadx/rougechain-releases/03613ef/rougechain \
//     --source-commit 03613ef --public-commit e048bf1 \
//     --genesis core/daemon/genesis-mainnet.json \
//     --mandatory --upgrade-before-height 235 \
//     --activation token_minting=235 --activation contract_nft_royalty=235 \
//     --notes-url https://docs.rougechain.io/running-a-node/mandatory-upgrade-2026-10.html
//
// --cli <file> adds the `rougechain` CLI built from the same commit (or pass --no-cli).
// --installer <file> adds scripts/install-validator.sh as the release's installer/updater: nodes
// with auto-update replace their installed updater ONLY with the file named in a signed manifest.
// Published name: install-validator-<its version>-<sha256[0:8]>.sh (or --installer-name).
// --binary-mirror / --cli-mirror / --genesis-mirror / --installer-mirror <url> (repeatable) add download mirrors, e.g.
// GitHub release assets: https://github.com/cyberdreadx/rougechain-node/releases/download/v<version>/<name>
//
// Writes releases/manifest-<network>.json (or --out). Refuses to overwrite an existing manifest
// unless --force is given, and --force also requires that no signature files are left next to it
// (a changed manifest invalidates them — delete them first).
//
// Every option can also come from the environment as RELEASE_<OPTION> (upper-case, `-` → `_`),
// e.g. RELEASE_VERSION=1.6.0. Command-line options win.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, parseArgs } from './lib/cli.mjs';
import { ED25519_SIG_SUFFIX, MLDSA65_SIG_SUFFIX } from './lib/keys.mjs';
import { NETWORKS, SCHEMA, compareVersions, serializeManifest, sha256File, summarize, validateManifest } from './lib/manifest.mjs';
import { INSTALLER_KEY_RE, INSTALLER_MLDSA_KEY_RE, INSTALLER_PLACEHOLDER, INSTALLER_VERSION_RE } from './verify-manifest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRIMARY_BASE = 'https://api.rougechain.io/releases';
const GENESIS_MIRROR_BASE = 'https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/core/daemon';
/** Oldest installer that understands this manifest layout. */
const DEFAULT_MIN_INSTALLER = '2.0.0';

const SPEC = {
  network: 'string',
  version: 'string',
  released: 'string',
  binary: 'string',
  'binary-name': 'string',
  'binary-url': 'string',
  'binary-mirror': 'list',
  cli: 'string',
  'cli-name': 'string',
  'cli-url': 'string',
  'cli-mirror': 'list',
  'no-cli': 'boolean',
  'source-commit': 'string',
  'public-commit': 'string',
  genesis: 'string',
  'genesis-url': 'string',
  'genesis-mirror': 'list',
  'no-genesis': 'boolean',
  installer: 'string',
  'installer-name': 'string',
  'installer-url': 'string',
  'installer-mirror': 'list',
  mandatory: 'boolean',
  'upgrade-before-height': 'string',
  activation: 'list',
  'notes-url': 'string',
  'min-installer-version': 'string',
  out: 'string',
  force: 'boolean',
  'allow-http': 'boolean',
  help: 'boolean',
};

function withEnv(args) {
  for (const [name, type] of Object.entries(SPEC)) {
    if (['help', 'force', 'allow-http', 'out'].includes(name)) continue;
    const v = process.env[`RELEASE_${name.toUpperCase().replaceAll('-', '_')}`];
    if (v === undefined || v === '') continue;
    if (type === 'list') {
      if (args[name].length === 0) args[name] = v.split(/[\s,]+/).filter(Boolean);
    } else if (type === 'boolean') {
      if (args[name] === undefined) args[name] = v === '1' || v === 'true';
    } else if (args[name] === undefined) args[name] = v;
  }
  return args;
}

const toInt = (s, what) => {
  if (!/^(0|[1-9]\d*)$/.test(String(s))) die(`${what}: "${s}" is not a non-negative integer`);
  return Number(s);
};

async function fileEntry(path, name, url, mirrors) {
  if (!existsSync(path) || !statSync(path).isFile()) die(`${path}: not a file`);
  return { name, url, mirrors, sha256: await sha256File(path), size: statSync(path).size };
}

async function main() {
  let args;
  try {
    args = withEnv(parseArgs(process.argv.slice(2), SPEC));
  } catch (e) {
    die(e.message);
  }
  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 28).join('\n') + '\n');
    return;
  }
  for (const req of ['network', 'version', 'binary', 'source-commit']) if (!args[req]) die(`--${req} is required`);
  if (!Object.hasOwn(NETWORKS, args.network)) die(`--network must be one of ${Object.keys(NETWORKS).join(', ')}`);
  if (args.genesis && args['no-genesis']) die('--genesis and --no-genesis are mutually exclusive');
  if (!args.genesis && !args['no-genesis']) die('pass --genesis <file>, or --no-genesis if the network runs on default parameters');
  if (args.cli && args['no-cli']) die('--cli and --no-cli are mutually exclusive');
  if (!args.cli && !args['no-cli']) die('pass --cli <file> (the rougechain CLI built from the same commit), or --no-cli to ship a release without it');

  const binaryName = args['binary-name'] ?? basename(args.binary);
  const binary = await fileEntry(
    args.binary,
    binaryName,
    args['binary-url'] ?? `${PRIMARY_BASE}/${binaryName}`,
    args['binary-mirror'],
  );
  let cli = null;
  if (args.cli) {
    // Default published name: rougechain-<source commit>, next to the daemon binary.
    const cliName = args['cli-name'] ?? `rougechain-${args['source-commit']}`;
    cli = await fileEntry(args.cli, cliName, args['cli-url'] ?? `${PRIMARY_BASE}/${cliName}`, args['cli-mirror']);
    if (cli.sha256 === binary.sha256) die('--cli and --binary are the same file');
  }
  let genesis = null;
  if (args.genesis) {
    const gName = basename(args.genesis);
    genesis = await fileEntry(
      args.genesis,
      gName,
      args['genesis-url'] ?? `${PRIMARY_BASE}/${gName}`,
      args['genesis-mirror'].length ? args['genesis-mirror'] : [`${GENESIS_MIRROR_BASE}/${gName}`],
    );
    // A genesis for the wrong chain would be a silent, expensive mistake.
    let chainId;
    try {
      chainId = JSON.parse(readFileSync(args.genesis, 'utf8')).chain_id;
    } catch (e) {
      die(`${args.genesis}: not valid JSON (${e.message})`);
    }
    if (chainId !== NETWORKS[args.network].chain_id) {
      die(`${args.genesis}: chain_id "${chainId}" does not match network ${args.network} (${NETWORKS[args.network].chain_id})`);
    }
  }

  // Optional: the installer/updater script. Without it the manifest simply has no `installer` key.
  let installer = null;
  const minInstaller = args['min-installer-version'] ?? DEFAULT_MIN_INSTALLER;
  if (args.installer) {
    if (!existsSync(args.installer) || !statSync(args.installer).isFile()) die(`${args.installer}: not a file`);
    const text = readFileSync(args.installer, 'utf8');
    const v = INSTALLER_VERSION_RE.exec(text);
    if (!v) die(`${args.installer}: no INSTALLER_VERSION="x.y.z" line — is this scripts/install-validator.sh?`);
    if (/^\d+\.\d+\.\d+$/.test(minInstaller) && compareVersions(v[1], minInstaller) < 0) {
      die(`${args.installer} is v${v[1]}, older than --min-installer-version ${minInstaller}`);
    }
    for (const [re, what] of [[INSTALLER_KEY_RE, 'Ed25519'], [INSTALLER_MLDSA_KEY_RE, 'ML-DSA-65']]) {
      const k = re.exec(text);
      if (!k) die(`${args.installer}: no embedded ${what} release key line`);
      if (k[1] === INSTALLER_PLACEHOLDER) die(`${args.installer}: the ${what} release key is still the placeholder (run embed-installer-key.mjs)`);
    }
    const sha = await sha256File(args.installer);
    const iName = args['installer-name'] ?? `install-validator-${v[1]}-${sha.slice(0, 8)}.sh`;
    installer = await fileEntry(args.installer, iName, args['installer-url'] ?? `${PRIMARY_BASE}/${iName}`, args['installer-mirror']);
  } else if (args['installer-name'] || args['installer-url'] || args['installer-mirror'].length) {
    die('--installer-name / --installer-url / --installer-mirror need --installer <file>');
  }

  const activations = args.activation.map((a) => {
    const m = /^([^=]+)=(.+)$/.exec(a);
    if (!m) die(`--activation "${a}": expected name=height`);
    return { name: m[1], height: toInt(m[2], `--activation ${m[1]}`) };
  });

  const manifest = {
    schema: SCHEMA,
    network: args.network,
    chain_id: NETWORKS[args.network].chain_id,
    version: args.version,
    released: args.released ?? new Date().toISOString().slice(0, 10),
    source_commit: args['source-commit'],
    public_commit: args['public-commit'] ?? null,
    binary,
    cli,
    genesis,
    ...(installer ? { installer } : {}),
    mandatory: args.mandatory === true,
    upgrade_before_height: args['upgrade-before-height'] === undefined ? null : toInt(args['upgrade-before-height'], '--upgrade-before-height'),
    activations,
    notes_url: args['notes-url'] ?? null,
    min_installer_version: minInstaller,
  };

  const errors = validateManifest(manifest, { allowHttp: args['allow-http'] === true });
  if (errors.length) die(`manifest is invalid:\n  ${errors.join('\n  ')}`);
  if (manifest.mandatory && manifest.upgrade_before_height === null) {
    process.stderr.write('warning: --mandatory without --upgrade-before-height\n');
  }
  if (!installer) {
    process.stderr.write('note: no --installer — nodes with auto-update keep the updater they have, and a node installed by piping the installer cannot enable auto-update from this release\n');
  }

  const out = resolve(args.out ?? join(REPO_ROOT, 'releases', `manifest-${args.network}.json`));
  const sigs = [out + ED25519_SIG_SUFFIX, out + MLDSA65_SIG_SUFFIX].filter((f) => existsSync(f));
  if (existsSync(out) && !args.force) die(`${out} already exists — pass --force to replace it`);
  if (sigs.length) die(`signature file(s) exist for ${out}:\n  ${sigs.join('\n  ')}\nA new manifest invalidates them; delete them first.`);

  writeFileSync(out, serializeManifest(manifest));
  process.stdout.write(`Wrote ${out} (UNSIGNED)\n${summarize(manifest)}\n\nNext: sign it on the release owner's machine (sign-manifest.mjs).\n`);
}

main().catch((e) => die(e.message));
