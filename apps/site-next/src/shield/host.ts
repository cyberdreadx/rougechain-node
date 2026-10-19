/**
 * The page's side of the worker: start it, ask it, terminate it. After every payment the worker
 * is terminated (its WebAssembly memory is never returned) and a new one continues the SAME loop
 * session, handed over as plain data. Nothing here touches WebAssembly.
 */
import type { SessionData } from "./loop";
import type { RequestBody, WorkerResponse } from "./protocol";

/** BIP-39 seed: PBKDF2-HMAC-SHA512(NFKD(phrase), "mnemonic", 2048) → 64 bytes, off the UI thread (Web Crypto). */
export async function bip39Seed(phrase: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(phrase.normalize("NFKD")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: enc.encode("mnemonic"), iterations: 2048 }, key, 512);
  return new Uint8Array(bits);
}

export type WorkerFactory = () => Worker;

export const defaultWorkerFactory: WorkerFactory = () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

export class ShieldHost {
  private worker: Worker | null = null;
  private next = 0;
  private waiting = new Map<number, (r: WorkerResponse) => void>();
  private readonly factory: WorkerFactory;

  constructor(factory: WorkerFactory = defaultWorkerFactory) {
    this.factory = factory;
  }

  private spawn(): Worker {
    const w = this.factory();
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const done = this.waiting.get(e.data.id);
      if (done) {
        this.waiting.delete(e.data.id);
        done(e.data);
      }
    };
    w.onerror = () => {
      for (const [, done] of this.waiting) done({ id: -1, ok: false, error: "worker failed" });
      this.waiting.clear();
    };
    return w;
  }

  ask(body: RequestBody, transfer: Transferable[] = []): Promise<WorkerResponse> {
    this.worker ??= this.spawn();
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker!.postMessage({ id, ...body }, transfer);
    });
  }

  /** Terminate (leaving the page). Pending requests are answered "terminated". */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, done] of this.waiting) done({ id: -1, ok: false, error: "terminated" });
    this.waiting.clear();
  }

  /** After a payment: keep the session, drop the worker and its memory, start a fresh one. */
  async recycle(init: (session: SessionData | null) => Promise<WorkerResponse>): Promise<WorkerResponse> {
    const snap = await this.ask({ cmd: "snapshot" });
    this.terminate();
    return init(snap.session ?? null);
  }

  get running(): boolean {
    return this.worker !== null;
  }
}

/**
 * "Create new phrase" (UI_CONTRACT obligation 1 (a)): in the same user action that generated the
 * phrase, a short-lived worker makes the shielded state and records the statement that no other
 * copy exists — true at that moment and at no later one. Called only by the wallet's create().
 */
export async function makeStateForNewlyGeneratedPhrase(mnemonic: string, network: string, factory: WorkerFactory = defaultWorkerFactory): Promise<boolean> {
  const host = new ShieldHost(factory);
  try {
    const seed = await bip39Seed(mnemonic);
    const r = await host.ask({ cmd: "newPhrase", network, seed }, [seed.buffer]);
    return r.ok && r.made === true;
  } finally {
    host.terminate();
  }
}

/**
 * "Import / restore a phrase": a state an earlier "create new phrase" left on this installation
 * loses its sole-copy statement if it was never confirmed (see dropUnconfirmedGeneratedState).
 * Called only by the wallet's import paths.
 */
export async function forgetStatementForImportedPhrase(mnemonic: string, factory: WorkerFactory = defaultWorkerFactory): Promise<void> {
  const host = new ShieldHost(factory);
  try {
    const seed = await bip39Seed(mnemonic);
    await host.ask({ cmd: "importedPhrase", networks: ["mainnet", "testnet"], seed }, [seed.buffer]);
  } finally {
    host.terminate();
  }
}

