// Main-thread module of the browser harness for the shielded pool V2 WebAssembly package
// (core/shield-v2-wasm, wasm-bindgen `--target web`, generated into ../pkg by build.sh).
//
// window.harness.runAll()   → the full check list a–g (see README.md); returns a JSON-able object
// window.harness.runMemory() → one transfer proved in a worker, then the page's memory as the
//                              browser measures it (needs a cross-origin-isolated page)
//
// Nothing here writes to the console: whatever appears there came from the package.

const PKG = new URL('../pkg/quantum_vault_shield_v2_wasm.js', import.meta.url).href;
const WASM = new URL('../pkg/quantum_vault_shield_v2_wasm_bg.wasm', import.meta.url).href;
const VECTORS = new URL('../../shield-v2/vectors/wallet/', import.meta.url).href;

/** The 26 exports of src/lib.rs. */
export const EXPORTS = [
  'constants', 'shielded_address', 'parse_address', 'export_scan_key', 'new_state', 'assert_sole_copy',
  'can_spend_now', 'expect_revision_id', 'recover_locks', 'build_own_shield', 'set_nodes', 'scan', 'summary',
  'scan_pages', 'plan_payment', 'plan_self_merge', 'build_shield', 'attach_signature', 'build_transfer',
  'build_unshield', 'abandon_unsubmitted', 'pending', 'note_rejection', 'resolve_pending', 'confirm_state',
  'rescan_state',
];

// ---- instrumentation, installed BEFORE the package is imported -----------------------------------

const counters = { rngCalls: 0, rngBytes: 0, mathRandomCalls: 0 };
const realGetRandomValues = crypto.getRandomValues.bind(crypto);
crypto.getRandomValues = (array) => {
  counters.rngCalls += 1;
  counters.rngBytes += array.byteLength;
  return realGetRandomValues(array);
};
const realMathRandom = Math.random;
Math.random = () => {
  counters.mathRandomCalls += 1;
  return realMathRandom();
};
const consoleSeen = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    consoleSeen.push({ level, text: args.map(String).join(' ') });
    real(...args);
  };
}

// ---- small helpers ---------------------------------------------------------------------------------

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
  return out;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const u32le = (u8) => Array.from({ length: u8.length / 4 }, (_, i) => new DataView(u8.buffer, u8.byteOffset + 4 * i, 4).getUint32(0, true));
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** BIP-39 seed: PBKDF2-HMAC-SHA512(NFKD(phrase), "mnemonic" ‖ NFKD(passphrase), 2048), 64 bytes. */
async function bip39Seed(phrase, passphrase = '') {
  const key = await crypto.subtle.importKey('raw', utf8(phrase.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', salt: utf8(('mnemonic' + passphrase).normalize('NFKD')), iterations: 2048 }, key, 512);
  return new Uint8Array(bits);
}

// bech32m (BIP-350), no length limit (a shielded address is 1,974 characters)
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function bech32mDecode(s) {
  const pos = s.lastIndexOf('1');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error('bech32m: bad character');
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...expand, ...data]) !== 0x2bc830a3) throw new Error('bech32m: bad checksum');
  let acc = 0; let bits = 0; const out = [];
  for (const w of data.slice(0, -6)) {
    acc = (acc << 5) | w; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) throw new Error('bech32m: bad padding');
  return { hrp, bytes: new Uint8Array(out) };
}

// body layout (spec §3.2)
const KEM_OFF = [258, 1402];
const NOTE_OFF = [1346, 2490];
const CIPHERTEXT_ACC_TAG = utf8('rougechain.shield_v2.ciphertext_acc.node_local.v1');

/** The node-local running ciphertext hash (core/daemon/src/shield_v2.rs `ciphertext_acc_step`), in JS. */
async function ciphertextAccStep(acc, cm, kem, note) {
  return sha256(concat(CIPHERTEXT_ACC_TAG, acc, cm, kem, note));
}

// ---- the check list ------------------------------------------------------------------------------

function makeChecks() {
  const list = [];
  const check = (group, name, pass, detail) => { list.push({ group, name, pass: !!pass, detail: detail === undefined ? null : detail }); return !!pass; };
  return { list, check };
}

let wasm = null;
let instanceExports = null;
let secrets = [];
const leaks = [];
let callCount = 0;

function scanForSecrets(name, text, thread = 'main') {
  if (typeof text !== 'string') return;
  for (const s of secrets) if (text.includes(s.hex)) leaks.push({ export: name, secret: s.label, thread });
}
/** Every call of the package goes through here: counted, and its result / error scanned for secrets. */
function call(name, ...args) {
  callCount += 1;
  try {
    const r = wasm[name](...args);
    scanForSecrets(name, r);
    return r;
  } catch (e) {
    scanForSecrets(name, e && e.message);
    throw e;
  }
}
const J = (name, ...args) => JSON.parse(call(name, ...args));

async function loadVectors() {
  const get = async (f) => (await fetch(VECTORS + f)).json();
  const [keys, txs, roots] = await Promise.all([get('keys.json'), get('transactions.json'), get('state_root.json')]);
  return { keys, txs, roots };
}

async function instantiateMain() {
  const t0 = performance.now();
  wasm = await import(PKG);
  const t1 = performance.now();
  instanceExports = await wasm.default({ module_or_path: WASM });
  const t2 = performance.now();
  return { importMs: t1 - t0, instantiateMs: t2 - t1, memoryBytes: instanceExports.memory.buffer.byteLength };
}

/** A worker with a promise-based request/response. */
function startWorker() {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  let next = 0;
  const waiting = new Map();
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
  const ask = (msg) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); worker.postMessage({ id, ...msg }); });
  return { worker, ask };
}

