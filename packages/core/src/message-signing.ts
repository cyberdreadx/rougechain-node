/**
 * Wallet message signing ("prove you control this wallet") and Sign-In with RougeChain.
 *
 * This file exists twice with the same body: `packages/core/src/message-signing.ts` (site,
 * extension) and `sdk/src/message-signing.ts` (published SDK). Only the import lines differ;
 * `packages/core/test/message-signing.test.ts` fails if the bodies drift apart.
 *
 * ## Signed bytes
 *
 *   UTF8("\x19RougeChain Signed Message:\n") ‖ decimal(len(message_bytes)) ‖ "\n" ‖ message_bytes
 *
 * signed with ML-DSA-65 (FIPS 204, empty context — the parameters every RougeChain wallet and
 * the node already use). A string message is encoded as UTF-8.
 *
 * ## Domain separation: a signed message is never a transaction signature, and vice versa
 *
 * The first signed byte is 0x19, and the signed bytes therefore are not a JSON document (RFC 8259
 * allows no raw control character below 0x20 anywhere except the whitespace 0x09 / 0x0A / 0x0D).
 * Every byte string the node verifies a transaction signature over IS a JSON document that
 * starts with `{` (0x7B), possibly after JSON whitespace:
 *
 *  1. V1 — `encode_tx_for_signing(tx)` (core/types/src/lib.rs): `serde_json::to_vec` of a struct
 *     `{"version":…,"tx_type":…,"from_pub_key":…,"nonce":…,"payload":…,"fee":…}`. First byte `{`.
 *  2. V1 legacy — `encode_tx_v1(tx)` with `sig` cleared: `serde_json::to_vec` of the `TxV1`
 *     struct. First byte `{`. (Block import only, node.rs `import_block`.)
 *  3. V2 `/api/v2/*` — `verify_signed_tx` (core/daemon/src/main.rs): the signed bytes are
 *     `payload_bytes_hex`, which must parse with `serde_json::from_slice` to a value equal to the
 *     request's `payload`, or `serde_json::to_string(payload)`; `payload` must be an object (a
 *     `timestamp` field is required). First byte `{` or JSON whitespace (0x20/0x09/0x0A/0x0D).
 *     The node keeps those bytes as the transaction's `signed_payload`.
 *  4. V2 from a peer or in a block — the signature is over `signed_payload`, and
 *     `verify_v2_binding_at` (core/daemon/src/v2_binding.rs) requires it to parse with
 *     `serde_json::from_str` as a JSON object: always in the mempool, and in consensus from
 *     TX_UNIQUENESS (mainnet height 90, testnet 1200). First byte `{` or JSON whitespace.
 *  5. CLI envelope — `{"tx_type","from","nonce","fee","payload":{…}}` canonical JSON posted to
 *     `/api/tx/broadcast`; it is a `signed_payload` and goes through (4). First byte `{`.
 *  6. Authority-cosigned `bridge_withdraw` — `encode_tx_for_signing(tx)` again. First byte `{`.
 *
 * None of them is raw caller-chosen bytes. The same holds for the node's signed requests
 * (mail / messenger / names: same check as 3), block headers (`serde_json::to_vec`, `{`),
 * finality votes (`ROUGECHAIN_FINALITY_VOTE_V2|…`, first byte `R`) and the validator rate-limit
 * header (a decimal timestamp).
 *
 * The one place the node verified a signature over `signed_payload` without parsing it is block
 * import BELOW the TX_UNIQUENESS height. Those heights are fixed history on both networks (a
 * block is only accepted at tip + 1), so no new block can use it.
 *
 * In the other direction, wallets only produce a transaction signature over the canonical JSON
 * of an object (`serializePayload`), so a transaction signature never verifies as a message.
 * A wallet that accepts caller-supplied bytes for `signTransaction` must check they are that
 * JSON for the payload it shows (the extension and Qwalla do).
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { isRougeAddress, pubkeyToAddress } from "./address";

// ─── signed bytes ────────────────────────────────────────────────────────────

/** First bytes of every signed message. 0x19 can never start a transaction's signed bytes. */
export const SIGNED_MESSAGE_PREFIX = "\x19RougeChain Signed Message:\n";

