/**
 * Contact Nicknames — localStorage-backed custom display names
 */

const NICKNAMES_KEY = "pqc_contact_nicknames";

function loadNicknames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NICKNAMES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveNicknames(nicknames: Record<string, string>): void {
  localStorage.setItem(NICKNAMES_KEY, JSON.stringify(nicknames));
}

export function getNickname(walletId: string): string | null {
  return loadNicknames()[walletId] || null;
}

export function setNickname(walletId: string, name: string): void {
  const nicknames = loadNicknames();
  if (name.trim()) {
    nicknames[walletId] = name.trim();
  } else {
    delete nicknames[walletId];
  }
  saveNicknames(nicknames);
}

export function clearNickname(walletId: string): void {
  const nicknames = loadNicknames();
  delete nicknames[walletId];
  saveNicknames(nicknames);
}

export function getAllNicknames(): Record<string, string> {
  return loadNicknames();
}
