let wasmInstance: WebAssembly.Instance | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<WebAssembly.Instance> {
  if (wasmInstance) return wasmInstance;

  if (!loading) {
    loading = (async () => {
      const resp = await fetch("/stark-prover.wasm");
      if (!resp.ok) throw new Error(`Failed to load STARK prover WASM: ${resp.status}`);

      const importObject = {
        env: {
          host_fill_random: (ptr: number, len: number) => {
            const buf = new Uint8Array(wasmMemory!.buffer, ptr, len);
            crypto.getRandomValues(buf);
          },
        },
      };

      const { instance } = await WebAssembly.instantiateStreaming(resp, importObject);
      wasmMemory = instance.exports.memory as WebAssembly.Memory;
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