// ---- node-shaped answers built from the vector files (NOTES §6, UI_CONTRACT obligation 9) ------------

/**
 * The vector chain (transactions.json, one V2 transaction per block from the activation height)
 * as a node serves it: one listing page per block (`GET /api/shield-v2/notes?since=h&blocks=1`),
 * each as the RAW BODY TEXT; and per height the raw body of `GET /api/shield-v2/stats`.
 */
async function nodeAnswers(txs, roots) {
  const activation = txs.activation_height;
  const list = txs.transactions;
  const tip = list[list.length - 1].height;
  const pages = [];
  const stats = new Map(); // height → raw body text
  let leaf = 0;
  let acc = new Uint8Array(32);
  const statsBody = (height, state, accBytes) => JSON.stringify({
    activation_height: activation, active: true, tip_height: tip, min_fee_quanta: 1000000000,
    pool_cap_quanta: '0', max_tx_per_block: 8, anchor_window: 0, verified_proof_cache: 0, refused_proof_cache: 0,
    report: { height, tree_root: state.tree_root, nullifier_acc: state.nullifier_acc, note_count: state.note_count,
      nullifier_count: state.nullifier_count, ciphertext_acc: hex(accBytes) },
    pool: { next_height: height + 1, pool_total_quanta: state.pool_total, note_count: state.note_count,
      nullifier_count: state.nullifier_count, tree_root: state.tree_root, nullifier_acc: state.nullifier_acc,
      anchor_window_len: state.window.length, anchor_window: state.window, latest_anchor: state.window[state.window.length - 1] },
    success: true,
  });
  stats.set(activation - 1, statsBody(activation - 1, roots.states[0].state, acc));
  const sanity = [];
  for (const [i, t] of list.entries()) {
    const b = unhex(t.body);
    const outputs = [];
    for (const j of [0, 1]) {
      const cm = b.slice(138 + 32 * j, 170 + 32 * j);
      const kem = b.slice(KEM_OFF[j], KEM_OFF[j] + 1088);
      const note = b.slice(NOTE_OFF[j], NOTE_OFF[j] + 56);
      outputs.push({ cm_out: hex(cm), leaf: leaf + j, kem_ct: hex(kem), note_ct: hex(note) });
      acc = await ciphertextAccStep(acc, cm, kem, note);
    }
    leaf += 2;
    const nf1 = hex(b.slice(74, 106));
    const nf2 = hex(b.slice(106, 138));
    sanity.push(nf1 === t.nf1 && nf2 === t.nf2 && outputs[0].cm_out === t.cm_out1 && outputs[1].cm_out === t.cm_out2);
    const tx = { height: t.height, index: 0, tx_hash: hex(await sha256(b)), tx_type: t.tx_type, nf1, nf2, outputs };
    pages.push(JSON.stringify({ active: true, tip_height: tip, from_height: t.height, next_height: t.height + 1, txs: [tx], success: true }));
    stats.set(t.height, statsBody(t.height, roots.states[i + 1].state, acc));
  }
  return { pages, stats, tip, ciphertextAcc: hex(acc), sanity: sanity.every(Boolean) };
}

/** A canonical digest (8 little-endian words below the KoalaBear modulus), random. */
function randomDigest() {
  const words = new Uint32Array(8);
  realGetRandomValues(words);
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setUint32(4 * i, w % 0x7f000001, true));
  return out;
}
function randomBytes(n) { const u = new Uint8Array(n); for (let o = 0; o < n; o += 65536) realGetRandomValues(u.subarray(o, Math.min(n, o + 65536))); return u; }

/** `pageCount` listing pages of `perPage` foreign transactions (nobody's notes: every trial decryption fails). */
function foreignPages(pageCount, perPage, firstHeight) {
  const pages = [];
  let leaf = 0;
  const tip = firstHeight + pageCount - 1;
  for (let p = 0; p < pageCount; p++) {
    const height = firstHeight + p;
    const txs = [];
    for (let i = 0; i < perPage; i++) {
      const outputs = [0, 1].map((j) => ({ cm_out: hex(randomDigest()), leaf: leaf + j, kem_ct: hex(randomBytes(1088)), note_ct: hex(randomBytes(56)) }));
      leaf += 2;
      txs.push({ height, index: i, tx_hash: hex(randomBytes(32)), tx_type: 'shielded_transfer_v2', nf1: hex(randomDigest()), nf2: hex(randomDigest()), outputs });
    }
    pages.push(JSON.stringify({ active: true, tip_height: tip, from_height: height, next_height: height + 1, txs, success: true }));
  }
  return pages;
}

const NODES = ['https://node-a.example', 'https://node-b.example', 'https://node-c.example'];
const reportsAt = (stats, h) => JSON.stringify(NODES.map((node_id) => ({ node_id, stats: stats.get(h) })));

// ---- a. instantiate ------------------------------------------------------------------------------

// ---- b. keys -------------------------------------------------------------------------------------