/** Largest message (in UTF-8 bytes) a wallet shows and signs through `window.rougechain.signMessage`. */
export const MAX_SIGN_MESSAGE_BYTES = 4096;

/** ML-DSA-65 sizes in bytes. */
export const ML_DSA_65_PUBLIC_KEY_BYTES = 1952;
export const ML_DSA_65_SIGNATURE_BYTES = 3309;

const utf8 = new TextEncoder();

function strictHexToBytes(hex: unknown, expectedBytes?: number): Uint8Array | null {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/** True when `s` has no lone surrogate, i.e. its UTF-8 encoding is lossless. */
function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function messageToBytes(message: string | Uint8Array): Uint8Array {
  if (typeof message === "string") {
    if (!isWellFormedString(message)) throw new Error("message is not well-formed Unicode (lone surrogate)");
    return utf8.encode(message);
  }
  if (message instanceof Uint8Array) return message;
  throw new Error("message must be a string or a Uint8Array");
}

/**
 * The exact bytes that are signed for `message`:
 * `"\x19RougeChain Signed Message:\n" ‖ decimal(byte length) ‖ "\n" ‖ message bytes`.
 */
export function messageSigningBytes(message: string | Uint8Array): Uint8Array {
  const body = messageToBytes(message);
  const head = utf8.encode(`${SIGNED_MESSAGE_PREFIX}${body.length}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Sign a message with an ML-DSA-65 private key (hex). Returns the signature as hex (3,309 bytes).
 * The signature is over {@link messageSigningBytes}, never over the bare message, so it cannot
 * be used as a transaction signature.
 */
export function signMessage(privateKeyHex: string, message: string | Uint8Array): string {
  const sk = strictHexToBytes(privateKeyHex);
  if (!sk || sk.length === 0) throw new Error("privateKeyHex must be a hex string");
  return toHex(ml_dsa65.sign(messageSigningBytes(message), sk));
}

/**
 * Verify a {@link signMessage} signature. Returns `false` for anything that is not a valid
 * signature of exactly this message by this public key — including malformed input. Never throws.
 */
export function verifyMessage(publicKeyHex: string, message: string | Uint8Array, signatureHex: string): boolean {
  try {
    const pk = strictHexToBytes(publicKeyHex, ML_DSA_65_PUBLIC_KEY_BYTES);
    const sig = strictHexToBytes(signatureHex, ML_DSA_65_SIGNATURE_BYTES);
    if (!pk || !sig) return false;
    return ml_dsa65.verify(sig, messageSigningBytes(message), pk) === true;
  } catch {
    return false;
  }
}

// ─── Sign-In with RougeChain ─────────────────────────────────────────────────

/** Fields of a sign-in message (modelled on EIP-4361, Sign-In with Ethereum). */
export interface SignInFields {
  /** Host (and port, if not the default) of the site asking for the sign-in, e.g. `tickets.example.com`. */
  domain: string;
  /** The `rouge1…` address that signs. */
  address: string;
  /** The page or API the sign-in is for, e.g. `https://tickets.example.com/login`. */
  uri: string;
  /** Optional single-line human-readable sentence. */
  statement?: string;
  /** Server-issued, single-use, at least 16 characters of `A-Z a-z 0-9 - _`. */
  nonce: string;
  /** ISO 8601 time the message was created, e.g. `2026-10-06T12:00:00.000Z`. */
  issuedAt: string;
  /** Optional ISO 8601 time after which the message must be refused. */
  expirationTime?: string;
  /** RougeChain chain id, e.g. `rougechain-mainnet-1`. */
  chainId: string;
  /** Optional list of URIs the sign-in refers to. */
  resources?: string[];
}

export const SIGN_IN_HEADER_SUFFIX = " wants you to sign in with your RougeChain account:";
export const SIGN_IN_VERSION = "1";
export const SIGN_IN_MIN_NONCE_LENGTH = 16;

const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CHAIN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Printable, no whitespace: `!`..`~`. */
const URI_RE = /^[\x21-\x7e]{1,2048}$/;
/** One line of visible text: no control characters, no line/paragraph separators, no bidi controls. */
const STATEMENT_RE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]{1,1024}$/;

function isoToMs(s: string): number {
  return ISO_TIME_RE.test(s) ? Date.parse(s) : NaN;
}

function signInFieldError(f: SignInFields): string | null {
  if (!f || typeof f !== "object") return "fields must be an object";
  if (typeof f.domain !== "string" || !DOMAIN_RE.test(f.domain)) return "domain must be a host name with an optional port (no scheme, no path)";
  if (typeof f.address !== "string" || f.address !== f.address.toLowerCase() || !isRougeAddress(f.address)) return "address must be a lower-case rouge1… address";
  if (typeof f.uri !== "string" || !URI_RE.test(f.uri)) return "uri must be a URI without whitespace";
  if (f.statement !== undefined && (typeof f.statement !== "string" || !STATEMENT_RE.test(f.statement) || f.statement !== f.statement.trim())) {
    return "statement must be one line of text";
  }
  if (typeof f.nonce !== "string" || !NONCE_RE.test(f.nonce)) return `nonce must be ${SIGN_IN_MIN_NONCE_LENGTH}–128 characters of A-Z a-z 0-9 - _`;
  if (typeof f.issuedAt !== "string" || Number.isNaN(isoToMs(f.issuedAt))) return "issuedAt must be an ISO 8601 time with a time zone";
  if (f.expirationTime !== undefined && (typeof f.expirationTime !== "string" || Number.isNaN(isoToMs(f.expirationTime)))) {
    return "expirationTime must be an ISO 8601 time with a time zone";
  }
  if (typeof f.chainId !== "string" || !CHAIN_ID_RE.test(f.chainId)) return "chainId must be a chain id such as rougechain-mainnet-1";
  if (f.resources !== undefined) {
    if (!Array.isArray(f.resources) || f.resources.length > 32) return "resources must be an array of at most 32 URIs";
    for (const r of f.resources) if (typeof r !== "string" || !URI_RE.test(r)) return "each resource must be a URI without whitespace";
  }
  return null;
}

/**
 * Build the canonical sign-in text. Throws on an invalid field.
 *
 * ```
 * tickets.example.com wants you to sign in with your RougeChain account:
 * rouge1…
 *
 * Sign in to see your tickets.
 *
 * URI: https://tickets.example.com/login
 * Version: 1
 * Chain ID: rougechain-mainnet-1
 * Nonce: 4f9c2d1e8a7b6c5d
 * Issued At: 2026-10-06T12:00:00.000Z
 * Expiration Time: 2026-10-06T12:10:00.000Z
 * Resources:
 * - https://tickets.example.com/events/42
 * ```
 *
 * Without a statement, the address is followed by two empty lines. `Expiration Time` and
 * `Resources` appear only when given. Lines end with "\n"; there is no trailing newline.
 */
export function createSignInMessage(fields: SignInFields): string {
  const err = signInFieldError(fields);
  if (err) throw new Error(`createSignInMessage: ${err}`);
  const lines = [
    `${fields.domain}${SIGN_IN_HEADER_SUFFIX}`,
    fields.address,
    "",
  ];
  if (fields.statement !== undefined) lines.push(fields.statement);
  lines.push("");
  lines.push(`URI: ${fields.uri}`);
  lines.push(`Version: ${SIGN_IN_VERSION}`);
  lines.push(`Chain ID: ${fields.chainId}`);
  lines.push(`Nonce: ${fields.nonce}`);
  lines.push(`Issued At: ${fields.issuedAt}`);
  if (fields.expirationTime !== undefined) lines.push(`Expiration Time: ${fields.expirationTime}`);
  if (fields.resources !== undefined) {
    lines.push("Resources:");
    for (const r of fields.resources) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

/**
 * Parse a sign-in message. Returns its fields, or `null` unless `text` is EXACTLY what
 * {@link createSignInMessage} produces for those fields (so there is one text per meaning and
 * nothing can hide in it). Never throws.
 */
export function parseSignInMessage(text: string): SignInFields | null {
  try {
    if (typeof text !== "string" || text.length > 16384) return null;
    const lines = text.split("\n");
    if (lines.length < 9) return null;
    if (!lines[0].endsWith(SIGN_IN_HEADER_SUFFIX)) return null;
    const fields: SignInFields = {
      domain: lines[0].slice(0, -SIGN_IN_HEADER_SUFFIX.length),
      address: lines[1],
      uri: "",
      nonce: "",
      issuedAt: "",
      chainId: "",
    };
    if (lines[2] !== "") return null;
    let i = 3;
    if (lines[3] !== "") {
      fields.statement = lines[3];
      i = 4;
    }
    if (lines[i] !== "") return null;
    i++;
    const take = (label: string): string | null => {
      const line = lines[i];
      if (line === undefined || !line.startsWith(`${label}: `)) return null;
      i++;
      return line.slice(label.length + 2);
    };
    const uri = take("URI");
    const version = take("Version");
    const chainId = take("Chain ID");
    const nonce = take("Nonce");
    const issuedAt = take("Issued At");
    if (uri === null || version !== SIGN_IN_VERSION || chainId === null || nonce === null || issuedAt === null) return null;
    fields.uri = uri;
    fields.chainId = chainId;
    fields.nonce = nonce;
    fields.issuedAt = issuedAt;
    if (lines[i] !== undefined && lines[i].startsWith("Expiration Time: ")) {
      fields.expirationTime = lines[i].slice("Expiration Time: ".length);
      i++;
    }
    if (lines[i] === "Resources:") {
      i++;
      fields.resources = [];
      while (lines[i] !== undefined && lines[i].startsWith("- ")) {
        fields.resources.push(lines[i].slice(2));
        i++;
      }
    }
    if (i !== lines.length) return null;
    if (signInFieldError(fields)) return null;
    // One canonical text per set of fields: anything else (extra spaces, "\r", other order) is refused.
    return createSignInMessage(fields) === text ? fields : null;
  } catch {
    return null;
  }
}

/**
 * The domain a text CLAIMS on its first line, if that line has the sign-in form — even when the
 * rest does not parse. Wallets use it to warn about a domain that is not the requesting site.
 */
export function claimedSignInDomain(text: string): string | null {
  if (typeof text !== "string") return null;
  const first = text.split("\n", 1)[0].replace(/\r$/, "");
  if (!first.endsWith(SIGN_IN_HEADER_SUFFIX)) return null;
  return first.slice(0, -SIGN_IN_HEADER_SUFFIX.length);
}

export type SignInFailure =
  | "malformed_message"
  | "invalid_signature"
  | "address_mismatch"
  | "domain_mismatch"
  | "nonce_mismatch"
  | "chain_id_mismatch"
  | "issued_in_future"
  | "expired"
  | "too_old";

export type VerifySignInResult =
  | { valid: true; address: string; publicKey: string; fields: SignInFields }
  | { valid: false; error: SignInFailure };

export interface VerifySignInParams {
  /** The exact text the wallet signed. */
  message: string;
  /** Hex signature returned by the wallet. */
  signature: string;
  /** Hex ML-DSA-65 public key returned by the wallet. */
  publicKey: string;
  /** Your site's host (and port, if not the default). Compared case-insensitively. */
  expectedDomain: string;
  /** The nonce your server issued for this login attempt. */
  expectedNonce: string;
  /** The chain id you accept, e.g. `rougechain-mainnet-1`. */
  expectedChainId: string;
  /** Current time (ms since epoch or a Date). Defaults to the system clock. */
  now?: number | Date;
  /** How far in the future `Issued At` may be (clock skew). Default 60 s. */
  maxClockSkewMs?: number;
  /** Refuse a message issued longer ago than this, even if it has no (or a later) expiry. */
  maxAgeMs?: number;
}

/**
 * Verify a sign-in: the text is a canonical sign-in message, the signature is valid for it, the
 * address in it is the address of `publicKey`, and its domain, nonce and chain id are the ones
 * you expect; `Issued At` is not in the future (beyond the skew) and it has not expired.
 *
 * Resolves to `{ valid: true, address, publicKey, fields }` or `{ valid: false, error }`. Never
 * throws or rejects. It cannot know whether the nonce was used before: mark `expectedNonce` as
 * used on your server before trusting the result.
 */
export async function verifySignIn(params: VerifySignInParams): Promise<VerifySignInResult> {
  const fail = (error: SignInFailure): VerifySignInResult => ({ valid: false, error });
  try {
    if (!params || typeof params !== "object") return fail("malformed_message");
    const fields = parseSignInMessage(params.message);
    if (!fields) return fail("malformed_message");
    if (!verifyMessage(params.publicKey, params.message, params.signature)) return fail("invalid_signature");
    const address = await pubkeyToAddress(params.publicKey.toLowerCase());
    if (address !== fields.address) return fail("address_mismatch");
    if (typeof params.expectedDomain !== "string" || params.expectedDomain === ""
      || fields.domain.toLowerCase() !== params.expectedDomain.toLowerCase()) return fail("domain_mismatch");
    if (typeof params.expectedNonce !== "string" || fields.nonce !== params.expectedNonce) return fail("nonce_mismatch");
    if (typeof params.expectedChainId !== "string" || fields.chainId !== params.expectedChainId) return fail("chain_id_mismatch");
    const now = params.now instanceof Date ? params.now.getTime() : (params.now ?? Date.now());
    if (typeof now !== "number" || !Number.isFinite(now)) return fail("malformed_message");
    const skew = params.maxClockSkewMs ?? 60_000;
    const issued = isoToMs(fields.issuedAt);
    if (issued > now + skew) return fail("issued_in_future");
    if (fields.expirationTime !== undefined && now >= isoToMs(fields.expirationTime)) return fail("expired");
    if (params.maxAgeMs !== undefined && now - issued > params.maxAgeMs) return fail("too_old");
    return { valid: true, address, publicKey: params.publicKey.toLowerCase(), fields };
  } catch {
    return fail("malformed_message");
  }
}

// ─── wallet side: what a wallet checks and shows before signing ──────────────

/**
 * True when `message` parses as a JSON object that looks like something the node authenticates:
 * a transaction payload (`type` / `tx_type`) or a signed request (`from` together with
 * `timestamp`). Wallets refuse to sign these as a message — the dApp must use `signTransaction`.
 * (The 0x19 prefix already makes such a signature useless to the node; this stops a dApp from
 * dressing a transaction up as "just a message".)
 */
export function looksLikeTransactionPayload(message: string): boolean {
  if (typeof message !== "string") return false;
  // Strip everything a lenient JSON reader could skip, including a byte-order mark.
  const trimmed = message.replace(/^[\s\ufeff]+|[\s\ufeff]+$/g, "");
  if (!trimmed.startsWith("{")) return false;
  try {
    const v = JSON.parse(trimmed);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
    return has("type") || has("tx_type") || (has("from") && has("timestamp"));
  } catch {
    return false;
  }
}

/**
 * The message as a wallet must display it: every character that could hide or reorder text is
 * replaced by a visible stand-in. "\n" stays a line break; other C0 controls become their
 * Unicode control picture (␉ ␍ ␛ …), and C1 controls, zero-width, bidi and separator characters
 * become `⟨U+XXXX⟩`. Nothing is removed or truncated.
 */
export function visibleMessageText(message: string): string {
  let out = "";
  for (const ch of message) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a) out += "\n";
    else if (c < 0x20) out += String.fromCharCode(0x2400 + c);
    else if (c === 0x7f) out += "\u2421";
    else if (
      (c >= 0x80 && c <= 0x9f) || c === 0xad || c === 0x061c || c === 0x180e
      || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
      || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb)
      || (c >= 0xe0000 && c <= 0xe007f)
    ) out += `\u27e8U+${c.toString(16).toUpperCase().padStart(4, "0")}\u27e9`;
    else out += ch;
  }
  return out;
}

