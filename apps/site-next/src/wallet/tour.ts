/**
 * First-run tour: same "seen" flag and open event as apps/web (src/lib/tour.ts), so a visitor
 * who dismissed the tour on apps/web doesn't see it again here. Parity is pinned by a test that
 * reads apps/web's source.
 */
export const TOUR_SEEN_KEY = "rougechain-tour-seen";
export const OPEN_TOUR_EVENT = "rougechain:open-tour";

export interface TourSection {
  id: string;
  /** Page the "Open" link goes to. */
  to?: string;
}

/**
 * Same sections, in the same order, as apps/web. Titles and bodies are the `wallet` namespace's
 * `tour.sections.<id>.title|body` (copy + translations from apps/web's locales). Backup stays last on purpose.
 */
export const TOUR_SECTIONS: TourSection[] = [
  { id: "welcome" },
  { id: "wallet", to: "/wallet" },
  { id: "swap", to: "/swap" },
  { id: "messenger" },
  { id: "mail" },
  { id: "nfts", to: "/nfts" },
  { id: "bridge" },
  { id: "security", to: "/settings" },
  { id: "backup", to: "/settings" },
];

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function hasSeenTour(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return true; // storage blocked: never nag on every load
  }
}

export function markTourSeen(storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    /* storage unavailable */
  }
}

export function openTour(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_TOUR_EVENT));
  } catch {
    /* non-browser */
  }
}

let onboardingActive = false;
export function setOnboardingActive(active: boolean): void {
  onboardingActive = active;
}
export function isOnboardingActive(): boolean {
  return onboardingActive;
}
