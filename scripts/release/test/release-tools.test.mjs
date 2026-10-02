// node --test: release tooling round trip + negative cases.
// Uses throw-away TEST keys generated inside a temp dir; never touches releases/keys.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decryptKeyFile, encryptKeyFile, generateKeys, signBytes } from '../lib/keys.mjs';
import { parseManifestBytes, serializeManifest, validateManifest } from '../lib/manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..');
const REPO = resolve(TOOLS, '../..');
const PASS = 'correct horse battery staple';

const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [join(TOOLS, script), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RELEASE_KEY_PASSPHRASE: PASS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const out = (r) => `${r.stdout}\n${r.stderr}`;

let dir;
let keyFile;
let keysDir;
let binary;
let genesis;
let cli;

/** Fresh, signed manifest in its own directory. Returns paths. */
function freshRelease(name, { sign = true } = {}) {
  const d = join(dir, name);
  mkdirSync(d);
  const manifest = join(d, 'manifest-mainnet.json');
  const r = run('make-manifest.mjs', [
    '--network', 'mainnet', '--version', '9.9.9', '--released', '2026-10-01',
    '--binary', binary, '--source-commit', '03613ef', '--public-commit', 'e048bf1',
    '--genesis', genesis, '--cli', cli, '--mandatory', '--upgrade-before-height', '235',
    '--activation', 'token_minting=235', '--activation', 'contract_nft_royalty=235',
    '--notes-url', 'https://docs.rougechain.io/running-a-node/releases.html',
    '--out', manifest,
  ]);
  assert.equal(r.status, 0, out(r));
  if (sign) {
    const s = run('sign-manifest.mjs', ['--key', keyFile, '--yes', manifest]);
    assert.equal(s.status, 0, out(s));
  }
  return { d, manifest, ed: manifest + '.ed25519.sig', ml: manifest + '.mldsa65.sig' };
}
const verify = (manifest, extra = []) => run('verify-manifest.mjs', ['--keys-dir', keysDir, ...extra, manifest]);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-release-test-'));
  keyFile = join(dir, 'test-keys.json');
  keysDir = join(dir, 'keys');
  binary = join(dir, 'quantum-vault-daemon-test-0000000');
  writeFileSync(binary, Buffer.alloc(4096, 7));
  cli = join(dir, 'rougechain');
  writeFileSync(cli, Buffer.alloc(2048, 3));
  genesis = join(dir, 'genesis-mainnet.json');
  writeFileSync(genesis, JSON.stringify({ chain_id: 'rougechain-mainnet-1' }) + '\n');
  const r = run('keygen.mjs', ['--out', keyFile, '--pub-dir', keysDir]);
  assert.equal(r.status, 0, out(r));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('keygen', () => {
  it('writes an encrypted, owner-only key file and both public keys', () => {
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    const text = readFileSync(keyFile, 'utf8');
    const f = JSON.parse(text);
    assert.equal(f.kdf.name, 'scrypt');
    assert.equal(f.cipher.name, 'aes-256-gcm');
    assert.ok(!/PRIVATE KEY/.test(text), 'no plaintext private key in the key file');
    assert.ok(!('secret' in f) && !('mldsa65_seed_hex' in f));
    assert.match(readFileSync(join(keysDir, 'release-ed25519.pub.pem'), 'utf8'), /^-----BEGIN PUBLIC KEY-----/);
    assert.match(readFileSync(join(keysDir, 'release-mldsa65.pub'), 'utf8'), /^[0-9a-f]{3904}\n$/);
  });
  it('refuses to overwrite a key file or published public keys', () => {
    const r = run('keygen.mjs', ['--out', keyFile]);
    assert.notEqual(r.status, 0);
    assert.match(out(r), /already exists/);
    const r2 = run('keygen.mjs', ['--out', join(dir, 'other.json'), '--pub-dir', keysDir]);
    assert.notEqual(r2.status, 0);
    assert.ok(!existsSync(join(dir, 'other.json')));
  });
  it('rejects a short passphrase', () => {
    const r = run('keygen.mjs', ['--out', join(dir, 'short.json')], { RELEASE_KEY_PASSPHRASE: 'short' });
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(dir, 'short.json')));
  });
  it('key file: wrong passphrase and tampering are rejected', () => {
    const text = readFileSync(keyFile, 'utf8');
    assert.throws(() => decryptKeyFile(text, 'wrong passphrase wrong'), /wrong passphrase/);
    const f = JSON.parse(text);
    f.public.ed25519_fingerprint = '0'.repeat(64);
    assert.throws(() => decryptKeyFile(JSON.stringify(f), PASS), /wrong passphrase|modified/);
    assert.equal(decryptKeyFile(text, PASS).public.ed25519_raw_b64, JSON.parse(text).public.ed25519_raw_b64);
  });
});

