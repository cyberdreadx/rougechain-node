// Tiny shared CLI helpers (no dependencies).

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Parse `--flag value`, `--flag=value` and boolean `--flag` arguments.
 * `spec` maps a flag name to 'string' | 'boolean' | 'list' (repeatable). Unknown flags throw.
 */
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (const [k, t] of Object.entries(spec)) if (t === 'list') out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const type = spec[name];
    if (!type) throw new Error(`unknown option --${name}`);
    if (type === 'boolean') {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      out[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (type === 'list') out[name].push(value);
    else if (name in out) throw new Error(`--${name} given twice`);
    else out[name] = value;
  }
  return out;
}

export function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('no terminal to prompt on'));
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      // Do not echo what is typed.
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer);
    });
  });
}

/**
 * Obtain the key-file passphrase: `--passphrase-file <path>` (first line), else the
 * RELEASE_KEY_PASSPHRASE environment variable, else a hidden terminal prompt.
 */
export async function getPassphrase(args, { confirm = false } = {}) {
  if (args['passphrase-file']) return readFileSync(args['passphrase-file'], 'utf8').split(/\r?\n/)[0];
  if (process.env.RELEASE_KEY_PASSPHRASE) return process.env.RELEASE_KEY_PASSPHRASE;
  const p = await ask('Key file passphrase: ', { hidden: true });
  if (confirm) {
    const again = await ask('Repeat passphrase: ', { hidden: true });
    if (again !== p) throw new Error('passphrases do not match');
  }
  return p;
}

/** Ask the operator to type an exact word. Returns true only on an exact match. */
export async function confirmWord(question, word) {
  const answer = await ask(question);
  return answer.trim() === word;
}