/** What the approval screen shows for a `signMessage` request. */
export interface SignMessageReview {
  /** The exact string that will be signed. */
  message: string;
  /** {@link visibleMessageText} of it. */
  display: string;
  byteLength: number;
  lineCount: number;
  /** Host (with port) of the requesting origin. */
  originHost: string;
  /** Parsed fields when the message is a canonical sign-in message. */
  signIn: SignInFields | null;
  /** The first line has the sign-in form but the message is not a canonical sign-in message. */
  signInMalformed: boolean;
  /** RED: the message names a domain that is not the requesting site. */
  domainMismatch: boolean;
  /** The domain the message names (sign-in form only). */
  claimedDomain: string | null;
  /** RED: the sign-in message names an address that is not this wallet's. */
  addressMismatch: boolean;
  /** The sign-in message is already past its expiration time. */
  expired: boolean;
}

export const SIGN_MESSAGE_USE_SIGN_TRANSACTION_ERROR =
  "signMessage refuses a message that looks like a transaction payload. Use signTransaction to sign a transaction.";

/**
 * Validate a dApp's `signMessage` request and prepare what the wallet shows. `origin` is the
 * requesting site's origin as the wallet (not the page) knows it; `walletAddress` is the signing
 * wallet's `rouge1…` address. Returns `{ error }` for a request that must be refused without
 * asking the user.
 */