describe('make-manifest', () => {
  it('produces a schema-valid manifest with the binary hash and size', () => {
    const { manifest } = freshRelease('make-ok', { sign: false });
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.deepEqual(validateManifest(m), []);
    assert.equal(m.schema, 1);
    assert.equal(m.chain_id, 'rougechain-mainnet-1');
    assert.equal(m.binary.size, 4096);
    assert.match(m.binary.sha256, /^[0-9a-f]{64}$/);
    assert.equal(m.binary.url, 'https://api.rougechain.io/releases/quantum-vault-daemon-test-0000000');
    assert.equal(m.genesis.name, 'genesis-mainnet.json');
    assert.equal(m.cli.name, 'rougechain-03613ef');
    assert.equal(m.cli.url, 'https://api.rougechain.io/releases/rougechain-03613ef');
    assert.equal(m.cli.size, 2048);
    assert.match(m.cli.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(m.cli.mirrors, []);
    assert.deepEqual(Object.keys(m).slice(7, 10), ['binary', 'cli', 'genesis']);
    assert.deepEqual(m.activations, [{ name: 'token_minting', height: 235 }, { name: 'contract_nft_royalty', height: 235 }]);
  });
  it('cli: --no-cli gives cli: null; one of --cli / --no-cli is required; mirrors for binary, cli and genesis', () => {
    const base = ['--network', 'mainnet', '--version', '1.6.0', '--binary', binary, '--source-commit', '03613ef', '--genesis', genesis];
    const none = join(dir, 'cli-none.json');
    const r0 = run('make-manifest.mjs', [...base, '--out', none]);
    assert.notEqual(r0.status, 0);
    assert.match(out(r0), /--cli <file>.*--no-cli/);
    assert.ok(!existsSync(none));
    const r1 = run('make-manifest.mjs', [...base, '--no-cli', '--out', none]);
    assert.equal(r1.status, 0, out(r1));
    const m1 = JSON.parse(readFileSync(none, 'utf8'));
    assert.equal(m1.cli, null);
    assert.deepEqual(validateManifest(m1), []);
    assert.notEqual(run('make-manifest.mjs', [...base, '--cli', cli, '--no-cli', '--out', join(dir, 'cli-both.json')]).status, 0);
    assert.notEqual(run('make-manifest.mjs', [...base, '--cli', binary, '--out', join(dir, 'cli-same.json')]).status, 0);
    const gh = 'https://github.com/cyberdreadx/rougechain-node/releases/download/v1.6.0';
    const mirrored = join(dir, 'cli-mirrors.json');
    const r2 = run('make-manifest.mjs', [
      ...base, '--cli', cli, '--cli-name', 'rougechain-03613ef', '--out', mirrored,
      '--binary-mirror', `${gh}/quantum-vault-daemon-test-0000000`, '--cli-mirror', `${gh}/rougechain-03613ef`,
      '--genesis-mirror', `${gh}/genesis-mainnet.json`, '--genesis-mirror', 'https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/core/daemon/genesis-mainnet.json',
    ]);
    assert.equal(r2.status, 0, out(r2));
    const m2 = JSON.parse(readFileSync(mirrored, 'utf8'));
    assert.deepEqual(m2.binary.mirrors, [`${gh}/quantum-vault-daemon-test-0000000`]);
    assert.deepEqual(m2.cli.mirrors, [`${gh}/rougechain-03613ef`]);
    assert.equal(m2.genesis.mirrors.length, 2);
    assert.equal(m2.genesis.mirrors[0], `${gh}/genesis-mainnet.json`);
    assert.notEqual(run('make-manifest.mjs', [...base, '--cli', cli, '--cli-mirror', 'http://insecure.example/x', '--out', join(dir, 'cli-http.json')]).status, 0);
  });
  it('refuses to overwrite without --force, and never over existing signatures', () => {
    const { manifest } = freshRelease('make-overwrite');
    const base = ['--network', 'mainnet', '--version', '9.9.10', '--binary', binary, '--source-commit', '03613ef', '--genesis', genesis, '--no-cli', '--out', manifest];
    const r = run('make-manifest.mjs', base);
    assert.notEqual(r.status, 0);
    assert.match(out(r), /already exists/);
    const r2 = run('make-manifest.mjs', [...base, '--force']);
    assert.notEqual(r2.status, 0);
    assert.match(out(r2), /signature file/);
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, '9.9.9');
  });
  it('rejects bad input', () => {
    const base = ['--network', 'mainnet', '--binary', binary, '--source-commit', '03613ef', '--genesis', genesis, '--no-cli'];
    for (const [extra, re] of [
      [['--version', 'v1.6', '--out', join(dir, 'x1.json')], /version/],
      [['--version', '1.0.0', '--activation', 'Bad Name=1', '--out', join(dir, 'x2.json')], /activations/],
      [['--version', '1.0.0', '--activation', 'a=notanumber', '--out', join(dir, 'x3.json')], /integer/],
      [['--version', '1.0.0', '--binary-url', 'http://insecure.example/x', '--out', join(dir, 'x4.json')], /https/],
    ]) {
      const r = run('make-manifest.mjs', [...base, ...extra]);
      assert.notEqual(r.status, 0, out(r));
      assert.match(out(r), re);
    }
    // genesis for the wrong chain
    const r = run('make-manifest.mjs', ['--network', 'testnet', '--version', '1.0.0', '--binary', binary, '--source-commit', '03613ef', '--genesis', genesis, '--no-cli', '--out', join(dir, 'x5.json')]);
    assert.notEqual(r.status, 0);
    assert.match(out(r), /chain_id/);
    for (const n of ['x1', 'x2', 'x3', 'x4', 'x5']) assert.ok(!existsSync(join(dir, `${n}.json`)));
  });
});

