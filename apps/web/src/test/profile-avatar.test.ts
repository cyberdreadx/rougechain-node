import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_ATTEMPTS,
  AVATAR_MAX_BYTES,
  avatarInitials,
  fitsAvatarLimit,
  getStoredAvatar,
  getStoredDisplayName,
  isSafeAvatarUrl,
  normalizeAvatarField,
  overlayStoredProfile,
  setStoredAvatar,
  setStoredDisplayName,
  squareCropRect,
} from "@/lib/avatar";
import { buildDirectoryMap } from "@/lib/wallet-directory";
import { mailAddresses, mailNameError, normalizeMailName } from "@/lib/mail-name";
import { TOUR_SECTIONS, TOUR_SEEN_KEY, hasSeenTour, markTourSeen } from "@/lib/tour";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("avatar field normalization", () => {
  it("reads any casing the node / Qwalla uses", () => {
    expect(normalizeAvatarField({ avatar_url: "data:image/png;base64,AA" })).toBe("data:image/png;base64,AA");
    expect(normalizeAvatarField({ avatarUrl: " https://x.io/a.png " })).toBe("https://x.io/a.png");
    expect(normalizeAvatarField({ avatar: "https://x.io/b.png" })).toBe("https://x.io/b.png");
  });

  it("ignores empty, non-string and missing values", () => {
    expect(normalizeAvatarField({ avatar_url: "" })).toBeUndefined();
    expect(normalizeAvatarField({ avatar_url: null, avatarUrl: 5 })).toBeUndefined();
    expect(normalizeAvatarField(null)).toBeUndefined();
    expect(normalizeAvatarField("data:image/png;base64,AA")).toBeUndefined();
  });

  it("only treats image data URIs and https URLs as safe", () => {
    expect(isSafeAvatarUrl("data:image/jpeg;base64,/9j/")).toBe(true);
    expect(isSafeAvatarUrl("https://ipfs.io/ipfs/x")).toBe(true);
    expect(isSafeAvatarUrl("http://insecure.example/a.png")).toBe(false);
    expect(isSafeAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAvatarUrl("data:text/html;base64,PGI+")).toBe(false);
    expect(isSafeAvatarUrl(undefined)).toBe(false);
  });

  it("applies the node's 256 KB cap to the whole string", () => {
    const prefix = "data:image/jpeg;base64,";
    expect(fitsAvatarLimit(prefix + "A".repeat(AVATAR_MAX_BYTES - prefix.length))).toBe(true);
    expect(fitsAvatarLimit(prefix + "A".repeat(AVATAR_MAX_BYTES - prefix.length + 1))).toBe(false);
  });

  it("directory map indexes every id a wallet is referenced by", () => {
    const map = buildDirectoryMap([
      { id: "w1", displayName: "Ada", signingPublicKey: "sig1", encryptionPublicKey: "enc1", avatarUrl: "https://a/1.png" },
      { id: "w2", displayName: "", signingPublicKey: "sig2", encryptionPublicKey: "enc2" },
    ]);
    expect(map.get("w1")).toEqual({ name: "Ada", avatar: "https://a/1.png" });
    expect(map.get("sig1")).toBe(map.get("w1"));
    expect(map.get("enc1")).toBe(map.get("w1"));
    expect(map.has("w2")).toBe(false);
  });
});

describe("avatar image fitting math", () => {
  it("crops a landscape image to a centered square", () => {
    expect(squareCropRect(1200, 800, 512)).toEqual({ sx: 200, sy: 0, side: 800, out: 512 });
  });

  it("crops a portrait image to a centered square", () => {
    expect(squareCropRect(600, 1000, 512)).toEqual({ sx: 0, sy: 200, side: 600, out: 512 });
  });

  it("never upscales small images", () => {
    expect(squareCropRect(100, 140, 512)).toEqual({ sx: 0, sy: 20, side: 100, out: 100 });
  });

  it("steps down size / quality monotonically", () => {
    for (let i = 1; i < AVATAR_ATTEMPTS.length; i++) {
      const prev = AVATAR_ATTEMPTS[i - 1];
      const cur = AVATAR_ATTEMPTS[i];
      expect(cur.edge <= prev.edge).toBe(true);
      expect(cur.edge < prev.edge || cur.quality < prev.quality).toBe(true);
    }
  });

  it("builds initials", () => {
    expect(avatarInitials("Ada Lovelace")).toBe("AL");
    expect(avatarInitials("rouge")).toBe("RO");
    expect(avatarInitials("  ")).toBe("");
    expect(avatarInitials(undefined)).toBe("");
  });
});

