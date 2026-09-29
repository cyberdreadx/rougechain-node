import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.IntersectionObserver =
  Observer as unknown as typeof IntersectionObserver;
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};

// jsdom realm fix (tests only): under vitest's jsdom environment `ArrayBuffer` is jsdom's, and
// Node's WebCrypto rejects a jsdom ArrayBuffer (core passes `salt.buffer` to PBKDF2 and an
// ArrayBuffer slice to SHA-256). Browsers accept both; re-wrap them as views so core's real
// vault / address code runs unchanged in tests.
{
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = subtle.digest.bind(subtle);
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier, data: BufferSource) =>
        digest(algorithm, data instanceof ArrayBuffer ? new Uint8Array(data) : data),
    });
    const deriveKey = subtle.deriveKey.bind(subtle);
    Object.defineProperty(subtle, "deriveKey", {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier & { salt?: unknown }, ...rest: unknown[]) => {
        const alg =
          typeof algorithm === "object" && algorithm.salt instanceof ArrayBuffer
            ? { ...algorithm, salt: new Uint8Array(algorithm.salt) }
            : algorithm;
        return (deriveKey as (...a: unknown[]) => Promise<CryptoKey>)(alg, ...rest);
      },
    });
  }
}