describe('sign + verify', () => {
  it('round trip: keygen → make → sign → verify (with binary + genesis)', () => {
    const { manifest, ed, ml } = freshRelease('roundtrip');
    assert.equal(Buffer.from(readFileSync(ed, 'utf8').trim(), 'base64').length, 64);
    assert.equal(Buffer.from(readFileSync(ml, 'utf8').trim(), 'base64').length, 3309);
    const r = verify(manifest, ['--binary', binary, '--cli', cli, '--genesis', genesis, '--network', 'mainnet']);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /VERIFIED/);
    assert.match(r.stdout, /Ed25519 signature\s+OK/);
    assert.match(r.stdout, /ML-DSA-65 signature OK/);
  });
  it('the Ed25519 signature verifies with stock openssl', (t) => {
    const { d, manifest, ed } = freshRelease('openssl');
    const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    if (probe.status !== 0 || !/OpenSSL 3\./.test(probe.stdout)) return t.skip('OpenSSL 3 not available');
    const sigBin = join(d, 'sig.bin');
    writeFileSync(sigBin, Buffer.from(readFileSync(ed, 'utf8').trim(), 'base64'));
    const args = ['pkeyutl', '-verify', '-pubin', '-inkey', join(keysDir, 'release-ed25519.pub.pem'), '-rawin', '-in', manifest, '-sigfile', sigBin];
    assert.equal(spawnSync('openssl', args, { encoding: 'utf8' }).status, 0);
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('9.9.9', '9.9.8'));
    assert.notEqual(spawnSync('openssl', args, { encoding: 'utf8' }).status, 0);
  });
  it('sign refuses without confirmation when there is no terminal', () => {
    const { manifest, ed } = freshRelease('noconfirm', { sign: false });
    const r = run('sign-manifest.mjs', ['--key', keyFile, manifest]);
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(ed));
  });
  it('sign refuses a wrong passphrase, an invalid manifest and existing signatures', () => {
    const a = freshRelease('sign-neg', { sign: false });
    const r = run('sign-manifest.mjs', ['--key', keyFile, '--yes', a.manifest], { RELEASE_KEY_PASSPHRASE: 'not the passphrase' });
    assert.notEqual(r.status, 0);
    assert.match(out(r), /wrong passphrase/);
    assert.ok(!existsSync(a.ed) && !existsSync(a.ml));
    const m = JSON.parse(readFileSync(a.manifest, 'utf8'));
    m.binary.sha256 = 'xyz';
    writeFileSync(a.manifest, JSON.stringify(m, null, 2) + '\n');
    const r2 = run('sign-manifest.mjs', ['--key', keyFile, '--yes', a.manifest]);
    assert.notEqual(r2.status, 0);
    assert.match(out(r2), /invalid manifest/);
    const b = freshRelease('sign-twice');
    const r3 = run('sign-manifest.mjs', ['--key', keyFile, '--yes', b.manifest]);
    assert.notEqual(r3.status, 0);
    assert.match(out(r3), /already exists/);
  });
  it('tampered manifest fails (one byte changed, schema still valid)', () => {
    const { manifest } = freshRelease('tamper-manifest');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"upgrade_before_height": 235', '"upgrade_before_height": 236'));
    const r = verify(manifest);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /Ed25519 signature: does NOT verify/);
    assert.match(r.stderr, /ML-DSA-65 signature: does NOT verify/);
  });
  it('whitespace-only change to the manifest fails (signatures cover exact bytes)', () => {
    const { manifest } = freshRelease('tamper-ws');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\n');
    assert.equal(verify(manifest).status, 1);
  });
  it('tampered binary / genesis fails', () => {
    const { d, manifest } = freshRelease('tamper-binary');
    const bad = join(d, 'bin');
    const buf = Buffer.alloc(4096, 7);
    buf[100] = 8;
    writeFileSync(bad, buf);
    const r = verify(manifest, ['--binary', bad]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /binary: sha256/);
    writeFileSync(bad, Buffer.alloc(4097, 7));
    const r2 = verify(manifest, ['--binary', bad]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /binary: size/);
    const badCli = join(d, 'cli');
    const cbuf = Buffer.alloc(2048, 3);
    cbuf[7] = 4;
    writeFileSync(badCli, cbuf);
    const r3 = verify(manifest, ['--cli', badCli]);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /cli: sha256/);
    writeFileSync(badCli, Buffer.alloc(2047, 3));
    assert.match(verify(manifest, ['--cli', badCli]).stderr, /cli: size/);
    // the daemon binary passed as the CLI (and the reverse) must not verify
    assert.equal(verify(manifest, ['--cli', binary]).status, 1);
    assert.equal(verify(manifest, ['--binary', cli]).status, 1);
    const badGenesis = join(d, 'genesis.json');
    writeFileSync(badGenesis, '{"chain_id":"rougechain-mainnet-1" }\n');
    assert.equal(verify(manifest, ['--genesis', badGenesis]).status, 1);
  });
  it('wrong keys fail', () => {
    const { manifest } = freshRelease('wrong-key');
    const other = join(dir, 'other-keys');
    const r0 = run('keygen.mjs', ['--out', join(dir, 'other-keys.json'), '--pub-dir', other]);
    assert.equal(r0.status, 0, out(r0));
    const r = run('verify-manifest.mjs', ['--keys-dir', other, manifest]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Ed25519 signature: does NOT verify/);
    assert.match(r.stderr, /ML-DSA-65 signature: does NOT verify/);
  });
  it('Ed25519 and ML-DSA-65 are each independently required', () => {
    const other = join(dir, 'other-keys');
    assert.ok(existsSync(other));
    // (a) one signature file missing
    for (const which of ['ed', 'ml']) {
      const rel = freshRelease(`missing-${which}`);
      rmSync(rel[which]);
      const r = verify(rel.manifest);
      assert.equal(r.status, 1, out(r));
      assert.match(r.stderr, which === 'ed' ? /Ed25519 signature is required/ : /ML-DSA-65 signature is required/);
    }
    // (b) one signature valid, the other made by a different key
    const good = freshRelease('mixed');
    for (const [file, re] of [
      ['release-ed25519.pub.pem', /Ed25519 signature: does NOT verify/],
      ['release-mldsa65.pub', /ML-DSA-65 signature: does NOT verify/],
    ]) {
      const mixed = join(dir, `mixed-keys-${file}`);
      mkdirSync(mixed);
      for (const f of ['release-ed25519.pub.pem', 'release-mldsa65.pub']) copyFileSync(join(f === file ? other : keysDir, f), join(mixed, f));
      const r = run('verify-manifest.mjs', ['--keys-dir', mixed, good.manifest]);
      assert.equal(r.status, 1, out(r));
      assert.match(r.stderr, re);
      assert.equal((r.stderr.match(/does NOT verify/g) || []).length, 1, 'only the swapped key fails');
    }
    // (c) one public key missing from the keys dir
    for (const f of ['release-ed25519.pub.pem', 'release-mldsa65.pub']) {
      const partial = join(dir, `partial-keys-${f}`);
      mkdirSync(partial);
      copyFileSync(join(keysDir, f), join(partial, f));
      assert.equal(run('verify-manifest.mjs', ['--keys-dir', partial, good.manifest]).status, 1);
    }
  });
  it('garbage signatures fail', () => {
    const cases = [
      ['ed', 'not base64 !!!\n'],
      ['ed', Buffer.alloc(64, 1).toString('base64') + '\n'],
      ['ed', Buffer.alloc(63, 1).toString('base64') + '\n'],
      ['ed', ''],
      ['ml', Buffer.alloc(3309, 1).toString('base64') + '\n'],
      ['ml', Buffer.alloc(10, 1).toString('base64') + '\n'],
      ['ml', 'deadbeef\n'],
    ];
    cases.forEach(([which, content], i) => {
      const rel = freshRelease(`garbage-${i}`);
      writeFileSync(rel[which], content);
      const r = verify(rel.manifest);
      assert.equal(r.status, 1, `case ${i}: ${out(r)}`);
    });
    // swapped signature files
    const rel = freshRelease('garbage-swap');
    const ed = readFileSync(rel.ed);
    writeFileSync(rel.ed, readFileSync(rel.ml));
    writeFileSync(rel.ml, ed);
    assert.equal(verify(rel.manifest).status, 1);
  });
  it('a signature for one manifest does not verify another', () => {
    const a = freshRelease('replay-a');
    const b = freshRelease('replay-b', { sign: false });
    writeFileSync(b.manifest, readFileSync(b.manifest, 'utf8').replace('"version": "9.9.9"', '"version": "9.9.10"'));
    copyFileSync(a.ed, b.ed);
    copyFileSync(a.ml, b.ml);
    assert.equal(verify(b.manifest).status, 1);
  });
  it('unsigned: exit 2 without keys, 0 only with --allow-unsigned; invalid once keys are provisioned', () => {
    const { manifest } = freshRelease('unsigned', { sign: false });
    const empty = join(dir, 'no-keys');
    mkdirSync(empty);
    const r = run('verify-manifest.mjs', ['--keys-dir', empty, manifest]);
    assert.equal(r.status, 2, out(r));
    assert.match(r.stdout, /UNSIGNED/);
    const r2 = run('verify-manifest.mjs', ['--keys-dir', empty, '--allow-unsigned', manifest]);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /UNSIGNED/);
    // keys provisioned → --allow-unsigned has no effect
    const r3 = verify(manifest, ['--allow-unsigned']);
    assert.equal(r3.status, 1, out(r3));
    assert.match(r3.stderr, /must be signed/);
    // signatures present but no keys to check them with
    const signed = freshRelease('signed-no-keys');
    assert.equal(run('verify-manifest.mjs', ['--keys-dir', empty, '--allow-unsigned', signed.manifest]).status, 1);
  });
  it('schema violations fail verification even when correctly signed', () => {
    const mutations = [
      (m) => { m.schema = 2; },
      (m) => { delete m.mandatory; },
      (m) => { m.extra = true; },
      (m) => { m.network = 'devnet'; },
      (m) => { m.chain_id = 'rougechain-devnet-1'; },
      (m) => { m.version = '1.6'; },
      (m) => { m.released = 'yesterday'; },
      (m) => { m.source_commit = 'HEAD'; },
      (m) => { m.binary.sha256 = m.binary.sha256.toUpperCase().replace(/[0-9]/g, 'A'); },
      (m) => { m.binary.size = '4096'; },
      (m) => { m.binary.size = 0; },
      (m) => { m.binary.url = 'http://api.rougechain.io/releases/x'; },
      (m) => { m.binary.name = '../../etc/passwd'; },
      (m) => { m.binary.mirrors = 'https://example.com'; },
      (m) => { m.binary.mirrors = ['ftp://example.com/x']; },
      (m) => { m.binary.extra = 1; },
      (m) => { m.genesis = {}; },
      (m) => { delete m.cli; },
      (m) => { m.cli = {}; },
      (m) => { m.cli = 'rougechain'; },
      (m) => { m.cli.sha256 = 'abc'; },
      (m) => { m.cli.url = 'http://api.rougechain.io/releases/rougechain'; },
      (m) => { m.cli.mirrors = ['http://github.com/x']; },
      (m) => { m.cli.name = '../rougechain'; },
      (m) => { m.cli.name = m.binary.name; },
      (m) => { m.cli.size = -1; },
      (m) => { m.mandatory = 'yes'; },
      (m) => { m.upgrade_before_height = -1; },
      (m) => { m.upgrade_before_height = 1.5; },
      (m) => { m.activations = [{ name: 'x', height: '235' }]; },
      (m) => { m.activations = [{ name: 'x', height: 1 }, { name: 'x', height: 2 }]; },
      (m) => { m.activations = [{ name: 'x', height: 1, extra: 1 }]; },
      (m) => { m.notes_url = 'javascript:alert(1)'; },
      (m) => { m.min_installer_version = '2'; },
    ];
    const base = freshRelease('schema-base', { sign: false });
    const original = JSON.parse(readFileSync(base.manifest, 'utf8'));
    assert.deepEqual(validateManifest(original), []);
    mutations.forEach((mutate, i) => {
      const m = structuredClone(original);
      mutate(m);
      assert.notDeepEqual(validateManifest(m), [], `mutation ${i} should be invalid`);
    });
    // end to end for one of them: a signed-but-invalid manifest (signed with the lib directly,
    // since sign-manifest.mjs refuses to sign it) must still be INVALID.
    const d = join(dir, 'schema-signed');
    mkdirSync(d);
    const bad = structuredClone(original);
    bad.binary.url = 'http://api.rougechain.io/releases/x';
    const manifest = join(d, 'manifest-mainnet.json');
    const badBytes = Buffer.from(JSON.stringify(bad, null, 2) + '\n');
    writeFileSync(manifest, badBytes);
    const sig = signBytes(badBytes, decryptKeyFile(readFileSync(keyFile, 'utf8'), PASS).secret);
    writeFileSync(manifest + '.ed25519.sig', sig.ed25519_b64 + '\n');
    writeFileSync(manifest + '.mldsa65.sig', sig.mldsa65_b64 + '\n');
    const r = verify(manifest);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /https/);
    // not JSON at all / not UTF-8
    writeFileSync(manifest, '{ not json');
    assert.equal(verify(manifest).status, 1);
    writeFileSync(manifest, Buffer.from([0xff, 0xfe, 0x00]));
    assert.equal(verify(manifest).status, 1);
    assert.equal(verify(join(d, 'does-not-exist.json')).status, 1);
  });
  it('--network mismatch fails', () => {
    const { manifest } = freshRelease('network-mismatch');
    assert.equal(verify(manifest, ['--network', 'testnet']).status, 1);
  });
});

