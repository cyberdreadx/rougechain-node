/// <reference lib="webworker" />
/**
 * The /shield page's module Web Worker: it owns the WebAssembly instance and every operation on
 * the wallet state — scanning, state checks, proving, storage — so the page's thread never runs
 * any of it (NOTES §6 item 2; README friction items 4 and 5).
 *
 * * One message at a time (a queue): a round and a payment never interleave, and there is never
 *   more than one proof.
 * * The seed arrives with the calls that need it and is wiped (`fill(0)`) when the call returns;
 *   the worker keeps the scan key and the non-extractable at-rest key for its lifetime only.
 * * The page terminates this worker when it leaves the page and after every payment (a proof
 *   grows the instance to ~379 MiB that WebAssembly never gives back); the next worker continues
 *   the same loop session (`init` with `session`).
 */
import init, * as pkg from "./vendor/quantum_vault_shield_v2_wasm.js";
import wasmUrl from "./vendor/quantum_vault_shield_v2_wasm_bg.wasm?url";
import { ShieldClient, stateForNewlyGeneratedPhrase, type PaymentResult, type ShieldViewModel } from "./client";
import { CoreError, core } from "./core-api";
import { fetchNet } from "./node-io";
import { IdbStore, deriveStateKey } from "./store";
import type { SessionData } from "./loop";
import type { WorkerRequest, WorkerResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let client: ShieldClient | null = null;
let fingerprint = "";
const store = new IdbStore();

async function ready(): Promise<void> {
  await init({ module_or_path: wasmUrl });
}

/** Address, fingerprint, scan key and at-rest key from the seed; the seed is wiped by the caller. */
async function keysOf(seed: Uint8Array, network: string) {
  const info = JSON.parse(core(() => pkg.shielded_address(seed))) as { address: string; pk: string; fingerprint: string };
  const scanKey = core(() => pkg.export_scan_key(seed, true));
  const key = await deriveStateKey(seed);
  return { ...info, scanKey, key, id: `${network}:${info.pk}` };
}

function view(): ShieldViewModel | null {
  return client ? client.viewModel() : null;
}

async function handle(msg: WorkerRequest): Promise<Omit<WorkerResponse, "id">> {
  switch (msg.cmd) {
    case "init": {
      await ready();
      try {
        const k = await keysOf(msg.seed, msg.network);
        fingerprint = k.fingerprint;
        client = new ShieldClient({ api: pkg, store, net: fetchNet, key: k.key, id: k.id, address: k.address, scanKey: k.scanKey, origins: msg.origins });
        await client.open(msg.session ?? null);
        return { ok: true, address: k.address, fingerprint, view: view() };
      } finally {
        msg.seed.fill(0);
      }
    }
    case "newPhrase": {
      // "create new phrase": the same user action that generated the phrase (obligation 1 (a))
      await ready();
      try {
        const k = await keysOf(msg.seed, msg.network);
        const made = await stateForNewlyGeneratedPhrase(pkg, store, k.key, k.id, k.address);
        return { ok: true, made };
      } finally {
        msg.seed.fill(0);
      }
    }
    case "round":
      if (!client) return { ok: false, error: "not initialised" };
      if (msg.recheckPool) client.session?.recheckPool();
      return { ok: true, view: await client.round() };
    case "newSession":
      if (!client) return { ok: false, error: "not initialised" };
      await client.newSession();
      return { ok: true, view: view() };
    case "view":
      return { ok: true, view: view() };
    case "snapshot":
      return { ok: true, session: client?.snapshot() ?? null };
    case "parseAddress":
      await ready();
      try {
        return { ok: true, parsed: JSON.parse(core(() => pkg.parse_address(msg.address))) };
      } catch (e) {
        return { ok: false, error: e instanceof CoreError ? e.code : "address" };
      }
    case "transfer":
    case "unshield": {
      if (!client) return { ok: false, error: "not initialised" };
      try {
        let result: PaymentResult;
        if (msg.cmd === "transfer") {
          const fp = (JSON.parse(core(() => pkg.parse_address(msg.recipient))) as { fingerprint: string }).fingerprint;
          result = await client.buildTransfer(msg.seed, msg.recipient, msg.amount, msg.fee, fp);
        } else {
          result = await client.buildUnshield(msg.seed, msg.to, msg.amount, msg.fee);
        }
        return { ok: true, result, view: view() };
      } catch (e) {
        if (e instanceof CoreError) return { ok: true, result: { status: "refused", code: e.code, message: e.message }, view: view() };
        throw e;
      } finally {
        msg.seed.fill(0);
      }
    }
    case "prepareShield": {
      if (!client) return { ok: false, error: "not initialised" };
      const r = await client.prepareShield(msg.fromPubKey, msg.vIn, msg.fee);
      return { ok: true, shield: r, view: view() };
    }
    case "completeShield": {
      if (!client) return { ok: false, error: "not initialised" };
      return { ok: true, result: await client.completeShield(msg.sig), view: view() };
    }
    case "resubmit": {
      if (!client) return { ok: false, error: "not initialised" };
      await client.resubmitOne(msg.paymentId);
      return { ok: true, view: view() };
    }
    case "soleCopy": {
      if (!client) return { ok: false, error: "not initialised" };
      // only ever sent by the confirmation dialog, after the user confirmed the sentence
      const done = msg.userConfirmedTheStatement === true ? await client.confirmSoleCopyAfterExplicitStatement(true) : false;
      return { ok: true, done, view: view() };
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  queue = queue.then(async () => {
    let body: Omit<WorkerResponse, "id">;
    try {
      body = await handle(msg);
    } catch (e) {
      body = { ok: false, error: e instanceof Error ? e.message : String(e), trap: typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError };
    }
    self.postMessage({ id: msg.id, ...body } satisfies WorkerResponse);
  });
};

export type { SessionData };