export function reviewSignMessageRequest(
  message: unknown,
  origin: string,
  walletAddress?: string,
  now: number = Date.now(),
): { error: string } | SignMessageReview {
  if (typeof message !== "string") return { error: "signMessage requires { message: string }" };
  if (message.length === 0) return { error: "signMessage requires a non-empty message" };
  if (!isWellFormedString(message)) return { error: "message is not well-formed Unicode" };
  const byteLength = utf8.encode(message).length;
  if (byteLength > MAX_SIGN_MESSAGE_BYTES) {
    return { error: `message is too long (${byteLength} bytes; the limit is ${MAX_SIGN_MESSAGE_BYTES})` };
  }
  if (looksLikeTransactionPayload(message)) return { error: SIGN_MESSAGE_USE_SIGN_TRANSACTION_ERROR };

  let originHost = "";
  try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = ""; }

  const signIn = parseSignInMessage(message);
  const claimedDomain = signIn ? signIn.domain : claimedSignInDomain(message);
  const domainMismatch = claimedDomain !== null && (originHost === "" || claimedDomain.toLowerCase() !== originHost);
  const expiry = signIn?.expirationTime !== undefined ? isoToMs(signIn.expirationTime) : NaN;
  return {
    message,
    display: visibleMessageText(message),
    byteLength,
    lineCount: message.split("\n").length,
    originHost,
    signIn,
    signInMalformed: signIn === null && claimedDomain !== null,
    domainMismatch,
    claimedDomain,
    addressMismatch: signIn !== null && walletAddress !== undefined && signIn.address !== walletAddress,
    expired: !Number.isNaN(expiry) && now >= expiry,
  };
}