describe('cli in a signed release', () => {
  it('--cli against a manifest without a cli fails; a signed cli: null manifest verifies', () => {
    const d = join(dir, 'signed-nocli');
    mkdirSync(d);
    const manifest = join(d, 'manifest-mainnet.json');
    const r = run('make-manifest.mjs', ['--network', 'mainnet', '--version', '9.9.9', '--binary', binary, '--source-commit', '03613ef', '--genesis', genesis, '--no-cli', '--out', manifest]);
    assert.equal(r.status, 0, out(r));
    assert.equal(run('sign-manifest.mjs', ['--key', keyFile, '--yes', manifest]).status, 0);
    assert.equal(verify(manifest, ['--binary', binary]).status, 0);
    const v = verify(manifest, ['--cli', cli]);
    assert.equal(v.status, 1);
    assert.match(v.stderr, /manifest has no cli/);
  });
  it('the cli entry is covered by the signatures (swapping its hash breaks both)', () => {
    const { manifest } = freshRelease('cli-tamper');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.cli.sha256 = m.binary.sha256.split('').reverse().join('');
    writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
    const r = verify(manifest);
    assert.equal(r.status, 1);
    assert.equal((r.stderr.match(/does NOT verify/g) || []).length, 2);
  });
  it('the summary shown before signing lists the cli and every mirror', () => {
    const { manifest } = freshRelease('cli-summary', { sign: false });
    const r = run('sign-manifest.mjs', ['--key', keyFile, '--yes', manifest]);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stderr, /cli\s+rougechain-03613ef/);
    assert.match(r.stderr, /mirror\s+https:\/\/raw\.githubusercontent\.com/);
  });
});

