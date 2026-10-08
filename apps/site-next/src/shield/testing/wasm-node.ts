/**
 * Tests only: the vendored WebAssembly package instantiated in Node (the same bytes the worker
 * loads in the browser). Scanning and state checks take milliseconds; nothing here proves.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./fixtures";
import * as pkg from "../vendor/quantum_vault_shield_v2_wasm.js";
import type { CoreApi } from "../core-api";

let ready = false;
export function loadCore(): typeof pkg & CoreApi {
  if (!ready) {
    pkg.initSync({ module: readFileSync(path.join(repoRoot(), "apps/site-next/src/shield/vendor/quantum_vault_shield_v2_wasm_bg.wasm")) });
    ready = true;
  }
  return pkg;
}
