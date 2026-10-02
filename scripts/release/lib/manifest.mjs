// Release manifest schema (schema: 1) — shared by make/sign/verify.
//
// The signed object is the manifest FILE: signatures cover its exact bytes, so nothing here
// canonicalises or re-serialises a manifest that is being verified. See
// docs/running-a-node/releases.md for the field reference.

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

export const SCHEMA = 1;

export const NETWORKS = {
  mainnet: { chain_id: 'rougechain-mainnet-1' },
  testnet: { chain_id: 'rougechain-devnet-1' },
};

/** Fixed key order of a schema-1 manifest (also the complete list of allowed top-level keys). */
export const TOP_LEVEL_KEYS = [
  'schema',
  'network',
  'chain_id',
  'version',
  'released',
  'source_commit',
  'public_commit',
  'binary',
  'cli',
  'genesis',
  'mandatory',
  'upgrade_before_height',
  'activations',
  'notes_url',
  'min_installer_version',
];
const FILE_KEYS = ['name', 'url', 'mirrors', 'sha256', 'size'];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIVATION_NAME = /^[a-z0-9][a-z0-9_]{0,63}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHeight = (v) => Number.isSafeInteger(v) && v >= 0;

function checkUrl(errors, where, v, { allowHttp }) {
  if (typeof v !== 'string') {
    errors.push(`${where}: must be a string`);
    return;
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    errors.push(`${where}: not a valid URL`);
    return;
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    errors.push(`${where}: must be an https:// URL`);
  }
  if (/\s/.test(v)) errors.push(`${where}: must not contain whitespace`);
}

function checkFile(errors, where, f, opts) {
  if (!isObj(f)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  for (const k of Object.keys(f)) if (!FILE_KEYS.includes(k)) errors.push(`${where}.${k}: unknown field`);
  for (const k of FILE_KEYS) if (!(k in f)) errors.push(`${where}.${k}: missing`);
  if ('name' in f && (typeof f.name !== 'string' || !FILE_NAME.test(f.name))) {
    errors.push(`${where}.name: must match ${FILE_NAME}`);
  }
  if ('url' in f) checkUrl(errors, `${where}.url`, f.url, opts);
  if ('mirrors' in f) {
    if (!Array.isArray(f.mirrors)) errors.push(`${where}.mirrors: must be an array`);
    else f.mirrors.forEach((m, i) => checkUrl(errors, `${where}.mirrors[${i}]`, m, opts));
  }
  if ('sha256' in f && (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256))) {
    errors.push(`${where}.sha256: must be 64 lowercase hex characters`);
  }
  if ('size' in f && !(Number.isSafeInteger(f.size) && f.size > 0)) {
    errors.push(`${where}.size: must be a positive integer (bytes)`);
  }
}

/**
 * Validate a parsed manifest. Returns a list of problems (empty = valid).
 * `allowHttp` exists only for the test suites (local HTTP servers); never use it for a release.
 */
export function validateManifest(m, { allowHttp = false } = {}) {
  const errors = [];
  if (!isObj(m)) return ['manifest: must be a JSON object'];
  for (const k of Object.keys(m)) if (!TOP_LEVEL_KEYS.includes(k)) errors.push(`${k}: unknown field`);
  for (const k of TOP_LEVEL_KEYS) if (!(k in m)) errors.push(`${k}: missing`);
  if (errors.length) return errors;

  if (m.schema !== SCHEMA) errors.push(`schema: must be ${SCHEMA}`);
  if (!Object.hasOwn(NETWORKS, m.network)) errors.push(`network: must be one of ${Object.keys(NETWORKS).join(', ')}`);
  else if (m.chain_id !== NETWORKS[m.network].chain_id) {
    errors.push(`chain_id: must be ${NETWORKS[m.network].chain_id} for network ${m.network}`);
  }
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) errors.push('version: must be MAJOR.MINOR.PATCH');
  if (typeof m.released !== 'string' || !ISO_DATE.test(m.released) || Number.isNaN(Date.parse(m.released))) {
    errors.push('released: must be an ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)');
  }
  if (typeof m.source_commit !== 'string' || !COMMIT.test(m.source_commit)) {
    errors.push('source_commit: must be a 7-40 character lowercase hex git commit');
  }
  if (m.public_commit !== null && (typeof m.public_commit !== 'string' || !COMMIT.test(m.public_commit))) {
    errors.push('public_commit: must be a 7-40 character lowercase hex git commit, or null');
  }
  checkFile(errors, 'binary', m.binary, { allowHttp });
  if (m.cli !== null) checkFile(errors, 'cli', m.cli, { allowHttp });
  if (isObj(m.cli) && isObj(m.binary) && m.cli.name === m.binary.name) errors.push('cli.name: must differ from binary.name');
  if (m.genesis !== null) checkFile(errors, 'genesis', m.genesis, { allowHttp });
  if (typeof m.mandatory !== 'boolean') errors.push('mandatory: must be true or false');
  if (m.upgrade_before_height !== null && !isHeight(m.upgrade_before_height)) {
    errors.push('upgrade_before_height: must be a non-negative integer or null');
  }
  if (!Array.isArray(m.activations)) errors.push('activations: must be an array');
  else {
    const seen = new Set();
    m.activations.forEach((a, i) => {
      const w = `activations[${i}]`;
      if (!isObj(a)) return errors.push(`${w}: must be an object`);
      for (const k of Object.keys(a)) if (k !== 'name' && k !== 'height') errors.push(`${w}.${k}: unknown field`);
      if (typeof a.name !== 'string' || !ACTIVATION_NAME.test(a.name)) errors.push(`${w}.name: must match ${ACTIVATION_NAME}`);
      else if (seen.has(a.name)) errors.push(`${w}.name: duplicate "${a.name}"`);
      else seen.add(a.name);
      if (!isHeight(a.height)) errors.push(`${w}.height: must be a non-negative integer`);
    });
  }
  if (m.notes_url !== null) checkUrl(errors, 'notes_url', m.notes_url, { allowHttp });
  if (typeof m.min_installer_version !== 'string' || !SEMVER.test(m.min_installer_version)) {
    errors.push('min_installer_version: must be MAJOR.MINOR.PATCH');
  }
  return errors;
}