describe('installer key embedding', () => {
  const PLACEHOLDER = 'PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED';
  const fakeInstaller = (ed, ml = PLACEHOLDER, { version = '2.1.0', mlLine = true } = {}) => {
    const p = join(dir, `installer-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(
      p,
      `#!/usr/bin/env bash\nINSTALLER_VERSION="${version}"\nRELEASE_ED25519_PUBKEY_B64="${ed}"\n${mlLine ? `RELEASE_MLDSA65_PUBKEY_HEX="${ml}"\n` : ''}echo hi\n`,
    );
    return p;
  };
  const pub = () => JSON.parse(readFileSync(keyFile, 'utf8')).public;

  it('embeds BOTH committed keys, is idempotent, and needs --rotate to replace a real key', () => {
    const inst = fakeInstaller(PLACEHOLDER);
    const args = ['--key', join(keysDir, 'release-ed25519.pub.pem'), '--mldsa-key', join(keysDir, 'release-mldsa65.pub'), '--installer', inst];
    const r = run('embed-installer-key.mjs', args);
    assert.equal(r.status, 0, out(r));
    const text = readFileSync(inst, 'utf8');
    assert.ok(text.includes(`RELEASE_ED25519_PUBKEY_B64="${pub().ed25519_raw_b64}"`));
    assert.ok(text.includes(`RELEASE_MLDSA65_PUBKEY_HEX="${pub().mldsa65_hex}"`));
    assert.equal(run('embed-installer-key.mjs', args).status, 0);
    assert.equal(readFileSync(inst, 'utf8'), text, 'a second run changes nothing');
    const other = ['--key', join(dir, 'other-keys', 'release-ed25519.pub.pem'), '--mldsa-key', join(dir, 'other-keys', 'release-mldsa65.pub'), '--installer', inst];
    assert.notEqual(run('embed-installer-key.mjs', other).status, 0);
    assert.equal(readFileSync(inst, 'utf8'), text, 'a refused rotation changes nothing');
    assert.equal(run('embed-installer-key.mjs', [...other, '--rotate']).status, 0);
    assert.ok(!readFileSync(inst, 'utf8').includes(pub().mldsa65_hex));
  });
  it('never rotates one key without the other', () => {
    // Ed25519 already the committed one, ML-DSA-65 a different real key: without --rotate nothing changes.
    const inst = fakeInstaller(pub().ed25519_raw_b64, 'ab'.repeat(1952));
    const before = readFileSync(inst, 'utf8');
    const r = run('embed-installer-key.mjs', ['--key', join(keysDir, 'release-ed25519.pub.pem'), '--mldsa-key', join(keysDir, 'release-mldsa65.pub'), '--installer', inst]);
    assert.notEqual(r.status, 0);
    assert.match(out(r), /different ML-DSA-65 release key/);
    assert.equal(readFileSync(inst, 'utf8'), before);
  });
  it('refuses an installer without the ML-DSA-65 key line', () => {
    const inst = fakeInstaller(PLACEHOLDER, PLACEHOLDER, { mlLine: false });
    const r = run('embed-installer-key.mjs', ['--key', join(keysDir, 'release-ed25519.pub.pem'), '--mldsa-key', join(keysDir, 'release-mldsa65.pub'), '--installer', inst]);
    assert.notEqual(r.status, 0);
    assert.match(out(r), /RELEASE_MLDSA65_PUBKEY_HEX/);
  });
  it('verify --check-installer ties BOTH embedded keys to the committed keys', () => {
    const { manifest } = freshRelease('check-installer');
    const { ed25519_raw_b64: b64, mldsa65_hex: hex } = pub();
    assert.equal(verify(manifest, ['--check-installer', fakeInstaller(b64, hex)]).status, 0);
    assert.equal(verify(manifest, ['--check-installer', fakeInstaller(PLACEHOLDER, hex)]).status, 1);
    assert.equal(verify(manifest, ['--check-installer', fakeInstaller(Buffer.alloc(32, 9).toString('base64'), hex)]).status, 1);
    const r = verify(manifest, ['--check-installer', fakeInstaller(b64, PLACEHOLDER)]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /embedded ML-DSA-65 key does not match/);
    assert.equal(verify(manifest, ['--check-installer', fakeInstaller(b64, 'cd'.repeat(1952))]).status, 1);
    assert.equal(verify(manifest, ['--check-installer', fakeInstaller(b64, hex, { mlLine: false })]).status, 1);
    // keys not provisioned: only the placeholders are acceptable
    const empty = join(dir, 'no-keys-2');
    mkdirSync(empty);
    const unsigned = freshRelease('check-installer-unsigned', { sign: false });
    const v = (inst) => run('verify-manifest.mjs', ['--keys-dir', empty, '--allow-unsigned', '--check-installer', inst, unsigned.manifest]);
    assert.equal(v(fakeInstaller(PLACEHOLDER)).status, 0);
    assert.equal(v(fakeInstaller(b64)).status, 1);
    assert.equal(v(fakeInstaller(PLACEHOLDER, hex)).status, 1);
  });

  describe('the optional `installer` manifest entry', () => {
    const makeArgs = (manifest, extra = []) => [
      '--network', 'mainnet', '--version', '9.9.9', '--released', '2026-10-01',
      '--binary', binary, '--source-commit', '03613ef', '--genesis', genesis, '--cli', cli,
      '--activation', 'token_minting=235', '--out', manifest, ...extra,
    ];
    const realKeys = () => fakeInstaller(pub().ed25519_raw_b64, pub().mldsa65_hex, { version: '2.3.4' });
    const fresh = (name) => {
      const d = join(dir, name);
      mkdirSync(d);
      return join(d, 'manifest-mainnet.json');
    };

    it('make-manifest --installer records name, sha256 and size; the release signs and verifies', () => {
      const inst = realKeys();
      const manifest = fresh('ins-ok');
      const r = run('make-manifest.mjs', makeArgs(manifest, ['--installer', inst, '--installer-mirror', 'https://github.com/cyberdreadx/rougechain-node/releases/download/v9.9.9/x.sh']));
      assert.equal(r.status, 0, out(r));
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      assert.deepEqual(validateManifest(m), []);
      assert.equal(m.installer.size, statSync(inst).size);
      assert.match(m.installer.sha256, /^[0-9a-f]{64}$/);
      assert.equal(m.installer.name, `install-validator-2.3.4-${m.installer.sha256.slice(0, 8)}.sh`);
      assert.equal(m.installer.url, `https://api.rougechain.io/releases/${m.installer.name}`);
      assert.equal(m.installer.mirrors.length, 1);
      const keys = Object.keys(m);
      assert.equal(keys.indexOf('installer'), keys.indexOf('genesis') + 1, 'installer follows genesis');
      assert.equal(m.schema, 1, 'still schema 1: the field is an optional addition');
      assert.equal(run('sign-manifest.mjs', ['--key', keyFile, '--yes', manifest]).status, 0);
      const v = verify(manifest, ['--installer', inst, '--check-installer', inst]);
      assert.equal(v.status, 0, out(v));
      assert.match(v.stdout, /installer \/ updater\s+install-validator-2\.3\.4-/);
      // a different file under --installer is caught
      const other = realKeys();
      writeFileSync(other, readFileSync(other, 'utf8') + '# changed\n');
      const bad = verify(manifest, ['--installer', other]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /installer: (size|sha256)/);
      // changing the installer entry of a signed manifest breaks both signatures
      const t = JSON.parse(readFileSync(manifest, 'utf8'));
      t.installer.sha256 = 'f'.repeat(64);
      writeFileSync(manifest, serializeManifest(t));
      const tampered = verify(manifest);
      assert.equal(tampered.status, 1);
      assert.equal((tampered.stderr.match(/does NOT verify/g) || []).length, 2);
    });
    it('a manifest without the entry stays valid; verify --installer then fails', () => {
      const { manifest } = freshRelease('ins-absent');
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      assert.ok(!('installer' in m));
      assert.equal(verify(manifest).status, 0);
      const r = verify(manifest, ['--installer', realKeys()]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /manifest has no installer entry/);
    });
    it('schema: installer must be a complete file entry when present', () => {
      const { manifest } = freshRelease('ins-schema', { sign: false });
      const base = JSON.parse(readFileSync(manifest, 'utf8'));
      const entry = { name: 'install-validator-2.1.0.sh', url: 'https://api.rougechain.io/releases/install-validator-2.1.0.sh', mirrors: [], sha256: 'a'.repeat(64), size: 10 };
      assert.deepEqual(validateManifest({ ...base, installer: entry }), []);
      assert.match(validateManifest({ ...base, installer: null }).join('\n'), /installer: must be an object/);
      assert.match(validateManifest({ ...base, installer: { ...entry, run: 'x' } }).join('\n'), /installer\.run: unknown field/);
      assert.match(validateManifest({ ...base, installer: { ...entry, sha256: 'A'.repeat(64) } }).join('\n'), /installer\.sha256/);
      assert.match(validateManifest({ ...base, installer: { ...entry, url: 'http://example.com/x.sh' } }).join('\n'), /installer\.url: must be an https/);
      assert.match(validateManifest({ ...base, installer: { ...entry, name: base.binary.name } }).join('\n'), /installer\.name: must differ from binary\.name/);
      const { sha256: _omit, ...noSha } = entry;
      assert.match(validateManifest({ ...base, installer: noSha }).join('\n'), /installer\.sha256: missing/);
      assert.match(validateManifest({ ...base, updater: entry }).join('\n'), /updater: unknown field/);
    });
    it('make-manifest refuses an installer that is not provisioned, too old, or not an installer', () => {
      const cases = [
        [fakeInstaller(PLACEHOLDER, pub().mldsa65_hex), [], /Ed25519 release key is still the placeholder/],
        [fakeInstaller(pub().ed25519_raw_b64, PLACEHOLDER), [], /ML-DSA-65 release key is still the placeholder/],
        [fakeInstaller(pub().ed25519_raw_b64, pub().mldsa65_hex, { version: '1.9.0' }), [], /older than --min-installer-version 2\.0\.0/],
        [fakeInstaller(pub().ed25519_raw_b64, pub().mldsa65_hex, { version: '2.1.0' }), ['--min-installer-version', '2.2.0'], /older than --min-installer-version 2\.2\.0/],
        [binary, [], /no INSTALLER_VERSION/],
        [join(dir, 'does-not-exist.sh'), [], /not a file/],
      ];
      cases.forEach(([inst, extra, re], n) => {
        const manifest = fresh(`ins-refuse-${n}`);
        const r = run('make-manifest.mjs', makeArgs(manifest, ['--installer', inst, ...extra]));
        assert.notEqual(r.status, 0, `case ${n}`);
        assert.match(out(r), re, `case ${n}`);
        assert.ok(!existsSync(manifest), `case ${n}: no manifest written`);
      });
      const manifest = fresh('ins-refuse-name');
      const r = run('make-manifest.mjs', makeArgs(manifest, ['--installer-name', 'x.sh']));
      assert.notEqual(r.status, 0);
      assert.match(out(r), /need --installer/);
    });
    it('verify --installer rejects an installer older than min_installer_version', () => {
      const inst = fakeInstaller(pub().ed25519_raw_b64, pub().mldsa65_hex, { version: '2.5.0' });
      const manifest = fresh('ins-min');
      assert.equal(run('make-manifest.mjs', makeArgs(manifest, ['--installer', inst, '--min-installer-version', '2.5.0'])).status, 0);
      const m = JSON.parse(readFileSync(manifest, 'utf8'));
      m.min_installer_version = '2.6.0';
      writeFileSync(manifest, serializeManifest(m));
      assert.equal(run('sign-manifest.mjs', ['--key', keyFile, '--yes', manifest]).status, 0);
      const r = verify(manifest, ['--installer', inst]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /older than min_installer_version 2\.6\.0/);
    });
  });
});

