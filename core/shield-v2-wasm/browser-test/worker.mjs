// Web Worker (module) of the browser harness: instantiates the wasm-bindgen `--target web`
// package OFF the UI thread and builds (proves) transactions there, as UI_CONTRACT / NOTES §6
// item 2 require of a client. Messages: { id, cmd, ... } → { id, ok, ... }.
//
// Before the package is imported, `crypto.getRandomValues` is wrapped (counted) and
// `Math.random` is wrapped (counted: the package must never call it), and `console` is wrapped
// so that anything the module writes can be checked for secrets by the page.

const counters = { rngCalls: 0, rngBytes: 0, mathRandomCalls: 0 };
const consoleSeen = [];

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
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    consoleSeen.push({ level, text: args.map(String).join(' ') });
    real(...args);
  };
}

let wasm = null;
let exportsOfInstance = null;
let secrets = [];
const leaks = [];

function scan(name, text) {
  if (typeof text !== 'string') return;
  for (const s of secrets) if (text.includes(s.hex)) leaks.push({ export: name, secret: s.label, thread: 'worker' });
}

function call(name, ...args) {
  try {
    const r = wasm[name](...args);
    scan(name, r);
    return r;
  } catch (e) {
    scan(name, e && e.message);
    throw e;
  }
}

const memoryBytes = () => (exportsOfInstance && exportsOfInstance.memory ? exportsOfInstance.memory.buffer.byteLength : null);

self.onmessage = async (event) => {
  const msg = event.data;
  const reply = (body) => self.postMessage({ id: msg.id, ...body });
  try {
    if (msg.cmd === 'init') {
      secrets = msg.secrets;
      const t0 = performance.now();
      wasm = await import(msg.moduleUrl);
      const t1 = performance.now();
      exportsOfInstance = await wasm.default({ module_or_path: msg.wasmUrl });
      const t2 = performance.now();
      const constants = JSON.parse(call('constants'));
      reply({
        ok: true,
        importMs: t1 - t0,
        instantiateMs: t2 - t1,
        memoryBytes: memoryBytes(),
        minFee: constants.min_fee_quanta,
        hasPerformanceMemory: typeof performance.memory !== 'undefined',
        hasMeasureUserAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
        crossOriginIsolated: self.crossOriginIsolated === true,
      });
    } else if (msg.cmd === 'build') {
      const before = { ...counters };
      const t0 = performance.now();
      let result = null;
      let error = null;
      try {
        result = call(msg.fn, ...msg.args);
      } catch (e) {
        error = { message: String(e && e.message), trap: e instanceof WebAssembly.RuntimeError };
      }
      const ms = performance.now() - t0;
      reply({
        ok: error === null,
        result,
        error,
        ms,
        memoryBytes: memoryBytes(),
        rngCalls: counters.rngCalls - before.rngCalls,
        rngBytes: counters.rngBytes - before.rngBytes,
        mathRandomCalls: counters.mathRandomCalls - before.mathRandomCalls,
      });
    } else if (msg.cmd === 'report') {
      reply({ ok: true, counters: { ...counters }, consoleSeen, leaks, memoryBytes: memoryBytes() });
    } else {
      reply({ ok: false, error: { message: 'unknown command' } });
    }
  } catch (e) {
    reply({ ok: false, error: { message: String(e && e.message), trap: e instanceof WebAssembly.RuntimeError } });
  }
};
