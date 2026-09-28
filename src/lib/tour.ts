/**
 * First-run guided tour: sections (ported from Qwalla's lib/help-content.ts,
 * adapted to the site's pages), the "seen" flag, and a tiny event bus so
 * Settings / onboarding can open it from anywhere.
 */
import type { LucideIcon } from "lucide-react";
import { ArrowDownUp, Cable, Image, Mail, MessageSquare, Shield, ShieldCheck, Sparkles, Wallet } from "lucide-react";

export type TourSection = {
  id: string;
  icon: LucideIcon;
  /** Page the "Open" link goes to (none for the intro / backup pages). */
  to?: string;
};

/** i18n: tour.sections.<id>.title / tour.sections.<id>.body. Backup stays last on purpose. */
export const TOUR_SECTIONS: TourSection[] = [
  { id: "welcome", icon: Sparkles },
  { id: "wallet", icon: Wallet, to: "/wallet" },
  { id: "swap", icon: ArrowDownUp, to: "/swap" },
  { id: "messenger", icon: MessageSquare, to: "/messenger" },
  { id: "mail", icon: Mail, to: "/mail" },
  { id: "nfts", icon: Image, to: "/nfts" },
  { id: "bridge", icon: Cable, to: "/bridge" },
  { id: "security", icon: Shield, to: "/settings" },
  { id: "backup", icon: ShieldCheck, to: "/settings" },
];

export const TOUR_SEEN_KEY = "rougechain-tour-seen";
export const OPEN_TOUR_EVENT = "rougechain:open-tour";

export function hasSeenTour(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    // Storage blocked: treat as seen so the tour never nags on every page load.
    return true;
  }
}

export function markTourSeen(storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    /* storage unavailable */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Open the tour from anywhere (Settings "Replay", end of onboarding). */
export function openTour(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_TOUR_EVENT));
  } catch {
    /* non-browser */
  }
}

// While onboarding runs, the auto-open on first visit must hold off.
let onboardingActive = false;
export function setOnboardingActive(active: boolean): void {
  onboardingActive = active;
}
export function isOnboardingActive(): boolean {
  return onboardingActive;
}