describe("per-key profile store", () => {
  it("distinguishes unknown, removed and set", () => {
    expect(getStoredAvatar("pk")).toBeUndefined();
    setStoredAvatar("pk", "https://a/1.png");
    expect(getStoredAvatar("pk")).toBe("https://a/1.png");
    setStoredAvatar("pk", null);
    expect(getStoredAvatar("pk")).toBeNull();
  });

  it("overlays newer name / avatar on a wallet decrypted from an old vault blob", () => {
    const stale = { signingPublicKey: "pk", displayName: "My Wallet", avatarUrl: "https://old/a.png" };
    expect(overlayStoredProfile(stale)).toEqual(stale);
    setStoredDisplayName("pk", "Ada");
    setStoredAvatar("pk", null);
    expect(overlayStoredProfile(stale)).toEqual({ signingPublicKey: "pk", displayName: "Ada" });
    setStoredAvatar("pk", "https://new/a.png");
    expect(overlayStoredProfile(stale).avatarUrl).toBe("https://new/a.png");
    expect(getStoredDisplayName("other")).toBeUndefined();
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => setStoredAvatar("pk", "https://a/1.png")).not.toThrow();
    expect(getStoredAvatar("pk")).toBeUndefined();
    expect(getStoredDisplayName("pk")).toBeUndefined();
  });
});

describe("mail name helpers", () => {
  it("normalizes to the node's charset", () => {
    expect(normalizeMailName("  Ada.Love-lace@rouge.quant ")).toBe("adalovelace");
    expect(normalizeMailName("ADA_99")).toBe("ada_99");
  });

  it("mirrors the node's validation", () => {
    expect(mailNameError("ab")).toBe("length");
    expect(mailNameError("a".repeat(21))).toBe("length");
    expect(mailNameError("_ada")).toBe("underscore");
    expect(mailNameError("ada_")).toBe("underscore");
    expect(mailNameError("ada_99")).toBeNull();
  });

  it("gives both addresses", () => {
    expect(mailAddresses("ada")).toEqual(["ada@rouge.quant", "ada@qwalla.mail"]);
  });
});

describe("tour seen flag", () => {
  it("is unseen until marked", () => {
    expect(hasSeenTour()).toBe(false);
    markTourSeen();
    expect(hasSeenTour()).toBe(true);
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe("1");
  });

  it("treats blocked storage as seen (never nags) and marking doesn't throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(hasSeenTour()).toBe(true);
    expect(() => markTourSeen()).not.toThrow();
    expect(hasSeenTour(null)).toBe(true);
  });

  it("keeps backup as the last page", () => {
    expect(TOUR_SECTIONS[0].id).toBe("welcome");
    expect(TOUR_SECTIONS[TOUR_SECTIONS.length - 1].id).toBe("backup");
  });
});

describe("register carries the avatar (node replaces the entry on every register)", () => {
  async function registerAndCapture(setup: (pk: string) => void, extra: Record<string, unknown> = {}) {
    const { createWallet, registerWalletOnNode } = await import("@/lib/pqc-messenger");
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ success: true, wallets: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const w = await createWallet("Ada", false);
    bodies.length = 0;
    setup(w.signingPublicKey);
    await registerWalletOnNode({ ...w, ...extra }, false);
    vi.unstubAllGlobals();
    return bodies[bodies.length - 1]?.payload as Record<string, unknown>;
  }

  it("includes the stored avatar", async () => {
    const payload = await registerAndCapture((pk) => setStoredAvatar(pk, "data:image/jpeg;base64,/9j/AA"));
    expect(payload.avatarUrl).toBe("data:image/jpeg;base64,/9j/AA");
  });

  it("omits it after the user removed it", async () => {
    const payload = await registerAndCapture((pk) => setStoredAvatar(pk, null));
    expect(payload).not.toHaveProperty("avatarUrl");
  });

  it("an explicit empty avatarUrl means none", async () => {
    const payload = await registerAndCapture((pk) => setStoredAvatar(pk, "https://a/1.png"), { avatarUrl: "" });
    expect(payload).not.toHaveProperty("avatarUrl");
  });
});

describe("new strings exist in every locale", () => {
  it("has tour + settings keys in en/es/zh/ja", async () => {
    const locales = await Promise.all(["en", "es", "zh", "ja"].map((l) => import(`@/i18n/locales/${l}.json`)));
    for (const mod of locales) {
      const d = mod.default as Record<string, any>;
      for (const s of TOUR_SECTIONS) {
        expect(typeof d.tour.sections[s.id].title).toBe("string");
        expect(typeof d.tour.sections[s.id].body).toBe("string");
      }
      expect(typeof d.nav.settings).toBe("string");
      expect(typeof d.settings.sections.security).toBe("string");
      expect(typeof d.onboarding.mail.title).toBe("string");
    }
  });
});