async function checkKeys(check, keys, txs, timings) {
  const seeds = {};
  const exposedChecked = new Set();
  for (const w of keys.wallets) {
    const t0 = performance.now();
    const seed = await bip39Seed(w.recovery_phrase, w.passphrase);
    timings.bip39Ms.push(performance.now() - t0);
    seeds[w.name] = seed;
    check('b', `${w.name}: BIP-39 seed from the recovery phrase (Web Crypto PBKDF2) = bip39_seed`, hex(seed) === w.bip39_seed);
    check('b', `${w.name}: transactions.json names the same phrase`, txs.wallets[w.name] === w.recovery_phrase);

    const t1 = performance.now();
    const info = J('shielded_address', seed);
    timings.addressMs.push(performance.now() - t1);
    check('b', `${w.name}: shielded_address().address = address (${w.address.length} chars)`, info.address === w.address);
    check('b', `${w.name}: shielded_address().pk = pk`, info.pk === w.pk);
    check('b', `${w.name}: shielded_address().fingerprint = address_fingerprint`, info.fingerprint === w.address_fingerprint);
    check('b', `${w.name}: parse_address(address) = shielded_address(seed)`, deepEqual(J('parse_address', w.address), info));
    ['address', 'pk', 'address_fingerprint'].forEach((k) => exposedChecked.add(k));

    const t2 = performance.now();
    const key = J('export_scan_key', seed, true);
    timings.scanKeyMs.push(performance.now() - t2);
    const view = J('export_scan_key', seed, false);
    check('b', `${w.name}: export_scan_key().pk = pk`, key.pk === w.pk);
    check('b', `${w.name}: export_scan_key().nk = nk`, key.nk === w.nk);
    check('b', `${w.name}: export_scan_key().dk = ml_kem_768_dk (2,400 bytes)`, key.dk === w.ml_kem_768_dk && key.dk.length === 4800);
    check('b', `${w.name}: viewing key alone: nk null, pk and dk the same`, view.nk === null && view.pk === w.pk && view.dk === w.ml_kem_768_dk);
    ['nk', 'ml_kem_768_dk'].forEach((k) => exposedChecked.add(k));

    // what the address and the decapsulation key carry, byte for byte
    const { hrp, bytes } = bech32mDecode(info.address);
    const version = bytes[0];
    const pk = bytes.slice(1, 33);
    const ek = bytes.slice(33, 33 + 1184);
    const cs = bytes.slice(33 + 1184);
    check('b', `${w.name}: address decodes (bech32m, hrp rshield, ${bytes.length} bytes)`, hrp === 'rshield' && bytes.length === 1 + 32 + 1184 + 8);
    check('b', `${w.name}: address version byte = address_version`, version === w.address_version);
    check('b', `${w.name}: address pk = pk`, hex(pk) === w.pk);
    check('b', `${w.name}: address ek = ml_kem_768_ek`, hex(ek) === w.ml_kem_768_ek);
    check('b', `${w.name}: address check = address_check`, hex(cs) === w.address_check);
    const checkCalc = (await sha256(concat(utf8(w.address_check_tag), new Uint8Array([version]), pk, ek))).slice(0, 8);
    check('b', `${w.name}: SHA-256(address_check_tag ‖ version ‖ pk ‖ ek)[..8] = address_check`, hex(checkCalc) === w.address_check);
    const pkEk = await sha256(concat(pk, ek));
    check('b', `${w.name}: SHA-256(pk ‖ ek) = address_bytes_sha256`, hex(pkEk) === w.address_bytes_sha256);
    check('b', `${w.name}: address_fingerprint = SHA-256(pk ‖ ek)[..8]`, hex(pkEk.slice(0, 8)) === w.address_fingerprint);
    const payloadHash = hex(await sha256(bytes));
    check('b', `${w.name}: SHA-256(version ‖ pk ‖ ek ‖ check) = address_payload_sha256`, payloadHash === w.address_payload_sha256);
    const dk = unhex(key.dk);
    check('b', `${w.name}: SHA-256(dk) = ml_kem_768_dk_sha256`, hex(await sha256(dk)) === w.ml_kem_768_dk_sha256);
    check('b', `${w.name}: dk carries ek (FIPS 203 dk = dk_pke ‖ ek ‖ H(ek) ‖ z)`, hex(dk.slice(1152, 2336)) === w.ml_kem_768_ek);
    check('b', `${w.name}: dk ends with z = ml_kem_768_z`, hex(dk.slice(2368)) === w.ml_kem_768_z);
    check('b', `${w.name}: view_okm = ml_kem_768_d ‖ ml_kem_768_z (vector consistency)`, w.view_okm === w.ml_kem_768_d + w.ml_kem_768_z);
    check('b', `${w.name}: pk_elements = u32 LE words of pk`, deepEqual(u32le(pk), w.pk_elements));
    check('b', `${w.name}: nk_elements = u32 LE words of nk`, deepEqual(u32le(unhex(key.nk)), w.nk_elements));
    ['address_version', 'ml_kem_768_ek', 'address_check', 'address_check_tag', 'address_bytes_sha256', 'address_payload_sha256',
      'ml_kem_768_dk_sha256', 'ml_kem_768_z', 'pk_elements', 'nk_elements', 'bip39_seed', 'recovery_phrase', 'passphrase', 'name',
      'view_okm', 'ml_kem_768_d'].forEach((k) => exposedChecked.add(k));
  }
  const all = Object.keys(keys.wallets[0]);
  const notExposed = all.filter((k) => !exposedChecked.has(k));
  return { seeds, fieldsChecked: all.length - notExposed.length, fieldsTotal: all.length, notExposed };
}

// ---- c. scan / scan_pages / confirm_state over the vector chain -------------------------------------

