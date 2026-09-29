/**
 * Mail-name claim / change for Settings and onboarding, on top of the existing
 * name-registry calls in pqc-mail.ts. One name per wallet on the node, so a
 * change = release old → register new (and re-claim the old one if that fails).
 */
import { MAIL_DOMAIN, MAIL_DOMAIN_ALT, registerName, releaseName, reverseLookup } from "@/lib/pqc-mail";
import { registerWalletOnNode, type WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { getMessagingIdentity } from "@/lib/profile";
import type { UnifiedWallet } from "@/lib/unified-wallet";

/** Local part as the node will store it: lowercase, drop any @domain, keep [a-z0-9_]. */
export function normalizeMailName(input: string): string {
  return input.trim().toLowerCase().replace(/@.*/, "").replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

/** Mirrors the node's validate_name: 3–20 chars of [a-z0-9_], not starting/ending with "_". */
export function mailNameError(name: string): "length" | "chars" | "underscore" | null {
  if (name.length < 3 || name.length > 20) return "length";
  if (!/^[a-z0-9_]+$/.test(name)) return "chars";
  if (name.startsWith("_") || name.endsWith("_")) return "underscore";
  return null;
}

/** Both addresses a name receives mail at. */
export function mailAddresses(name: string): [string, string] {
  return [`${name}@${MAIL_DOMAIN}`, `${name}@${MAIL_DOMAIN_ALT}`];
}

/** My current mail name (under the messaging identity), or null. */
export async function getMyMailName(wallet: UnifiedWallet): Promise<string | null> {
  const mw = await getMessagingIdentity(wallet);
  return (await reverseLookup(mw.id)) ?? (mw.id !== wallet.id ? await reverseLookup(wallet.id) : null);
}

async function claim(mw: WalletWithPrivateKeys, name: string): Promise<{ success: boolean; error?: string }> {
  const r = await registerName(mw, name, mw.id);
  return { success: !!r?.success, error: r?.error };
}

/**
 * Claim `name` (or change from `current` to it). Returns the claimed name;
 * throws with the node's message on failure.
 */
export async function claimMailName(wallet: UnifiedWallet, rawName: string, current?: string | null): Promise<string> {
  const name = normalizeMailName(rawName);
  if (mailNameError(name)) throw new Error("Name must be 3–20 letters, numbers or underscores");
  if (current && current === name) return name;
  const mw = await getMessagingIdentity(wallet);
  // Name claims need a registered directory entry; registering is idempotent.
  try { await registerWalletOnNode(mw, mw.signingPublicKey === wallet.signingPublicKey ? undefined : false); } catch { /* claim reports it */ }

  if (current) {
    const rel = await releaseName(mw, current);
    if (!rel?.success) throw new Error(rel?.error || "Could not release your current name");
  }
  const r = await claim(mw, name);
  if (!r.success) {
    if (current) await claim(mw, current).catch(() => undefined);
    throw new Error(r.error || "That name is taken or invalid");
  }
  return name;
}
