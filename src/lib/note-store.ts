/**
 * Shielded Note Store
 * 
 * Persists ShieldedNote objects to localStorage, scoped by network.
 * Notes are stored as a JSON array. Each note includes a "spent" flag.
 */

import { getActiveNetwork } from "./network";
import type { ShieldedNote } from "./shielded-crypto";

const NOTE_STORE_KEY = "pqc-shielded-notes";

export interface StoredNote extends ShieldedNote {
  /** When the note was created (ms since epoch) */
  createdAt: number;
  /** Whether this note has been spent (unshielded) */
  spent: boolean;
  /** When it was spent, if applicable */
  spentAt?: number;
}

function getScopedKey(): string {
  return `${NOTE_STORE_KEY}:${getActiveNetwork()}`;
}

function loadAll(): StoredNote[] {
  try {
    const raw = localStorage.getItem(getScopedKey());
    if (!raw) return [];
    return JSON.parse(raw) as StoredNote[];
  } catch {
    return [];
  }
}

function persist(notes: StoredNote[]): void {
  localStorage.setItem(getScopedKey(), JSON.stringify(notes));
}

/**
 * Save a new shielded note after a successful shield transaction.
 */
export function saveNote(note: ShieldedNote): void {
  const notes = loadAll();
  // Avoid duplicates (by commitment)
  if (notes.some(n => n.commitment === note.commitment)) return;
  notes.push({
    ...note,
    createdAt: Date.now(),
    spent: false,
  });
  persist(notes);
}

/**
 * Get all notes for a given owner public key.
 * Returns both active and spent notes.
 */
export function getNotes(ownerPubKey: string): StoredNote[] {
  return loadAll().filter(n => n.ownerPubKey === ownerPubKey);
}

/**
 * Get only active (unspent) notes for an owner.
 */
export function getActiveNotes(ownerPubKey: string): StoredNote[] {
  return loadAll().filter(n => n.ownerPubKey === ownerPubKey && !n.spent);
}

/**
 * Get the total shielded balance for an owner.
 */
export function getShieldedBalance(ownerPubKey: string): number {
  return getActiveNotes(ownerPubKey).reduce((sum, n) => sum + n.value, 0);
}

/**
 * Mark a note as spent (after a successful unshield).
 */
export function markSpent(nullifier: string): void {
  const notes = loadAll();
  const note = notes.find(n => n.nullifier === nullifier);
  if (note) {
    note.spent = true;
    note.spentAt = Date.now();
    persist(notes);
  }
}

/**
 * Delete a note entirely (permanent removal).
 */
export function deleteNote(nullifier: string): void {
  const notes = loadAll().filter(n => n.nullifier !== nullifier);
  persist(notes);
}

/**
 * Import a note from manual paste (JSON string).
 * Returns the parsed note or throws on invalid input.
 */
export function importNote(jsonStr: string): StoredNote {
  const parsed = JSON.parse(jsonStr) as ShieldedNote;
  if (!parsed.commitment || !parsed.nullifier || !parsed.randomness || !parsed.value || !parsed.ownerPubKey) {
    throw new Error("Invalid note format — missing required fields");
  }
  const stored: StoredNote = {
    ...parsed,
    createdAt: Date.now(),
    spent: false,
  };
  const notes = loadAll();
  if (notes.some(n => n.commitment === parsed.commitment)) {
    throw new Error("Note already exists");
  }
  notes.push(stored);
  persist(notes);
  return stored;
}