async function checkScan(check, keys, txs, roots, seeds, timings) {
  const node = await nodeAnswers(txs, roots);
  check('c', 'node-shaped pages: nullifiers and commitments read from the bodies = the vector fields', node.sanity);
  const last = roots.states[roots.states.length - 1].state;
  // expected balances per wallet after each block, from the vector outputs (readable_by)
  // the balance of each wallet after each block, from the vector outputs (readable_by)
  const expected = {
    'wallet-1': ['9000000000', '3000000000', '500000000'],
    'wallet-2': ['0', '5000000000', '5000000000'],
  };
  const results = {};
  for (const w of keys.wallets) {
    const seed = seeds[w.name];
    const key = call('export_scan_key', seed, true);
    // page by page, a state check after each block
    let s = call('new_state', w.address, '', 0);
    let r = J('set_nodes', s, JSON.stringify(NODES), 0);
    check('c', `${w.name}: set_nodes → quorum 2 of 3`, r.quorum === 2 && r.nodes.length === 3);
    s = JSON.stringify(r.state);
    let rev = r.revision;
    r = J('assert_sole_copy', s, true, rev);
    s = JSON.stringify(r.state); rev = r.revision;
    for (const [i, page] of node.pages.entries()) {
      const h = txs.transactions[i].height;
      const t0 = performance.now();
      const sc = J('scan', s, page, key, rev);
      timings.scanOnePageMs.push(performance.now() - t0);
      s = JSON.stringify(sc.state); rev = sc.revision;
      // before the state check: what the page added is unverified; confirmed + unverified is the balance
      check('c', `${w.name}: scan(page of height ${h}) → confirmed + unverified = ${expected[w.name][i]}`,
        BigInt(sc.unverified_balance) + BigInt(sc.confirmed_balance) === BigInt(expected[w.name][i]),
        { unverified: sc.unverified_balance, confirmed: sc.confirmed_balance, at_tip: sc.report.at_tip });
      const t1 = performance.now();
      const c = J('confirm_state', s, reportsAt(node.stats, h), rev);
      timings.confirmMs.push(performance.now() - t1);
      s = JSON.stringify(c.state); rev = c.revision;
      const sum = J('summary', s);
      check('c', `${w.name}: confirm_state(3 raw stats bodies at ${h}) → matched ${h}; confirmed ${expected[w.name][i]}, unverified 0`,
        c.report.matched_height === h && sum.confirmed_balance === expected[w.name][i] && sum.unverified_balance === '0' && c.malformed === 0,
        { matched: c.report.matched_height, confirmed: sum.confirmed_balance, malformed: c.malformed });
    }
    const sum = J('summary', s);
    check('c', `${w.name}: the wallet's tree root = state_root.json tree_root after the last block`, sum.anchor === last.tree_root);
    check('c', `${w.name}: the wallet's nullifier hash and count = state_root.json`, sum.nullifier_acc === last.nullifier_acc && sum.nullifier_count === last.nullifier_count);
    check('c', `${w.name}: the wallet's ciphertext hash = the node-local hash computed in JS`, sum.ciphertext_acc === node.ciphertextAcc);
    check('c', `${w.name}: confirmed height = scanned height = ${node.tip}`, sum.confirmed_height === node.tip && sum.scanned_height === node.tip);
    if (w.name === 'wallet-1') {
      // the change of a transaction that spends the wallet's own note is the wallet's own output: kept
      // although it is below the default minimum note value (1 XRGE), which applies to notes from others
      check('c', 'wallet-1: the 0.5 XRGE change of its own unshield is kept (own output), not counted as dust',
        sum.below_minimum.count === 0 && sum.spendable_balance === '500000000' && sum.notes.filter((n) => !n.spent).length === 1, sum.below_minimum);
    }
    if (w.name === 'wallet-2') {
      check('c', 'wallet-2: spendable 5 XRGE, one confirmed note at leaf 3', sum.spendable_balance === '5000000000' && sum.notes.length === 1 && sum.notes[0].position === 3 && sum.notes[0].confirmed, { spendable: sum.spendable_balance });
      check('c', 'wallet-2: summary.spend.can_spend_now', sum.spend.can_spend_now === true, sum.spend);
      results.spendState = { state: s, revision: rev, position: sum.notes[0].position, anchor: sum.anchor };
    }

    // the same three pages through scan_pages (an array of raw body strings), one call
    let s2 = call('new_state', w.address, '', 0);
    r = J('set_nodes', s2, JSON.stringify(NODES), 0);
    s2 = JSON.stringify(r.state);
    const t2 = performance.now();
    const sp = J('scan_pages', s2, JSON.stringify(node.pages), key, r.revision);
    timings.scanPagesVectorMs.push(performance.now() - t2);
    check('c', `${w.name}: scan_pages(3 raw bodies) → reports for 3 pages, at tip`, sp.report.length === 3 && sp.report[2].at_tip === true);
    const c2 = J('confirm_state', JSON.stringify(sp.state), reportsAt(node.stats, node.tip), sp.revision);
    const sum2 = J('summary', JSON.stringify(c2.state));
    const want2 = expected[w.name][2];
    check('c', `${w.name}: scan_pages + one confirm_state at the tip → confirmed ${want2}`,
      sum2.confirmed_balance === want2 && c2.report.matched_height === node.tip, { confirmed: sum2.confirmed_balance });
    check('c', `${w.name}: scan_pages state = page-by-page state (root, nullifier hash, ciphertext hash)`,
      sum2.anchor === sum.anchor && sum2.nullifier_acc === sum.nullifier_acc && sum2.ciphertext_acc === sum.ciphertext_acc);
    // a state report from only one configured node confirms nothing
    const s3 = JSON.stringify(sp.state);
    const one = J('confirm_state', s3, JSON.stringify([{ node_id: NODES[0], stats: node.stats.get(node.tip) }]), sp.revision);
    check('c', `${w.name}: one node's report alone confirms nothing (quorum 2 of 3)`, one.report.matched_height === null);
    if (w.name === 'wallet-1') {
      const view = call('export_scan_key', seed, false);
      let s4 = call('new_state', w.address, '', 0);
      const sv = J('scan_pages', s4, JSON.stringify(node.pages), view, 0);
      check('c', 'wallet-1, viewing key only: spends unseen (unverified_spends), nothing spendable', sv.unverified_spends === true && sv.spendable_balance === '0',
        { unverified: sv.unverified_balance, received_spend_unknown: sv.received_spend_unknown });
    }
  }
  return { node, ...results };
}

