/**
 * The local test chain: the node's contract VM compiled to WebAssembly (core/vm-wasm, built by
 * core/vm-wasm/build.sh into ./vm). Loaded on demand — only the IDE page pays for it.
 */
import type { LocalChain } from "./vm/quantum_vault_vm_wasm.js";

export type { LocalChain };

let loading: Promise<typeof import("./vm/quantum_vault_vm_wasm.js")> | null = null;

async function loadModule() {
  const mod = await import("./vm/quantum_vault_vm_wasm.js");
  const { default: url } = await import("./vm/quantum_vault_vm_wasm_bg.wasm?url");
  await mod.default({ module_or_path: url });
  return mod;
}

/** A fresh local chain (`rougechain-local-1`), clock at the current time. */
export async function newLocalChain(): Promise<LocalChain> {
  loading ??= loadModule().catch((e) => {
    loading = null;
    throw e;
  });
  const mod = await loading;
  return new mod.LocalChain("rougechain-local-1", BigInt(Math.floor(Date.now() / 1000)));
}

export const QUANTA_PER_XRGE = 1_000_000_000n;

/** "1234500000" quanta → "1.2345" XRGE (exact, trailing zeros trimmed). */
export function formatXrge(quanta: string | bigint): string {
  const q = typeof quanta === "bigint" ? quanta : BigInt(quanta);
  const neg = q < 0n;
  const a = neg ? -q : q;
  const whole = a / QUANTA_PER_XRGE;
  const frac = (a % QUANTA_PER_XRGE).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** "1.5" XRGE → "1500000000" quanta; null if it isn't a non-negative number with ≤ 9 decimals. */
export function parseXrge(text: string): string | null {
  const m = /^\s*(\d+)(?:\.(\d{1,9}))?\s*$/.exec(text);
  if (!m) return null;
  return (BigInt(m[1]) * QUANTA_PER_XRGE + BigInt((m[2] ?? "").padEnd(9, "0") || "0")).toString();
}
