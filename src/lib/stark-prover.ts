let wasmInstance: WebAssembly.Instance | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<WebAssembly.Instance> {
  if (wasmInstance) return wasmInstance;

  if (!loading) {
    loading = (async () => {
      const resp = await fetch("/stark-prover.wasm");
      if (!resp.ok) throw new Error(`Failed to load STARK prover WASM: ${resp.status}`);
      const { instance } = await WebAssembly.instantiateStreaming(resp);
      wasmInstance = instance;
    })();
  }

  await loading;
  return wasmInstance!;
}

/**
 * Generate a STARK proof for unshielding.
 * Returns a hex-encoded proof string the server can verify.
 */
export async function proveUnshield(amount: number, fee = 1): Promise<string> {
  const wasm = await ensureLoaded();
  const exports = wasm.exports as {
    prove_unshield: (amount: number, fee: number) => number;
    get_output_ptr: () => number;
    memory: WebAssembly.Memory;
  };

  const len = exports.prove_unshield(amount, fee);
  if (len === 0) {
    throw new Error("STARK proof generation failed (prove_unshield returned 0)");
  }

  const ptr = exports.get_output_ptr();
  const buf = new Uint8Array(exports.memory.buffer, ptr, len);
  return new TextDecoder().decode(buf);
}