// ---- f. malformed input ----------------------------------------------------------------------------

function checkMalformed(check, keys, seeds, node) {
  const SEED = seeds['wallet-1'];
  const address = keys.wallets[0].address;
  const state = call('new_state', address, '', 0);
  const key = call('export_scan_key', SEED, true);
  const page = node.pages[0];
  const tally = { calls: 0, coded: 0, okAllowed: 0, traps: 0, uncoded: 0, unexpectedOk: 0, codes: {} };
  const failures = [];
  const exportsTouched = new Set();
  const run = (mode, name, ...args) => {
    tally.calls += 1;
    exportsTouched.add(name);
    try {
      const r = call(name, ...args);
      if (mode === 'coded') { tally.unexpectedOk += 1; if (failures.length < 20) failures.push({ name, kind: 'ok where an error was expected' }); }
      else tally.okAllowed += 1;
      return r;
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) { tally.traps += 1; if (failures.length < 20) failures.push({ name, kind: 'TRAP' }); return null; }
      const m = String(e && e.message);
      const code = /^([a-z_]+):/.exec(m);
      if (code) { tally.coded += 1; tally.codes[code[1]] = (tally.codes[code[1]] || 0) + 1; }
      else { tally.uncoded += 1; if (failures.length < 20) failures.push({ name, kind: 'uncoded', message: m.slice(0, 80) }); }
      return null;
    }
  };
  const rev = (s) => { try { return JSON.parse(call('summary', s)).revision; } catch { return 0; } };
  const junk = ['', ' ', '{', '}', '{}', '[]', 'null', '0', '-1', '1e999', '""', '\u0000', 'rshield1', 'rouge1', 'rshield1qqqqqq',
    '{"a":', '[[[[[[', 'f'.repeat(100000), '\u{1f600}', '18446744073709551616', '0x10', '+1', '1.5',
    // browser-side extras: a lone surrogate (TextEncoder turns it into U+FFFD), deep nesting, a huge string member
    '\ud800', '['.repeat(10000), '{"x":"' + 'a'.repeat(1 << 20) + '"}'];
  const Z = '00'.repeat(32);
  for (const seed of [new Uint8Array(0), new Uint8Array(1), new Uint8Array(63), new Uint8Array(65), new Uint8Array(4096)]) {
    run('coded', 'shielded_address', seed);
    run('coded', 'export_scan_key', seed, true);
    run('coded', 'build_transfer', seed, state, '{}', rev(state));
    run('coded', 'build_unshield', seed, state, '{}', rev(state));
  }
  for (const j of junk) {
    run('coded', 'parse_address', j);
    run('coded', 'new_state', j, '', 0);
    run('coded', 'scan', j, page, key, rev(j));
    run('coded', 'scan', state, j, key, rev(state));
    run('coded', 'scan', state, page, j, rev(state));
    run('coded', 'summary', j);
    run('coded', 'plan_payment', j, '1', '1', true);
    // as the native corpus: only where Rust's `str::parse::<u64>` refuses the text ("+1" it accepts)
    if (!/^\+?\d+$/.test(j) || BigInt(j.replace('+', '')) > 18446744073709551615n) {
      run('coded', 'plan_payment', state, j, '1', true);
      run('coded', 'plan_payment', state, '1', j, true);
      run('coded', 'plan_self_merge', state, j, true);
    }
    run('coded', 'plan_self_merge', j, '1', true);
    run('coded', 'scan_pages', j, '[]', key, rev(j));
    if (j.trim() !== '') run('coded', 'scan_pages', state, `[${j}]`, key, rev(state));
    if (j !== '[]') run('coded', 'scan_pages', state, j, key, rev(state));
    run('coded', 'pending', j);
    run('coded', 'resolve_pending', j, rev(j));
    run('coded', 'rescan_state', j, '', 0, rev(j));
    run('coded', 'note_rejection', j, Z, rev(j));
    run('coded', 'note_rejection', state, j, rev(state));
    run('coded', 'confirm_state', j, '[]', rev(j));
    if (j !== '[]') run('coded', 'confirm_state', state, j, rev(state));
    // a malformed REPORT is one node's problem: the call succeeds and counts it
    for (const bad of [
      { node_id: NODES[0], height: 0, tree_root: j, nullifier_acc: Z, note_count: 0, nullifier_count: 0, ciphertext_acc: Z },
      { node_id: NODES[0], stats: j },
      j,
    ]) {
      const r = run('ok', 'confirm_state', state, JSON.stringify([bad]), rev(state));
      if (r !== null && JSON.parse(r).malformed > 1) failures.push({ name: 'confirm_state', kind: 'malformed count above 1' });
    }
    run('coded', 'set_nodes', j, '[]', rev(j));
    if (j !== '[]') run('coded', 'set_nodes', state, j, rev(state));
    run('coded', 'set_nodes', state, JSON.stringify([j]), rev(state));
    run('coded', 'abandon_unsubmitted', j, Z, rev(j));
    run('coded', 'abandon_unsubmitted', state, j, rev(state));
    if (!['', '1'].includes(j)) run('coded', 'new_state', address, j, 0);
    run('coded', 'build_shield', j);
    run('coded', 'build_transfer', SEED, j, '{}', rev(j));
    run('coded', 'build_transfer', SEED, state, j, rev(state));
    run('coded', 'build_unshield', SEED, state, j, rev(state));
    run('coded', 'attach_signature', j, 'ab');
    // the five exports the native corpus does not name
    run('coded', 'assert_sole_copy', j, true, rev(j));
    run('coded', 'can_spend_now', j, -1);
    run('coded', 'expect_revision_id', j, Z);
    run('coded', 'expect_revision_id', state, j);
    run('ok', 'recover_locks', j);
    run('coded', 'build_own_shield', j, address, '{}', rev(j));
    run('coded', 'build_own_shield', state, j, '{}', rev(state));
    run('coded', 'build_own_shield', state, address, j, rev(state));
  }
  // expected_revision that is not a revision
  const nodesJson = JSON.stringify(NODES);
  for (const bad of [-1, 0.5, NaN, Infinity, -Infinity, 1e300]) {
    run('coded', 'set_nodes', state, nodesJson, bad);
    run('coded', 'build_transfer', SEED, state, '{}', bad);
    run('coded', 'scan', state, page, key, bad);
    run('coded', 'resolve_pending', state, bad);
  }
  run('coded', 'assert_sole_copy', state, false, 0);
  // well-formed JSON with wrong contents
  const anchor = JSON.parse(call('summary', state)).anchor;
  const base = { chain_id: 'test', anchor, expiry_height: 5, inputs: [0], recipient: address, amount: '1', fee: '1000000000' };
  for (const [field, bad] of [['anchor', 'zz'], ['anchor', 'ff'.repeat(32)], ['anchor', 5], ['chain_id', ''], ['expiry_height', -1],
    ['expiry_height', '5'], ['inputs', []], ['inputs', [0, 1, 2]], ['inputs', [7]], ['inputs', '0'], ['recipient', 'rshield1qqqq'],
    ['amount', 1], ['amount', '-1'], ['fee', '1e9'], ['max_fee', 5], ['max_fee', 'x'], ['anchor_height', '1'], ['anchor_height', -1]]) {
    run('coded', 'build_transfer', SEED, state, JSON.stringify({ ...base, [field]: bad }), rev(state));
  }
  const accountKey = hex(Uint8Array.from({ length: 1952 }, (_, i) => i % 251));
  const shield = { chain_id: 'test', anchor, anchor_height: 1, expiry_height: 5, from_pub_key: accountKey, nonce: 1, v_in: '3000000000', fee: '1000000000', recipient: address };
  for (const [field, bad] of [['from_pub_key', 'ab'], ['from_pub_key', 'AB'.repeat(1952)], ['from_pub_key', 'zz'.repeat(1952)],
    ['v_in', '1000000000'], ['v_in', '0'], ['fee', '0'], ['nonce', '1'], ['recipient', address.toUpperCase() + 'x']]) {
    run('coded', 'build_shield', JSON.stringify({ ...shield, [field]: bad }));
  }
  const k = JSON.parse(key);
  for (const [field, bad] of [['pk', '00'], ['nk', 'ff'.repeat(32)], ['dk', '00'.repeat(2399)], ['dk', 'ff'.repeat(2400)]]) {
    run('coded', 'scan', state, page, JSON.stringify({ ...k, [field]: bad }), rev(state));
  }
  const edited = JSON.parse(state);
  edited.tree.frontier = [];
  run('coded', 'scan', JSON.stringify(edited), page, key, 0);
  run('coded', 'summary', JSON.stringify(edited));
  run('ok', 'constants');
  // still alive and still right after all of it
  const again = J('shielded_address', SEED);
  check('f', `${tally.calls} malformed calls over ${exportsTouched.size} of 26 exports: every expected refusal is a coded error`,
    tally.uncoded === 0 && tally.unexpectedOk === 0, { coded: tally.coded, okAllowed: tally.okAllowed, uncoded: tally.uncoded, unexpectedOk: tally.unexpectedOk, failures });
  check('f', 'no call trapped (WebAssembly.RuntimeError)', tally.traps === 0, { traps: tally.traps });
  check('f', 'the module still answers correctly after the corpus', again.address === address);
  return { ...tally, exportsTouched: exportsTouched.size };
}

