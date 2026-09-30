/**
 * Messenger / mail test helpers: peer keypairs, Qwalla's v2 group package (ported verbatim from
 * apps/web/src/test/messenger-group-crypto.test.ts), a fake node WebSocket, a signed-request
 * checker, and a renderer with the app's providers. Nothing here reaches a real node.
 */
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ChainProvider } from "../explorer/chain";
import { WalletProvider } from "../wallet/WalletProvider";
import { Toaster } from "../wallet/toast";
import MessengerPage from "./MessengerPage";
import MailPage from "../mail/MailPage";

/**
 * jsdom realm fix for messenger crypto (tests only; mirrors the one src/test-setup.ts applies to
 * digest / deriveKey): core hands WebCrypto ArrayBuffer slices and views that Node's WebCrypto may
 * see as foreign under vitest's jsdom environment. Re-wrap them as local views; browsers accept
 * both, so core's real ML-KEM + AES-GCM code runs unchanged.
 */
function localBytes(x: unknown): unknown {
  if (!x || typeof x !== "object") return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array((x as ArrayBufferView).buffer, (x as ArrayBufferView).byteOffset, (x as ArrayBufferView).byteLength);
  if (typeof (x as ArrayBuffer).byteLength === "number" && typeof (x as ArrayBuffer).slice === "function") return new Uint8Array(x as ArrayBuffer);
  return x;
}
function localAlg(a: unknown): unknown {
  if (!a || typeof a !== "object") return a;
  const o = { ...(a as Record<string, unknown>) };
  for (const k of ["iv", "salt", "info", "additionalData"]) if (k in o) o[k] = localBytes(o[k]);
  return o;
}
{
  const subtle = globalThis.crypto?.subtle as (SubtleCrypto & { __msgRealmFix?: boolean }) | undefined;
  if (subtle && !subtle.__msgRealmFix) {
    const importKey = subtle.importKey.bind(subtle) as (...a: unknown[]) => Promise<CryptoKey>;
    const encrypt = subtle.encrypt.bind(subtle) as (...a: unknown[]) => Promise<ArrayBuffer>;
    const decrypt = subtle.decrypt.bind(subtle) as (...a: unknown[]) => Promise<ArrayBuffer>;
    const deriveKey = subtle.deriveKey.bind(subtle) as (...a: unknown[]) => Promise<CryptoKey>;
    Object.defineProperty(subtle, "importKey", { configurable: true, value: (f: unknown, k: unknown, ...r: unknown[]) => importKey(f, f === "jwk" ? k : localBytes(k), ...r) });
    Object.defineProperty(subtle, "encrypt", { configurable: true, value: (a: unknown, k: unknown, d: unknown) => encrypt(localAlg(a), k, localBytes(d)) });
    Object.defineProperty(subtle, "decrypt", { configurable: true, value: (a: unknown, k: unknown, d: unknown) => decrypt(localAlg(a), k, localBytes(d)) });
    Object.defineProperty(subtle, "deriveKey", { configurable: true, value: (a: unknown, ...r: unknown[]) => deriveKey(localAlg(a), ...r) });
    Object.defineProperty(subtle, "__msgRealmFix", { value: true });
  }
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

export interface Peer {
  id: string;
  displayName: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

export function makePeer(displayName: string): Peer {
  const s = ml_dsa65.keygen();
  const e = ml_kem768.keygen();
  return {
    id: hex(s.publicKey),
    displayName,
    signingPublicKey: hex(s.publicKey),
    signingPrivateKey: hex(s.secretKey),
    encryptionPublicKey: hex(e.publicKey),
    encryptionPrivateKey: hex(e.secretKey),
  };
}

/** The node's directory record (snake_case, as GET /messenger/wallets returns it). */
export const dirEntry = (w: { id: string; displayName: string; signingPublicKey: string; encryptionPublicKey: string }) => ({
  id: w.id,
  display_name: w.displayName,
  signing_public_key: w.signingPublicKey,
  encryption_public_key: w.encryptionPublicKey,
});

const WRAP_INFO = new TextEncoder().encode("pqc-cek-wrap");
/** Qwalla's encryptMailV2 (packages/qwalla-core/pq/encryption.ts). */
export function qwallaEncryptV2(pt: string, recipients: string[], sender: string): string {
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = gcm(cek, iv).encrypt(new TextEncoder().encode(pt));
  const wrappedKeys: Record<string, { kemCipherText: string; wrappedCek: string; wrappedIv: string }> = {};
  for (const k of [...new Set([...recipients, sender])]) {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(unhex(k));
    const wrapKey = hkdf(sha256, sharedSecret, new Uint8Array(32), WRAP_INFO, 32);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    wrappedKeys[k] = { kemCipherText: hex(cipherText), wrappedCek: hex(gcm(wrapKey, wrapIv).encrypt(cek)), wrappedIv: hex(wrapIv) };
  }
  return JSON.stringify({ version: 2, iv: hex(iv), encryptedContent: hex(encrypted), wrappedKeys });
}
/** Qwalla's decryptMailV2. */
export function qwallaDecryptV2(json: string, priv: string, pub: string): string {
  const pkg = JSON.parse(json);
  const mine = pkg.wrappedKeys[pub];
  const ss = ml_kem768.decapsulate(unhex(mine.kemCipherText), unhex(priv));
  const wrapKey = hkdf(sha256, ss, new Uint8Array(32), WRAP_INFO, 32);
  const cek = gcm(wrapKey, unhex(mine.wrappedIv)).decrypt(unhex(mine.wrappedCek));
  return new TextDecoder().decode(gcm(cek, unhex(pkg.iv)).decrypt(unhex(pkg.encryptedContent)));
}

export function signMessage(text: string, signingPrivateKey: string): string {
  return hex(ml_dsa65.sign(new TextEncoder().encode(text), unhex(signingPrivateKey)));
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === "object")
    return Object.fromEntries(
      Object.keys(obj as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((obj as Record<string, unknown>)[k])]),
    );
  return obj;
}

export interface SignedBody {
  payload: Record<string, unknown>;
  signature: string;
  public_key: string;
}

/** Parse a POST body and verify it is a core buildSignedRequest envelope signed by public_key. */
export function signedBody(init: RequestInit | undefined): SignedBody & { valid: boolean } {
  const body = JSON.parse(String(init?.body)) as SignedBody;
  const bytes = new TextEncoder().encode(JSON.stringify(sortKeysDeep(body.payload)));
  let valid = false;
  try {
    valid = ml_dsa65.verify(unhex(body.signature), bytes, unhex(body.public_key));
  } catch {
    valid = false;
  }
  return { ...body, valid };
}

/** A node WebSocket stand-in: records frames, lets a test push server events. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

export function renderRoute(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ChainProvider>
        <WalletProvider autoRegister={false}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/messenger" element={<MessengerPage />} />
              <Route path="/mail" element={<MailPage />} />
              <Route path="/wallet" element={<p>wallet page</p>} />
            </Routes>
            <Toaster />
          </MemoryRouter>
        </WalletProvider>
      </ChainProvider>
    </QueryClientProvider>,
  );
}

/** Make `(max-width: 720px)` (the messenger's phone breakpoint) match, like a phone. */
export function asPhone(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
}
