/**
 * Durable, encrypted storage of the shielded wallet state (UI_CONTRACT obligation 4; NOTES §6
 * item 3).
 *
 * * **Encrypted and authenticated at rest.** AES-256-GCM under a key derived from the wallet's
 *   BIP-39 seed — the secret the password vault protects (HKDF-SHA256, a label of its own). The
 *   key exists only while the vault is unlocked and is never extractable. The id, the write
 *   counter and the state's `revision_id` are the additional data: a record cannot be moved,
 *   replayed under another counter or relabelled without failing to decrypt. DIFFERS from
 *   "the vault key" literally: the vault's own key is derived from the password and is not kept
 *   after unlock, so the state is bound to the seed instead — available exactly when the vault
 *   is open, and never plaintext in localStorage.
 * * **One record per wallet and network** holds the state TEXT, `listed_from` (or "unknown" with
 *   the node to start at), the stored envelopes and the wallet-only history — so that a built
 *   payment is stored together with the state that locks it, in ONE transaction.
 * * **Compare-and-swap.** A write succeeds only if the stored record is still the one this writer
 *   LOADED: the same `revision_id` (the core's identity of the state) AND the same write counter
 *   (`seq`, which also covers writes that change no state, such as an envelope's submit result).
 *   IndexedDB serialises read-write transactions on one store across tabs, so read–compare–put
 *   in one transaction is atomic; the transaction is `durability: "strict"` and the write counts
 *   only once it has completed.
 */

export interface StoredRecord {
  id: string;
  revision_id: string;
  seq: number;
  iv: string;
  ct: string;
}

export interface StoredEnvelope {
  /** The first nullifier of a transfer / unshield, or `shield:<cm>` of an own shield. */
  id: string;
  kind: "shield" | "transfer" | "unshield";
  /** The envelope JSON text exactly as built (and, for a shield, signed): what is resubmitted. */
  envelope: string;
  expiry_height: number;
  /** For a shield: the commitment of the note it creates (how it is recognised once listed). */
  cm?: string;
  submit: "unsent" | "accepted" | "failed" | "unanswered";
  attempts: number;
}

export interface HistoryEntry {
  id: string;
  kind: "shield" | "transfer" | "unshield";
  /** Quanta, decimal. For a shield: the note's value (amount minus fee). */
  amount: string;
  fee: string;
  /** Recipient: a fingerprint (shielded) or a rouge1 address (unshield); "self" for a shield. */
  to: string;
  expiry_height: number;
  outcome: "pending" | "mined" | "superseded" | "expired";
  /** Wall time of the build, for display only — never a bound. */
  at: number;
}

export interface Payload {
  /** The state as the core returned it (never re-serialised). */
  state: string;
  /** The node every unconfirmed page of the state came from; null = unknown. */
  listed_from: string | null;
  /** With `listed_from` unknown after a fault: where the next session starts. */
  start_node: string | null;
  /** How this device came to hold the phrase: only "generated" may skip the confirmation. */
  origin: "generated" | "imported";
  envelopes: StoredEnvelope[];
  history: HistoryEntry[];
  /** (wall time, quorum tip) samples for the block rate shown next to block counts. */
  rate: [number, number][];
}

export interface Loaded {
  record: StoredRecord;
  payload: Payload;
}

export interface Store {
  get(id: string): Promise<StoredRecord | null>;
  /** Writes `next` iff the stored record is `expected` (by revision_id and seq), or absent when `expected` is null. */
  cas(id: string, expected: { revision_id: string; seq: number } | null, next: StoredRecord): Promise<boolean>;
}

// ---- encryption -------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** The at-rest key: HKDF-SHA256(seed, info = label), AES-256-GCM, not extractable. */
export async function deriveStateKey(seed: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", seed as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("rougechain-site/shield-v2/state-at-rest/v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (id: string, seq: number, revisionId: string) => enc.encode(`${id}|${seq}|${revisionId}`);

/** The state's revision_id, read from the state text the core returned (its `revision_id` member is not
 * in the state; the caller passes the one the core returned with it). */
export async function seal(key: CryptoKey, id: string, seq: number, revisionId: string, payload: Payload): Promise<StoredRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(id, seq, revisionId) }, key, enc.encode(JSON.stringify(payload))),
  );
  return { id, revision_id: revisionId, seq, iv: toHex(iv), ct: toHex(ct) };
}

export class SealError extends Error {}

export async function open(key: CryptoKey, record: StoredRecord): Promise<Payload> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(record.iv), additionalData: aad(record.id, record.seq, record.revision_id) },
      key,
      fromHex(record.ct),
    );
    return JSON.parse(dec.decode(pt)) as Payload;
  } catch {
    throw new SealError("the stored shielded state could not be decrypted (another wallet, or tampered)");
  }
}

// ---- IndexedDB ----------------------------------------------------------------------------------

const DB = "rougechain-shield-v2";
const OS = "states";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OS, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements Store {
  private db: Promise<IDBDatabase> | null = null;
  private conn(): Promise<IDBDatabase> {
    return (this.db ??= openDb());
  }

  async get(id: string): Promise<StoredRecord | null> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OS, "readonly");
      const req = tx.objectStore(OS).get(id);
      req.onsuccess = () => resolve((req.result as StoredRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async cas(id: string, expected: { revision_id: string; seq: number } | null, next: StoredRecord): Promise<boolean> {
    const db = await this.conn();
    return new Promise((resolve) => {
      let ok = false;
      let tx: IDBTransaction;
      try {
        tx = db.transaction(OS, "readwrite", { durability: "strict" });
      } catch {
        tx = db.transaction(OS, "readwrite");
      }
      const store = tx.objectStore(OS);
      const req = store.get(id);
      req.onsuccess = () => {
        const cur = (req.result as StoredRecord | undefined) ?? null;
        const same = expected === null ? cur === null : cur !== null && cur.revision_id === expected.revision_id && cur.seq === expected.seq;
        if (!same) {
          tx.abort();
          return;
        }
        store.put(next);
        ok = true;
      };
      // Durable only once the transaction has COMPLETED; an abort or an error is "not written".
      tx.oncomplete = () => resolve(ok);
      tx.onabort = () => resolve(false);
      tx.onerror = () => resolve(false);
    });
  }
}

/** The same contract in memory (tests; two "tabs" share one instance). */
export class MemoryStore implements Store {
  records = new Map<string, StoredRecord>();
  /** Test hook: fail the next N writes (a crash before the write completed). */
  failNext = 0;
  async get(id: string): Promise<StoredRecord | null> {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }
  async cas(id: string, expected: { revision_id: string; seq: number } | null, next: StoredRecord): Promise<boolean> {
    await Promise.resolve();
    if (this.failNext > 0) {
      this.failNext -= 1;
      return false;
    }
    const cur = this.records.get(id) ?? null;
    const same = expected === null ? cur === null : cur !== null && cur.revision_id === expected.revision_id && cur.seq === expected.seq;
    if (!same) return false;
    this.records.set(id, { ...next });
    return true;
  }
}