// ---- d / e. proving in the worker ------------------------------------------------------------------

async function proveInWorker(check, keys, txs, seeds, spend, timings, reps = 3) {
  const { worker, ask } = startWorker();
  const init = await ask({ cmd: 'init', moduleUrl: PKG, wasmUrl: WASM, secrets });
  check('a', 'instantiated inside a module Web Worker', init.ok, init.ok ? { instantiateMs: init.instantiateMs } : init.error);
  timings.worker = { importMs: init.importMs, instantiateMs: init.instantiateMs, memoryBytesAfterInit: init.memoryBytes };
  const SEED2 = seeds['wallet-2'];
  const w1 = keys.wallets[0].address;
  const unshieldTo = txs.transactions.find((t) => t.tx_type === 'unshield_v2').recipient_address;
  const chain_id = txs.chain_id;
  const tip = txs.transactions[txs.transactions.length - 1].height;
  const accountKey = hex(Uint8Array.from({ length: 1952 }, (_, i) => (29 * i + 0xa5) % 256));
  const plan = J('plan_payment', spend.state, '2000000000', '1000000000', false);
  check('d', 'plan_payment(2 XRGE, fee 1) on the confirmed wallet-2 state → ok, one input', plan.status === 'ok' && deepEqual(plan.selection.positions, [spend.position]), plan);

  const jobs = {
    shield_v2: { fn: 'build_shield', args: [JSON.stringify({ chain_id, anchor: spend.anchor, anchor_height: tip, from_pub_key: accountKey, nonce: 1, v_in: '3000000000', fee: '1000000000', recipient: w1 })] },
    shielded_transfer_v2: { fn: 'build_transfer', args: [SEED2, spend.state, JSON.stringify({ chain_id, inputs: [spend.position], recipient: w1, amount: '2000000000', fee: '1000000000' }), spend.revision] },
    unshield_v2: { fn: 'build_unshield', args: [SEED2, spend.state, JSON.stringify({ chain_id, inputs: [spend.position], to: unshieldTo, v_out: '1500000000', fee: '1000000000' }), spend.revision] },
  };
  // the UI thread stays responsive while the worker proves: the largest gap of a 20 ms timer
  let lastTick = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastTick); lastTick = now; }, 20);
  const envelopes = [];
  const prove = {};
  for (const [type, job] of Object.entries(jobs)) {
    prove[type] = { ms: [], memoryBytes: [], rngCalls: [], rngBytes: [], mathRandomCalls: 0, proofBytes: [] };
    for (let i = 0; i < reps; i++) {
      const r = await ask({ cmd: 'build', fn: job.fn, args: job.args });
      if (!r.ok) { check('d', `${type} #${i + 1} built in the worker`, false, r.error); continue; }
      const built = JSON.parse(r.result);
      prove[type].ms.push(r.ms);
      prove[type].memoryBytes.push(r.memoryBytes);
      prove[type].rngCalls.push(r.rngCalls);
      prove[type].rngBytes.push(r.rngBytes);
      prove[type].mathRandomCalls += r.mathRandomCalls;
      prove[type].proofBytes.push(built.proof.length / 2);
      if (i === 0) {
        check('d', `${type}: built in the worker (tx_type, 2,546-byte body, needs_account_signature ${type === 'shield_v2'})`,
          built.tx_type === type && built.body.length === 5092 && built.needs_account_signature === (type === 'shield_v2'));
        if (type !== 'shield_v2') {
          const locked = J('summary', JSON.stringify(built.state));
          check('d', `${type}: the returned state holds the input locked (revision +1, locked 5 XRGE, one pending entry)`,
            built.revision === spend.revision + 1 && locked.locked_balance === '5000000000' && locked.pending.length === 1);
        }
      }
      let envelope = built.envelope_json;
      if (type === 'shield_v2') envelope = call('attach_signature', envelope, '0a0b'); // a placeholder signature: the node's stateless rule does not verify it (its signature path does)
      envelopes.push({ label: `${type} #${i + 1}`, type, envelope_json: envelope, public_inputs: built.public_inputs });
    }
    const p = prove[type];
    check('d', `${type}: ${reps} proofs in the worker, crypto.getRandomValues called every time, Math.random never`,
      p.ms.length === reps && p.rngCalls.every((n) => n > 0) && p.mathRandomCalls === 0, { rngCalls: p.rngCalls, rngBytes: p.rngBytes, mathRandomCalls: p.mathRandomCalls });
    timings.prove[type] = { medianMs: median(p.ms), ms: p.ms, proofBytes: p.proofBytes, memoryBytesAfter: p.memoryBytes };
  }
  clearInterval(timer);
  timings.uiMaxGapMsWhileProving = maxGap;
  const rep = await ask({ cmd: 'report' });
  timings.worker.memoryBytesAtEnd = rep.memoryBytes;
  timings.worker.performanceMemory = init.hasPerformanceMemory ? 'available' : 'unavailable in a dedicated worker';
  timings.worker.measureUserAgentSpecificMemory = init.hasMeasureUserAgentSpecificMemory ? 'available in the worker' : 'not exposed in a dedicated worker';
  return { worker, envelopes, workerReport: rep };
}

