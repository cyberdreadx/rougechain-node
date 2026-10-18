#!/usr/bin/env node
// Playwright driver of the browser harness (see README.md).
//
//   node run.mjs --verifier <path to the built shield-v2-browser-verifier> [--out result.json]
//
// Environment:
//   PLAYWRIGHT_MODULE  path of the `playwright` package to load (default: `playwright` from the
//                      resolution path, e.g. NODE_PATH)
//   CHROMIUM_LIBS      extra library directory for Chromium (LD_LIBRARY_PATH of the browser only)
//
// 1. Serves core/ (only the three directories the page needs) on 127.0.0.1, a random free port,
//    with `application/wasm` for .wasm and `text/javascript` for .mjs/.js; WITHOUT COOP/COEP.
// 2. Headless Chromium: window.harness.runAll() — checks a–g, timings, the built envelopes.
// 3. Hands the envelopes to the native verifier (the node's stateless rule + verify_spend + pool rules).
// 4. A second server WITH COOP/COEP (cross-origin isolation): window.harness.runMemory() — the
//    browser's own memory measurement (performance.measureUserAgentSpecificMemory needs isolation).
// 5. Prints a summary, writes the full result as JSON, exits non-zero if any check failed.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '../..');
const ALLOWED = ['/shield-v2-wasm/browser-test/', '/shield-v2-wasm/pkg/', '/shield-v2/vectors/wallet/'];
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.ts': 'text/plain; charset=utf-8' };

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const verifier = arg('--verifier');
const outFile = arg('--out', path.join(os.tmpdir(), 'shield-v2-wasm-browser-result.json'));

function serve(isolated) {
  const served = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const file = path.resolve(CORE, '.' + p);
    const inside = ALLOWED.some((a) => p.startsWith(a)) && file.startsWith(CORE + path.sep) && !p.includes('/verifier/');
    if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
    if (isolated) { headers['cross-origin-opener-policy'] = 'same-origin'; headers['cross-origin-embedder-policy'] = 'require-corp'; }
    served.push({ path: p, type: headers['content-type'] });
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, served })));
}

/** Peak resident memory (VmHWM) of every process below this one: the browser's processes. */
function descendantsPeak() {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch { /* gone */ }
  }
  const out = [];
  const walk = (pid) => {
    for (const c of kids.get(pid) || []) {
      try {
        const status = fs.readFileSync(`/proc/${c}/status`, 'utf8');
        const cmd = fs.readFileSync(`/proc/${c}/cmdline`, 'utf8').replace(/\0/g, ' ');
        const type = /--type=(\S+)/.exec(cmd)?.[1] || (/node\b/.test(cmd.split(' ')[0]) ? 'node' : 'browser');
        const hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] || 0);
        const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0);
        out.push({ pid: c, type, vmHwmKiB: hwm, vmRssKiB: rss });
      } catch { /* gone */ }
      walk(c);
    }
  };
  walk(process.pid);
  return out;
}

const loadPlaywright = async () => {
  const m = process.env.PLAYWRIGHT_MODULE ? await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href) : await import('playwright');
  return m.chromium || m.default.chromium;
};

const sizes = () => {
  const pkg = path.join(CORE, 'shield-v2-wasm/pkg');
  const w = fs.readFileSync(path.join(pkg, 'quantum_vault_shield_v2_wasm_bg.wasm'));
  const js = fs.readFileSync(path.join(pkg, 'quantum_vault_shield_v2_wasm.js'));
  return { wasmBytes: w.length, wasmGzip9: zlib.gzipSync(w, { level: 9 }).length, wasmBrotli: zlib.brotliCompressSync(w).length, glueJsBytes: js.length };
};

