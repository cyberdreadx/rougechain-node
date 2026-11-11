/**
 * What a contract's .wasm offers and needs, read without running it: its methods (exported
 * functions), the host functions it imports, and whether the node can link them.
 */

/**
 * Host functions the node links for contracts (module "env"), as on mainnet today with every
 * activation on. Source: `linker.func_wrap("env", …)` in core/vm/src/host.rs and game.rs — keep in
 * sync (ide.test.ts checks this list against those files).
 */
export const HOST_FUNCTIONS = [
  "host_block_hash",
  "host_call_contract",
  "host_emit_event",
  "host_get_args_len",
  "host_get_attached_amount",
  "host_get_attached_symbol",
  "host_get_balance",
  "host_get_block_height",
  "host_get_block_time",
  "host_get_call_result",
  "host_get_caller",
  "host_get_chain_id",
  "host_get_self_addr",
  "host_log",
  "host_nft_create_collection",
  "host_nft_mint",
  "host_nft_owner",
  "host_nft_royalty_bps",
  "host_nft_royalty_recipient",
  "host_nft_transfer",
  "host_pqc_hash_pubkey",
  "host_pqc_pubkey_to_address",
  "host_pqc_verify",
  "host_random",
  "host_read_args",
  "host_set_return",
  "host_sha256",
  "host_storage_delete",
  "host_storage_read",
  "host_storage_write",
  "host_token_balance",
  "host_token_transfer",
  "host_transfer",
] as const;

const KNOWN = new Set<string>(HOST_FUNCTIONS);
/** The node refuses larger modules (`MAX_WASM_SIZE`). */
export const MAX_WASM_SIZE = 1_048_576;

export interface WasmImport {
  module: string;
  name: string;
  /** The node links it (module "env" and a known host function). */
  known: boolean;
}

export interface WasmAnalysis {
  size: number;
  /** Exported functions: the contract's methods. */
  methods: string[];
  imports: WasmImport[];
  /** Exports its linear memory as `memory` (the node refuses a contract that doesn't). */
  exportsMemory: boolean;
  /** Problems that make the node refuse it, or make calls fail. */
  problems: string[];
}

export async function analyzeWasm(bytes: Uint8Array): Promise<WasmAnalysis> {
  const problems: string[] = [];
  if (bytes.length > MAX_WASM_SIZE) problems.push(`Larger than the node's limit (${bytes.length.toLocaleString()} > ${MAX_WASM_SIZE.toLocaleString()} bytes).`);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes as BufferSource);
  } catch (e) {
    return { size: bytes.length, methods: [], imports: [], exportsMemory: false, problems: [`Not a valid WebAssembly module: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const exports = WebAssembly.Module.exports(module);
  const methods = exports.filter((e) => e.kind === "function").map((e) => e.name).sort();
  const exportsMemory = exports.some((e) => e.kind === "memory" && e.name === "memory");
  const imports = WebAssembly.Module.imports(module)
    .filter((i) => i.kind === "function")
    .map((i) => ({ module: i.module, name: i.name, known: i.module === "env" && KNOWN.has(i.name) }));
  if (!exportsMemory) problems.push("Doesn't export its memory as `memory`, so the node refuses it.");
  const unknown = imports.filter((i) => !i.known);
  if (unknown.length)
    problems.push(
      `Imports ${unknown.map((i) => `${i.module}::${i.name}`).join(", ")}, which the node doesn't provide. It can be deployed, but every call fails.`,
    );
  if (!methods.length) problems.push("Exports no functions, so it has no methods to call.");
  return { size: bytes.length, methods, imports, exportsMemory, problems };
}