// ---- entry points ----------------------------------------------------------------------------------

async function runAll() {
  const { list, check } = makeChecks();
  const timings = { bip39Ms: [], addressMs: [], scanKeyMs: [], scanOnePageMs: [], confirmMs: [], scanPagesVectorMs: [], prove: {} };
  const { keys, txs, roots } = await loadVectors();
  secrets = [];
  for (const w of keys.wallets) {
    secrets.push({ label: `${w.name} sk`, hex: w.sk }, { label: `${w.name} sk_okm`, hex: w.sk_okm }, { label: `${w.name} bip39 seed`, hex: w.bip39_seed });
  }
  // a. instantiate on the main thread
  const inst = await instantiateMain();
  timings.main = inst;
  const missing = EXPORTS.filter((n) => typeof wasm[n] !== 'function');
  check('a', 'instantiated on the main thread (wasm-bindgen --target web, init({ module_or_path }))', true, inst);
  check('a', 'all 26 exports present', missing.length === 0, { missing });
  const constants = J('constants');
  check('a', 'constants(): min fee 1 XRGE', constants.min_fee_quanta === '1000000000');
  // b
  const k = await checkKeys(check, keys, txs, timings);
  timings.keyFields = { checked: k.fieldsChecked, total: k.fieldsTotal, notExposed: k.notExposed };
  // c
  const scan = await checkScan(check, keys, txs, roots, k.seeds, timings);
  // c (timing): foreign traffic
  const FOREIGN_PAGES = 16; const PER_PAGE = 8;
  const foreign = foreignPages(FOREIGN_PAGES, PER_PAGE, 100);
  {
    const key = call('export_scan_key', k.seeds['wallet-1'], true);
    const s0 = call('new_state', keys.wallets[0].address, '', 0);
    let t0 = performance.now();
    const all = J('scan_pages', s0, JSON.stringify(foreign), key, 0);
    const pagesMs = performance.now() - t0;
    let s = s0; let rev = 0;
    t0 = performance.now();
    for (const p of foreign) { const r = J('scan', s, p, key, rev); s = JSON.stringify(r.state); rev = r.revision; }
    const loopMs = performance.now() - t0;
    check('c', `foreign listing: ${FOREIGN_PAGES} pages × ${PER_PAGE} transactions (${FOREIGN_PAGES * PER_PAGE * 2} outputs) scanned, nothing received`,
      all.report.length === FOREIGN_PAGES && all.unverified_balance === '0' && J('summary', s).note_count === FOREIGN_PAGES * PER_PAGE * 2);
    timings.foreignScan = { pages: FOREIGN_PAGES, txs: FOREIGN_PAGES * PER_PAGE, outputs: FOREIGN_PAGES * PER_PAGE * 2, scanPagesMs: pagesMs, scanLoopMs: loopMs, perOutputMs: pagesMs / (FOREIGN_PAGES * PER_PAGE * 2) };
  }
  // f (main thread; quick)
  const mal = checkMalformed(check, keys, k.seeds, scan.node);
  // d (worker)
  const rngMainBefore = { ...counters };
  const proved = await proveInWorker(check, keys, txs, k.seeds, scan.spendState, timings);
  // (a proof on the UI thread would show a gap of the proof's length, seconds; what remains is the
  // scheduler of a loaded 2-vCPU host sharing two cores between the worker, the page and the node)
  check('d', 'the UI thread stayed responsive while the worker proved (largest 20 ms timer gap < 1 s; a proof takes seconds)', timings.uiMaxGapMsWhileProving < 1000, { maxGapMs: timings.uiMaxGapMsWhileProving });
  // g
  const allConsole = [...consoleSeen.map((c) => ({ ...c, thread: 'main' })), ...proved.workerReport.consoleSeen.map((c) => ({ ...c, thread: 'worker' }))];
  const secretHexes = [...secrets, ...keys.wallets.flatMap((w) => [{ label: `${w.name} nk`, hex: w.nk }, { label: `${w.name} dk`, hex: w.ml_kem_768_dk }, { label: `${w.name} view_okm`, hex: w.view_okm }])];
  const consoleLeaks = allConsole.filter((c) => secretHexes.some((s) => c.text.includes(s.hex)) || keys.wallets.some((w) => c.text.includes(w.recovery_phrase)));
  check('g', `console: ${allConsole.length} messages written by the package (main + worker), none holds a secret`, consoleLeaks.length === 0, { messages: allConsole.length, leaks: consoleLeaks.length });
  const allLeaks = [...leaks, ...proved.workerReport.leaks];
  check('g', `no result or error of ${callCount} main-thread calls and the worker's builds contains sk, sk_okm or the seed in hex`, allLeaks.length === 0, { leaks: allLeaks });
  check('d', 'main thread: Math.random never called by the package', counters.mathRandomCalls === 0, { mainRngCalls: counters.rngCalls, mainMathRandom: counters.mathRandomCalls });
  timings.mainRng = { getRandomValuesCalls: counters.rngCalls, bytes: counters.rngBytes, duringWorkerProving: counters.rngCalls - rngMainBefore.rngCalls };
  timings.performanceMemoryMain = typeof performance.memory !== 'undefined' ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null;
  timings.crossOriginIsolated = self.crossOriginIsolated === true;
  proved.worker.terminate();
  return { checks: list, timings, malformed: mal, envelopes: proved.envelopes, consoleMessages: allConsole.length, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null };
}

