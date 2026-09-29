/**
 * First-run tour: same "seen" flag and open event as apps/web (src/lib/tour.ts), so a visitor
 * who dismissed the tour on apps/web doesn't see it again here. Parity is pinned by a test that
 * reads apps/web's source.
 */
export const TOUR_SEEN_KEY = "rougechain-tour-seen";
export const OPEN_TOUR_EVENT = "rougechain:open-tour";

export interface TourSection {
  id: string;
  title: string;
  body: string;
  /** Page the "Open" link goes to. */
  to?: string;
}

/** Copy from apps/web's en.json (tour.sections.*). Backup stays last on purpose. */
export const TOUR_SECTIONS: TourSection[] = [
  {
    id: "welcome",
    title: "Welcome to RougeChain",
    body: "A post-quantum wallet, DEX, messenger and mail in one place. Your keys, chats and mail are protected with quantum-resistant cryptography (ML-DSA-65 + ML-KEM-768). Here's a quick tour.",
  },
  {
    id: "wallet",
    title: "Wallet",
    body: "Send and receive XRGE and tokens, create your own token, and shield funds for privacy. Tap the eye icon to hide balances.",
    to: "/wallet",
  },
  {
    id: "swap",
    title: "Swap & pools",
    body: "Trade tokens on the built-in DEX and provide liquidity to earn fees. Check the price impact before you confirm.",
    to: "/swap",
  },
  {
    id: "messenger",
    title: "Messenger",
    body: "End-to-end encrypted chats. Send photos, payments and payment requests, react to and reply to messages, and start group chats.",
  },
  {
    id: "mail",
    title: "Mail",
    body: "Encrypted mail with your own name@rouge.quant address — name@qwalla.mail works too. Claim your name in Settings, then compose, reply and forward.",
  },
  {
    id: "nfts",
    title: "NFTs",
    body: "Browse collections, mint your own, and use any NFT you own as your profile photo.",
    to: "/nfts",
  },
  {
    id: "bridge",
    title: "Bridge",
    body: "Move ETH, USDC and XRGE between Base and RougeChain as qETH, qUSDC and XRGE.",
  },
  {
    id: "security",
    title: "Locked & private",
    body: "Protect your wallet with a password and auto-lock in Settings. Your private keys never leave this browser.",
    to: "/settings",
  },
  {
    id: "backup",
    title: "Back up — don't lose your messages",
    body: "Two things keep you safe, and they are different:\n\n• Recovery phrase restores your wallet and funds — but NOT your chat history.\n• Encrypted backup file (.pqcbackup) restores your wallet, funds AND your messages.\n\nExport a backup in Settings → Security & backup and keep both somewhere safe.",
    to: "/settings",
  },
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