describe('repository state', () => {
  it('the committed manifests are schema-valid and verify as signed, or as UNSIGNED while keys are pending', () => {
    for (const net of ['mainnet', 'testnet']) {
      const r = run('verify-manifest.mjs', ['--allow-unsigned', '--network', net, '--check-installer', join(REPO, 'scripts', 'install-validator.sh'), join(REPO, 'releases', `manifest-${net}.json`)]);
      assert.equal(r.status, 0, out(r));
      assert.match(r.stdout, /VERIFIED|UNSIGNED/);
    }
  });
  it('the committed manifests (signed before the `installer` field existed) are untouched by the schema change', () => {
    for (const net of ['mainnet', 'testnet']) {
      const file = join(REPO, 'releases', `manifest-${net}.json`);
      const bytes = readFileSync(file);
      const m = parseManifestBytes(bytes);
      assert.deepEqual(validateManifest(m), [], net);
      assert.ok(!('installer' in m), `${net}: 1.6.0 has no installer entry`);
      // the serialiser still writes exactly these bytes: nothing was added to manifests without the field
      assert.equal(serializeManifest(m), bytes.toString('utf8'), net);
    }
  });
  it('the committed installer embeds both committed release keys', () => {
    const text = readFileSync(join(REPO, 'scripts', 'install-validator.sh'), 'utf8');
    const hex = readFileSync(join(REPO, 'releases', 'keys', 'release-mldsa65.pub'), 'utf8').trim();
    assert.ok(text.includes(`RELEASE_MLDSA65_PUBKEY_HEX="${hex}"`));
    assert.equal((text.match(/^RELEASE_MLDSA65_PUBKEY_HEX=/gm) || []).length, 1);
    assert.equal((text.match(/^RELEASE_ED25519_PUBKEY_B64=/gm) || []).length, 1);
  });
  it('lib: encrypt/decrypt round trip keeps the keys', () => {
    const keys = generateKeys();
    const back = decryptKeyFile(encryptKeyFile(keys, PASS), PASS);
    assert.deepEqual(back.secret, keys.secret);
    assert.deepEqual(back.public, keys.public);
  });
});