/** A cross-origin-isolated page: one transfer in a worker, then the browser's own memory measurement. */
async function runMemory() {
  const { keys, txs, roots } = await loadVectors();
  secrets = keys.wallets.map((w) => ({ label: `${w.name} sk`, hex: w.sk }));
  await instantiateMain();
  const { list, check } = makeChecks();
  const timings = { bip39Ms: [], addressMs: [], scanKeyMs: [], scanOnePageMs: [], confirmMs: [], scanPagesVectorMs: [], prove: {} };
  const k = await checkKeys(check, keys, txs, timings);
  const scan = await checkScan(check, keys, txs, roots, k.seeds, timings);
  const out = { crossOriginIsolated: self.crossOriginIsolated === true, checksPassed: list.every((c) => c.pass) };
  const { worker, ask } = startWorker();
  const init = await ask({ cmd: 'init', moduleUrl: PKG, wasmUrl: WASM, secrets });
  out.workerCrossOriginIsolated = init.crossOriginIsolated;
  const r = await ask({ cmd: 'build', fn: 'build_transfer', args: [k.seeds['wallet-2'], scan.spendState.state, JSON.stringify({ chain_id: txs.chain_id, inputs: [scan.spendState.position], recipient: keys.wallets[0].address, amount: '2000000000', fee: '1000000000' }), scan.spendState.revision] });
  out.transferBuilt = r.ok;
  out.transferMs = r.ms;
  out.workerWasmMemoryBytes = r.memoryBytes;
  if (typeof performance.measureUserAgentSpecificMemory === 'function') {
    try {
      const m = await performance.measureUserAgentSpecificMemory();
      out.measureUserAgentSpecificMemory = {
        bytes: m.bytes,
        breakdown: m.breakdown.filter((b) => b.bytes > 0).map((b) => ({ bytes: b.bytes, types: b.types, scope: b.attribution.map((a) => a.scope) })),
      };
    } catch (e) {
      out.measureUserAgentSpecificMemory = { error: String(e && e.message) };
    }
  } else {
    out.measureUserAgentSpecificMemory = 'unavailable';
  }
  worker.terminate();
  return out;
}

window.harness = { runAll, runMemory };
document.getElementById('go')?.addEventListener('click', async () => {
  const out = document.getElementById('out');
  out.textContent = 'running…';
  try {
    const r = await runAll();
    r.envelopes = r.envelopes.map((e) => ({ label: e.label, bytes: e.envelope_json.length }));
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    out.textContent = 'error: ' + (e && e.message);
  }
});