/** Serialise a manifest object in the fixed key order, 2-space indent, trailing newline. */
export function serializeManifest(m) {
  const file = (f) => (f === null ? null : Object.fromEntries(FILE_KEYS.map((k) => [k, f[k]])));
  const ordered = {};
  for (const k of TOP_LEVEL_KEYS) {
    if (k === 'binary' || k === 'cli' || k === 'genesis') ordered[k] = file(m[k]);
    else if (k === 'activations') ordered[k] = m[k].map((a) => ({ name: a.name, height: a.height }));
    else ordered[k] = m[k];
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Parse manifest bytes strictly: UTF-8, a single JSON object, no duplicate-key ambiguity checks beyond JSON.parse. */
export function parseManifestBytes(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('manifest is not valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`manifest is not valid JSON: ${e.message}`);
  }
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Compare a local file with a manifest file entry. Returns a list of problems. */
export async function checkFileAgainst(entry, path, label) {
  const problems = [];
  let size;
  try {
    size = statSync(path).size;
  } catch (e) {
    return [`${label}: cannot read ${path}: ${e.message}`];
  }
  if (size !== entry.size) problems.push(`${label}: size ${size} != manifest ${entry.size}`);
  const sha = await sha256File(path);
  if (sha !== entry.sha256) problems.push(`${label}: sha256 ${sha} != manifest ${entry.sha256}`);
  return problems;
}

/** Human summary shown before signing and after verifying. */
export function summarize(m) {
  const lines = [
    `  network                ${m.network} (${m.chain_id})`,
    `  version                ${m.version}`,
    `  released               ${m.released}`,
    `  source commit          ${m.source_commit}${m.public_commit ? `  (public ${m.public_commit})` : ''}`,
    `  binary                 ${m.binary.name}`,
    `    sha256               ${m.binary.sha256}`,
    `    size                 ${m.binary.size} bytes`,
    `    url                  ${m.binary.url}`,
    ...m.binary.mirrors.map((u) => `    mirror               ${u}`),
    ...(m.cli
      ? [
          `  cli                    ${m.cli.name}`,
          `    sha256               ${m.cli.sha256}`,
          `    size                 ${m.cli.size} bytes`,
          `    url                  ${m.cli.url}`,
          ...m.cli.mirrors.map((u) => `    mirror               ${u}`),
        ]
      : ['  cli                    none (this release ships no rougechain CLI)']),
    ...(m.genesis
      ? [
          `  genesis                ${m.genesis.name}  sha256 ${m.genesis.sha256}`,
          `    url                  ${m.genesis.url}`,
          ...m.genesis.mirrors.map((u) => `    mirror               ${u}`),
        ]
      : ['  genesis                none (network default parameters)']),
    `  mandatory              ${m.mandatory ? 'YES' : 'no'}`,
    `  upgrade before height  ${m.upgrade_before_height ?? 'n/a'}`,
    '  activations',
    ...(m.activations.length ? m.activations.map((a) => `    ${String(a.height).padStart(8)}  ${a.name}`) : ['    (none)']),
    `  notes                  ${m.notes_url ?? 'n/a'}`,
    `  min installer version  ${m.min_installer_version}`,
  ];
  return lines.join('\n');
}