async function main() {
  if (!verifier || !fs.existsSync(verifier)) throw new Error('--verifier <built binary> is required');
  const chromium = await loadPlaywright();
  const env = { ...process.env };
  if (process.env.CHROMIUM_LIBS) env.LD_LIBRARY_PATH = [process.env.CHROMIUM_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const result = { sizes: sizes(), host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, load: os.loadavg(), totalMemMiB: Math.round(os.totalmem() / 2 ** 20) } };
  const consoleEvents = [];
  const pageErrors = [];
  let browser = null;
  const servers = [];
  try {
    browser = await chromium.launch({ env, args: ['--enable-blink-features=ForceEagerMeasureMemory'] });
    result.browserVersion = browser.version();

    // ---- phase A: the check list, not isolated -----------------------------------------------------
    const a = await serve(false);
    servers.push(a.server);
    const page = await browser.newPage();
    page.on('console', (m) => consoleEvents.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
    await page.goto(`http://127.0.0.1:${a.port}/shield-v2-wasm/browser-test/index.html`);
    const t0 = Date.now();
    const run = await page.evaluate(() => window.harness.runAll());
    result.phaseAWallSeconds = (Date.now() - t0) / 1000;
    result.processesAfterProving = descendantsPeak();
    await page.close();
    result.servedTypes = Object.fromEntries(a.served.map((s) => [path.extname(s.path), s.type]));
    result.browser = { userAgent: run.userAgent, hardwareConcurrency: run.hardwareConcurrency, deviceMemory: run.deviceMemory };
    result.checks = run.checks;
    result.timings = run.timings;
    result.malformed = run.malformed;

    // ---- the node's side: the native verifier ----------------------------------------------------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-v2-browser-'));
    const envFile = path.join(tmp, 'envelopes.json');
    fs.writeFileSync(envFile, JSON.stringify(run.envelopes));
    const v = spawnSync(verifier, [path.join(CORE, 'shield-v2/vectors/wallet'), envFile], { encoding: 'utf8', maxBuffer: 64 << 20 });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (v.status !== 0) throw new Error('verifier failed: ' + v.stderr);
    const native = JSON.parse(v.stdout);
    result.native = native;
    const check = (group, name, pass, detail) => result.checks.push({ group, name, pass: !!pass, detail: detail ?? null });
    check('e', 'verifier built without the prover (default features, as the node)', native.prover_compiled === false);
    check('e', `vector chain replayed through the node's body parser and pool rules = state_root.json at every height`, native.replay_ok, native.replay);
    for (const e of native.envelopes) {
      const ok = e.envelope === 'ok' && e.stateless_rule === 'ok' && e.public_inputs_match === true && e.verify_proof === 'ok' && e.pool_rules === 'ok';
      check('e', `${e.label}: TxV1 parses; shield_v2_tx_rule ok at height ${e.height}; public inputs = the browser's; verify_spend ok; pool rules ok`, ok,
        { stateless_rule: e.stateless_rule, verify_proof: e.verify_proof, pool_rules: e.pool_rules, proof_bytes: e.proof_bytes });
    }
    check('e', `${native.envelopes.length} envelopes handed to the verifier`, native.envelopes.length === run.envelopes.length && run.envelopes.length === 9);

    // ---- console, as Playwright saw it (worker messages included) ----------------------------------
    check('g', `Playwright console events: ${consoleEvents.length}; page errors: ${pageErrors.length}`, pageErrors.length === 0, { consoleEvents: consoleEvents.slice(0, 10), pageErrors });

    // ---- phase B: cross-origin isolated, the browser's memory measurement -------------------------
    const b = await serve(true);
    servers.push(b.server);
    const page2 = await browser.newPage();
    page2.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
    await page2.goto(`http://127.0.0.1:${b.port}/shield-v2-wasm/browser-test/index.html`);
    result.memory = await page2.evaluate(() => window.harness.runMemory());
    result.processesAfterIsolatedRun = descendantsPeak();
    await page2.close();
  } finally {
    if (browser) await browser.close();
    for (const s of servers) s.close();
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  const failed = result.checks.filter((c) => !c.pass);
  const byGroup = {};
  for (const c of result.checks) { byGroup[c.group] ??= { pass: 0, fail: 0 }; byGroup[c.group][c.pass ? 'pass' : 'fail'] += 1; }
  console.log(JSON.stringify({ byGroup, failed: failed.map((c) => ({ group: c.group, name: c.name, detail: c.detail })), resultFile: outFile }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
