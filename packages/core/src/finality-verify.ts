/**
 * Verify, without trusting a node's "success" answer, that a transaction is included in a
 * FINALIZED RougeChain block.
 *
 * This file exists twice with the same body: `packages/core/src/finality-verify.ts` (site,
 * extension) and `sdk/src/finality-verify.ts` (published SDK). It imports nothing local, so the
 * two copies are byte-identical; `packages/core/test/finality-verify.test.ts` fails if they drift.
 *
 * ## What `verifyTxFinalized` proves
 *
 * Every hash it relies on is recomputed here from the raw block data; nothing a node states
 * (`hash`, `txId`, `success`, `finalizedHeight`, the aggregate numbers in a certificate) is used
 * as an input.
 *
 *  1. The block at the claimed height contains a transaction whose hash
 *     (`sha256(serde_json(TxV1))`, the node's `compute_single_tx_hash`) equals `txHash`.
 *  2. The header's `tx_hash` equals `sha256(serde_json(tx_0) ‖ serde_json(tx_1) ‖ …)` recomputed
 *     from the block's transaction list (order and count matter).
 *  3. The block hash equals `sha256(serde_json(header) ‖ ascii(proposer_sig))`, and the
 *     proposer's ML-DSA-65 signature over `serde_json(header)` verifies; `header.chain_id` is the
 *     chain you asked for.
 *  4. A FINALITY_V2 certificate for exactly that height and block hash carries precommit votes
 *     whose ML-DSA-65 signatures verify over
 *     `ROUGECHAIN_FINALITY_VOTE_V2|chain=<chainId>|type=precommit|height=<h>|round=0|block=<hash>`,
 *     from distinct validators of the validator set used, with voting stake ≥ floor(2·total/3)+1.
 *  5. A strict majority of the `nodes` you listed serve the same block hash at that height, and
 *     none serves a different one.
 *
 * ## What it does NOT prove
 *
 *  - **The execution outcome.** A transaction that failed during execution (for example a
 *    transfer with insufficient balance) is still included in a block and still finalized. The
 *    node's receipt status ("success" / "failed") is NOT committed in the block header today, so
 *    it cannot be verified from finalized data. It is returned as
 *    `outcome: { source: "node receipt", verified: false, value }` — treat it as the node's word.
 *  - **The validator set, unless you pin it.** Without `trustedValidatorSet` the set is fetched
 *    from a node (`/api/validators`, the CURRENT set: nodes do not expose the set for a past
 *    height) and the result says `trust: "node-reported validator set"`. A node that lies about
 *    the set can then make a certificate signed by keys it controls look valid. Pin the set
 *    (public keys and stakes) for real security.
 *  - Anything about state (balances, token supply): only inclusion and finality are checked.
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha2.js";

// ─── constants ──────────────────────────────────────────────────────────────────────────────

/** Domain tag of the FINALITY_V2 vote message (core/finality/src/lib.rs `VOTE_DOMAIN_V2`). */
export const FINALITY_VOTE_DOMAIN_V2 = "ROUGECHAIN_FINALITY_VOTE_V2";
/** FINALITY_V2 has exactly one round. */
export const FINALITY_ONLY_ROUND = 0;
/** Hard cap on votes in one certificate (core/finality `MAX_PROOF_VOTES`). */
export const FINALITY_MAX_PROOF_VOTES = 1024;
/** Mainnet height from which FINALITY_V2 certificates exist. */
export const MAINNET_FINALITY_V2_HEIGHT = 150;

// ─── lossless JSON ──────────────────────────────────────────────────────────────────────────

/** A JSON number kept as its exact source text (u64 / u128 values exceed 2^53). */
export class JsonNumber {
  constructor(readonly raw: string) {}
  toString(): string { return this.raw; }
}
export type LosslessJson = null | boolean | string | JsonNumber | LosslessJson[] | { [key: string]: LosslessJson };

const NUM_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Parse JSON keeping every number as its exact text. Objects get a null prototype; duplicate
 * keys are rejected. Throws on malformed input.
 */
export function parseJsonLossless(text: string): LosslessJson {
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const fail = (m: string): never => { throw new Error(`JSON parse error at ${i}: ${m}`); };
  const str = (): string => {
    const start = i; i++;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return JSON.parse(text.slice(start, i)) as string; }
      if (c === 0x5c) { i += 2; continue; }
      if (c < 0x20) fail("control character in string");
      i++;
    }
    return fail("unterminated string");
  };
  const val = (depth: number): LosslessJson => {
    if (depth > 256) fail("nesting too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o: { [k: string]: LosslessJson } = Object.create(null);
      ws(); if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("expected key");
        const k = str();
        if (Object.prototype.hasOwnProperty.call(o, k)) fail(`duplicate key ${k}`);
        ws(); if (text[i] !== ":") fail("expected ':'"); i++;
        o[k] = val(depth + 1);
        ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "}") { i++; return o; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++; const a: LosslessJson[] = [];
      ws(); if (text[i] === "]") { i++; return a; }
      for (;;) {
        a.push(val(depth + 1));
        ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(text);
    if (!m) return fail("unexpected token");
    i += m[0].length;
    return new JsonNumber(m[0]);
  };
  const v = val(0); ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

/** Serialize a lossless value back to JSON (keys in insertion order, numbers verbatim). */
export function stringifyLossless(v: LosslessJson): string {
  if (v === null) return "null";
  if (v instanceof JsonNumber) return v.raw;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stringifyLossless).join(",") + "]";
  return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ":" + stringifyLossless(v[k])).join(",") + "}";
}

// ─── serde_json-exact canonical encoding ────────────────────────────────────────────────────

class EncodeError extends Error {}
const bad = (m: string): never => { throw new EncodeError(m); };
const isObj = (v: LosslessJson | undefined): v is { [k: string]: LosslessJson } =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNumber);

/**
 * Format an f64 exactly as the node's serde_json does (zmij: shortest round-trip digits; fixed
 * notation for decimal exponents -5..=15 with a mandatory fractional part, otherwise
 * `d.ddde+X` / `d.ddde-X`).
 */
export function formatF64(x: number): string {
  if (!Number.isFinite(x)) return bad("non-finite float");
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, expStr] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const e = parseInt(expStr, 10);
  const len = digits.length;
  if (e >= -5 && e <= 15) {
    if (len - 1 <= e) return sign + digits + "0".repeat(e - (len - 1)) + ".0";
    if (e >= 0) return sign + digits.slice(0, e + 1) + "." + digits.slice(e + 1);
    return sign + "0." + "0".repeat(-e - 1) + digits;
  }
  return sign + digits[0] + (len > 1 ? "." + digits.slice(1) : "") + "e" + (e < 0 ? "-" : "+") + Math.abs(e);
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const I64_MIN = -(BigInt(1) << BigInt(63));

function encUint(v: LosslessJson | undefined, max: bigint, what: string): string {
  if (!(v instanceof JsonNumber) || !/^(0|[1-9][0-9]*)$/.test(v.raw)) return bad(`${what}: not an unsigned integer`);
  if (BigInt(v.raw) > max) return bad(`${what}: out of range`);
  return v.raw;
}
function encF64(v: LosslessJson | undefined, what: string): string {
  if (!(v instanceof JsonNumber)) return bad(`${what}: not a number`);
  return formatF64(Number(v.raw));
}
function encStr(v: LosslessJson | undefined, what: string): string {
  if (typeof v !== "string") return bad(`${what}: not a string`);
  return JSON.stringify(v);
}
function encBool(v: LosslessJson | undefined, what: string): string {
  if (typeof v !== "boolean") return bad(`${what}: not a boolean`);
  return v ? "true" : "false";
}
/** serde_json::Value (no `preserve_order`): object keys sorted by code point. */
function encValue(v: LosslessJson): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return stringifyLossless(v);
  if (v instanceof JsonNumber) {
    if (/^-?(0|[1-9][0-9]*)$/.test(v.raw) && v.raw !== "-0") {
      const n = BigInt(v.raw);
      if (n <= U64_MAX && n >= I64_MIN) return n.toString();
    }
    return formatF64(Number(v.raw));
  }
  if (Array.isArray(v)) return "[" + v.map(encValue).join(",") + "]";
  const keys = Object.keys(v).sort((a, b) => {
    const ca = Array.from(a), cb = Array.from(b);
    for (let k = 0; k < Math.min(ca.length, cb.length); k++) {
      const d = ca[k].codePointAt(0)! - cb[k].codePointAt(0)!;
      if (d !== 0) return d;
    }
    return ca.length - cb.length;
  });
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + encValue(v[k])).join(",") + "}";
}

type Kind = "str" | "u8" | "u16" | "u32" | "u64" | "u128" | "f64" | "bool" | "vstr" | "vu64" | "value" | "vvalue";
function encKind(kind: Kind, v: LosslessJson | undefined, what: string): string {
  switch (kind) {
    case "str": return encStr(v, what);
    case "u8": return encUint(v, BigInt(255), what);
    case "u16": return encUint(v, BigInt(65535), what);
    case "u32": return encUint(v, BigInt(4294967295), what);
    case "u64": return encUint(v, U64_MAX, what);
    case "u128": return encUint(v, U128_MAX, what);
    case "f64": return encF64(v, what);
    case "bool": return encBool(v, what);
    case "vstr": return Array.isArray(v) ? "[" + v.map((x, k) => encStr(x, `${what}[${k}]`)).join(",") + "]" : bad(`${what}: not an array`);
    case "vu64": return Array.isArray(v) ? "[" + v.map((x, k) => encUint(x, U64_MAX, `${what}[${k}]`)).join(",") + "]" : bad(`${what}: not an array`);
    case "value": return encValue(v as LosslessJson);
    case "vvalue": return Array.isArray(v) ? "[" + v.map(encValue).join(",") + "]" : bad(`${what}: not an array`);
  }
}

/** [name, kind, mode]: "req" = always present; "null" = Option emitted as null; "skip" = Option omitted when None. */
type Field = [string, Kind, "req" | "null" | "skip"];
function encStruct(v: LosslessJson | undefined, fields: Field[], what: string): string {
  if (!isObj(v)) return bad(`${what}: not an object`);
  const known = new Set(fields.map((f) => f[0]));
  for (const k of Object.keys(v)) if (!known.has(k)) bad(`${what}: unexpected field "${k}"`);
  const out: string[] = [];
  for (const [name, kind, mode] of fields) {
    const has = Object.prototype.hasOwnProperty.call(v, name);
    const x = has ? v[name] : undefined;
    if (mode === "req") {
      if (!has) bad(`${what}.${name}: missing`);
      out.push(JSON.stringify(name) + ":" + encKind(kind, x, `${what}.${name}`));
    } else if (x === undefined || x === null) {
      if (mode === "null") out.push(JSON.stringify(name) + ":null");
    } else {
      out.push(JSON.stringify(name) + ":" + encKind(kind, x, `${what}.${name}`));
    }
  }
  return "{" + out.join(",") + "}";
}

// core/types/src/lib.rs `TxPayload`, in declaration order.
const N = "null" as const, S = "skip" as const, R = "req" as const;
const PAYLOAD_FIELDS: Field[] = [
  ["to_pub_key_hex", "str", N], ["amount", "u64", N], ["faucet", "bool", N], ["target_pub_key", "str", N], ["reason", "str", N],
  ["token_name", "str", N], ["token_symbol", "str", N], ["token_decimals", "u8", N], ["token_total_supply", "u64", N],
  ["metadata_image", "str", N], ["metadata_description", "str", N], ["metadata_website", "str", N], ["metadata_twitter", "str", N], ["metadata_discord", "str", N],
  ["pool_id", "str", N], ["token_a_symbol", "str", N], ["token_b_symbol", "str", N], ["amount_a", "u64", N], ["amount_b", "u64", N],
  ["min_amount_out", "u64", N], ["swap_path", "vstr", N], ["lp_amount", "u64", N], ["evm_address", "str", N],
  ["nft_collection_symbol", "str", S], ["nft_collection_name", "str", S], ["nft_collection_id", "str", S], ["nft_description", "str", S],
  ["nft_image", "str", S], ["nft_max_supply", "u64", S], ["nft_royalty_bps", "u16", S], ["nft_royalty_recipient", "str", S],
  ["nft_token_id", "u64", S], ["nft_token_name", "str", S], ["nft_metadata_uri", "str", S], ["nft_attributes", "value", S],
  ["nft_locked", "bool", S], ["nft_public_mint", "bool", N], ["nft_mint_price", "f64", S], ["nft_token_gate_symbol", "str", S],
  ["nft_token_gate_amount", "f64", S], ["nft_discount_pct", "u32", S], ["nft_frozen", "bool", S], ["nft_batch_names", "vstr", S],
  ["nft_batch_uris", "vstr", S], ["nft_batch_attributes", "vvalue", S],
  ["shielded_nullifiers", "vstr", S], ["shielded_output_commitments", "vstr", S], ["shielded_proof", "str", S], ["shielded_fee", "u64", S],
  ["shielded_commitment", "str", S], ["shielded_value", "u64", S], ["shielded_randomness", "str", S],
  ["lock_until_height", "u64", S], ["lock_id", "str", S], ["staking_pool_id", "str", S], ["staking_reward_rate", "u64", S],
  ["proposal_id", "str", S], ["proposal_title", "str", S], ["proposal_description", "str", S], ["vote_option", "str", S],
  ["proposal_end_height", "u64", S], ["proposal_type", "str", S], ["proposal_action_payload", "value", S], ["proposal_quorum", "u64", S],
  ["proposal_timelock_blocks", "u64", S], ["delegate_to", "str", S],
  ["spender_pub_key", "str", S], ["allowance_amount", "u64", S], ["owner_pub_key", "str", S],
  ["airdrop_recipients", "vstr", S], ["airdrop_amounts", "vu64", S],
  ["contract_wasm", "str", S], ["contract_addr", "str", S], ["contract_method", "str", S], ["contract_args", "value", S],
  ["contract_gas_limit", "u64", S], ["contract_attach_symbol", "str", S], ["contract_attach_amount", "u64", S],
  ["multisig_wallet_id", "str", S], ["multisig_signers", "vstr", S], ["multisig_threshold", "u32", S], ["multisig_label", "str", S],
  ["multisig_proposal_id", "str", S], ["multisig_proposal_tx_type", "str", S], ["multisig_proposal_payload", "value", S],
  ["multisig_proposal_fee", "f64", S], ["multisig_approval_sig", "str", S],
  ["limit_order_id", "str", S], ["limit_order_expires", "u64", S],
  ["token_mintable", "bool", S], ["token_max_supply", "u64", S],
  ["shield_v2_body", "str", S], ["shield_v2_proof", "str", S],
];
const VOTE_FIELDS: Field[] = [["vote_type", "str", R], ["height", "u64", R], ["round", "u32", R], ["block_hash", "str", R], ["voter_pub_key", "str", R], ["signature", "str", R]];

/** `encode_tx_v1(tx)`: serde_json of `TxV1` (version, tx_type, from_pub_key, nonce, payload, fee, sig, signed_payload?). */
export function encodeTxV1(tx: LosslessJson): string {
  if (!isObj(tx)) return bad("tx: not an object");
  const known = ["version", "tx_type", "from_pub_key", "nonce", "payload", "fee", "sig", "signed_payload"];
  for (const k of Object.keys(tx)) if (!known.includes(k)) bad(`tx: unexpected field "${k}"`);
  for (const k of known.slice(0, 7)) if (!(k in tx)) bad(`tx.${k}: missing`);
  let s = "{" + `"version":${encUint(tx.version, BigInt(4294967295), "tx.version")}` + `,"tx_type":${encStr(tx.tx_type, "tx.tx_type")}`
    + `,"from_pub_key":${encStr(tx.from_pub_key, "tx.from_pub_key")}` + `,"nonce":${encUint(tx.nonce, U64_MAX, "tx.nonce")}`
    + `,"payload":${encStruct(tx.payload, PAYLOAD_FIELDS, "tx.payload")}` + `,"fee":${encF64(tx.fee, "tx.fee")}` + `,"sig":${encStr(tx.sig, "tx.sig")}`;
  if (tx.signed_payload !== undefined && tx.signed_payload !== null) s += `,"signed_payload":${encStr(tx.signed_payload, "tx.signed_payload")}`;
  return s + "}";
}

/** serde_json of `FinalityProof`. */
export function encodeFinalityProof(p: LosslessJson): string {
  if (!isObj(p)) return bad("parent_commit: not an object");
  const known = ["height", "block_hash", "total_stake", "voting_stake", "quorum_threshold", "precommit_votes", "created_at"];
  for (const k of Object.keys(p)) if (!known.includes(k)) bad(`parent_commit: unexpected field "${k}"`);
  for (const k of known) if (!(k in p)) bad(`parent_commit.${k}: missing`);
  if (!Array.isArray(p.precommit_votes)) return bad("parent_commit.precommit_votes: not an array");
  return "{" + `"height":${encUint(p.height, U64_MAX, "parent_commit.height")}` + `,"block_hash":${encStr(p.block_hash, "parent_commit.block_hash")}`
    + `,"total_stake":${encUint(p.total_stake, U128_MAX, "parent_commit.total_stake")}` + `,"voting_stake":${encUint(p.voting_stake, U128_MAX, "parent_commit.voting_stake")}`
    + `,"quorum_threshold":${encUint(p.quorum_threshold, U128_MAX, "parent_commit.quorum_threshold")}`
    + `,"precommit_votes":[${p.precommit_votes.map((v, k) => encStruct(v, VOTE_FIELDS, `parent_commit.precommit_votes[${k}]`)).join(",")}]`
    + `,"created_at":${encUint(p.created_at, U64_MAX, "parent_commit.created_at")}` + "}";
}

/** `encode_header_v1(header)`: serde_json of `BlockHeaderV1` (state_root / parent_commit omitted when absent). */
export function encodeHeaderV1(h: LosslessJson): string {
  if (!isObj(h)) return bad("header: not an object");
  const known = ["version", "chain_id", "height", "time", "prev_hash", "tx_hash", "proposer_pub_key", "state_root", "parent_commit"];
  for (const k of Object.keys(h)) if (!known.includes(k)) bad(`header: unexpected field "${k}"`);
  for (const k of known.slice(0, 7)) if (!(k in h)) bad(`header.${k}: missing`);
  let s = "{" + `"version":${encUint(h.version, BigInt(4294967295), "header.version")}` + `,"chain_id":${encStr(h.chain_id, "header.chain_id")}`
    + `,"height":${encUint(h.height, U64_MAX, "header.height")}` + `,"time":${encUint(h.time, U64_MAX, "header.time")}`
    + `,"prev_hash":${encStr(h.prev_hash, "header.prev_hash")}` + `,"tx_hash":${encStr(h.tx_hash, "header.tx_hash")}`
    + `,"proposer_pub_key":${encStr(h.proposer_pub_key, "header.proposer_pub_key")}`;
  if (h.state_root !== undefined && h.state_root !== null) s += `,"state_root":${encStr(h.state_root, "header.state_root")}`;
  if (h.parent_commit !== undefined && h.parent_commit !== null) s += `,"parent_commit":${encodeFinalityProof(h.parent_commit)}`;
  return s + "}";
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function fromHex(h: string): Uint8Array | null {
  if (typeof h !== "string" || h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(h.slice(2 * k, 2 * k + 2), 16);
  return out;
}
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const isHash = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** `compute_single_tx_hash(tx)` = hex(sha256(encode_tx_v1(tx))) — the hash receipts and `/api/tx/:hash` use. */
export function computeSingleTxHash(tx: LosslessJson): string { return toHex(sha256(utf8(encodeTxV1(tx)))); }
/** `compute_tx_hash(txs)` = hex(sha256(encode_tx_v1(tx_0) ‖ encode_tx_v1(tx_1) ‖ …)). */
export function computeTxListHash(txs: LosslessJson[]): string { return toHex(sha256(concat(txs.map((t) => utf8(encodeTxV1(t)))))); }
/** `compute_block_hash` = hex(sha256(encode_header_v1(header) ‖ ascii(proposer_sig))). */
export function computeBlockHash(header: LosslessJson, proposerSig: string): string {
  return toHex(sha256(concat([utf8(encodeHeaderV1(header)), utf8(proposerSig)])));
}
/** The exact bytes a validator signs (core/finality `vote_signing_message`). */
export function voteSigningMessage(chainId: string, voteType: string, height: number | bigint | string, round: number, blockHash: string): string {
  return `${FINALITY_VOTE_DOMAIN_V2}|chain=${chainId}|type=${voteType}|height=${height}|round=${round}|block=${blockHash}`;
}
function mlDsaVerify(pubHex: string, msg: Uint8Array, sigHex: string): boolean {
  const pk = fromHex(pubHex), sig = fromHex(sigHex);
  if (!pk || !sig || pk.length !== 1952 || sig.length !== 3309) return false;
  try { return ml_dsa65.verify(sig, msg, pk) === true; } catch { return false; }
}

// ─── checks ─────────────────────────────────────────────────────────────────────────────────

export interface FinalityCheck {
  /** stable identifier, e.g. "block.tx_hash" */
  name: string;
  ok: boolean;
  /** false = informational: a failure does not change `status` */
  critical: boolean;
  detail?: string;
  node?: string;
}
const check = (checks: FinalityCheck[], name: string, ok: boolean, detail?: string, extra: { critical?: boolean; node?: string } = {}) => {
  checks.push({ name, ok, critical: extra.critical ?? true, ...(detail !== undefined ? { detail } : {}), ...(extra.node ? { node: extra.node } : {}) });
  return ok;
};

// ─── validator set ──────────────────────────────────────────────────────────────────────────

export interface TrustedValidatorSet {
  /** eligible validators (non-jailed, stake > 0) and their stake in the node's raw stake units */
  validators: { publicKey: string; stake: bigint | number | string }[];
  /** the block height this set applies to (the validator state after block `height - 1`), if known */
  height?: number;
}
interface StakeSet { stakes: Map<string, bigint>; total: bigint; quorum: bigint; height?: number }
function toStakeSet(entries: { publicKey: string; stake: bigint | number | string }[], height?: number): StakeSet {
  const stakes = new Map<string, bigint>();
  for (const e of entries) {
    const s = BigInt(e.stake as bigint);
    if (s > BigInt(0)) stakes.set(e.publicKey, (stakes.get(e.publicKey) ?? BigInt(0)) + s);
  }
  let total = BigInt(0); for (const s of stakes.values()) total += s;
  return { stakes, total, quorum: (total * BigInt(2)) / BigInt(3) + BigInt(1), height };
}
/** floor(2·total/3)+1 — the FINALITY_V2 quorum. */
export function finalityQuorum(totalStake: bigint): bigint { return (totalStake * BigInt(2)) / BigInt(3) + BigInt(1); }

// ─── certificate verification ───────────────────────────────────────────────────────────────

export interface VerifiedCertificate {
  height: number;
  blockHash: string;
  /** decimal strings (stake is u128 on the node) */
  votingStake: string;
  totalStake: string;
  quorum: string;
  voters: string[];
}

/**
 * Verify a FINALITY_V2 certificate (`FinalityProof`) for `height` / `blockHash` against a
 * validator set. Recomputes voting stake, total and quorum from verified votes; the aggregate
 * numbers written in the certificate are compared afterwards (critical only when the set is
 * declared to be the set for `height`).
 */
export function verifyFinalityCertificate(
  cert: LosslessJson,
  ctx: { chainId: string; height: number; blockHash: string; validatorSet: TrustedValidatorSet },
): { ok: boolean; checks: FinalityCheck[]; verified?: VerifiedCertificate } {
  const checks: FinalityCheck[] = [];
  const set = toStakeSet(ctx.validatorSet.validators, ctx.validatorSet.height);
  if (!isObj(cert)) { check(checks, "cert.shape", false, "certificate is not an object"); return { ok: false, checks }; }
  try { encodeFinalityProof(cert); check(checks, "cert.shape", true); }
  catch (e) { check(checks, "cert.shape", false, (e as Error).message); return { ok: false, checks }; }
  const h = (cert.height as JsonNumber).raw;
  if (!check(checks, "cert.height", h === String(ctx.height), `certificate height ${h}, block height ${ctx.height}`)) return { ok: false, checks };
  if (!check(checks, "cert.block_hash", cert.block_hash === ctx.blockHash, `certificate is for ${String(cert.block_hash)}, block hash is ${ctx.blockHash}`)) return { ok: false, checks };
  if (!check(checks, "validator_set.nonempty", set.stakes.size > 0 && set.total > BigInt(0), `${set.stakes.size} validators, total stake ${set.total}`)) return { ok: false, checks };
  const votes = cert.precommit_votes as LosslessJson[];
  if (!check(checks, "cert.vote_count", votes.length <= FINALITY_MAX_PROOF_VOTES && votes.length <= set.stakes.size, `${votes.length} votes, ${set.stakes.size} validators`)) return { ok: false, checks };
  const voters = new Set<string>();
  let voting = BigInt(0);
  let allVotesOk = true;
  votes.forEach((raw, k) => {
    const v = raw as { [key: string]: LosslessJson };
    const who = typeof v.voter_pub_key === "string" ? v.voter_pub_key.slice(0, 16) : "?";
    const fail = (why: string) => { allVotesOk = false; check(checks, `cert.vote[${k}]`, false, `${who}…: ${why}`); };
    if (v.vote_type !== "precommit") return fail("not a precommit");
    if ((v.round as JsonNumber).raw !== String(FINALITY_ONLY_ROUND)) return fail(`round ${(v.round as JsonNumber).raw}`);
    if ((v.height as JsonNumber).raw !== String(ctx.height)) return fail(`height ${(v.height as JsonNumber).raw}`);
    if (!isHash(v.block_hash) || v.block_hash !== ctx.blockHash) return fail("vote is for a different block hash");
    const pk = v.voter_pub_key as string;
    const stake = set.stakes.get(pk);
    if (stake === undefined) return fail("voter is not in the validator set");
    const msg = voteSigningMessage(ctx.chainId, "precommit", ctx.height, FINALITY_ONLY_ROUND, ctx.blockHash);
    if (!mlDsaVerify(pk, utf8(msg), v.signature as string)) return fail("ML-DSA-65 signature does not verify over the vote message");
    if (voters.has(pk)) return fail("duplicate voter");
    voters.add(pk); voting += stake;
    check(checks, `cert.vote[${k}]`, true, `${who}…: signature valid, stake ${stake}`);
  });
  if (!allVotesOk) return { ok: false, checks };
  if (!check(checks, "cert.quorum", voting >= set.quorum, `voting stake ${voting} / quorum ${set.quorum} (total ${set.total})`)) return { ok: false, checks };
  const forHeight = set.height === ctx.height;
  const claims = [["voting_stake", voting], ["total_stake", set.total], ["quorum_threshold", set.quorum]] as const;
  for (const [field, val] of claims) {
    const claimed = (cert[field] as JsonNumber).raw;
    check(checks, `cert.claim.${field}`, claimed === val.toString(),
      claimed === val.toString() ? undefined : `certificate claims ${claimed}, recomputed ${val}${forHeight ? "" : " (the set used is not declared to be the set for this height)"}`,
      { critical: forHeight });
  }
  const critOk = checks.every((c) => c.ok || !c.critical);
  return { ok: critOk, checks, verified: critOk ? { height: ctx.height, blockHash: ctx.blockHash, votingStake: voting.toString(), totalStake: set.total.toString(), quorum: set.quorum.toString(), voters: [...voters] } : undefined };
}

// ─── fetching ───────────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
interface Net { fetch: FetchLike; timeoutMs: number }

/** Normalize a node URL to its API base (`…/api`). Accepts an origin or an `/api` base. */
export function apiBase(node: string): string {
  const n = node.replace(/\/+$/, "");
  return /\/api$/.test(n) ? n : n + "/api";
}
async function getJson(net: Net, url: string): Promise<{ ok: true; body: LosslessJson; error?: undefined } | { ok: false; error: string; status?: number }> {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = ac ? setTimeout(() => ac.abort(), net.timeoutMs) : undefined;
  try {
    const res = await net.fetch(url, ac ? { signal: ac.signal } : undefined);
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, body: parseJsonLossless(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message || String(e) };
  } finally { if (timer) clearTimeout(timer); }
}
const defaultFetch = (): FetchLike => {
  if (typeof fetch !== "function") throw new Error("no global fetch: pass options.fetch");
  return fetch as unknown as FetchLike;
};

// ─── block verification ─────────────────────────────────────────────────────────────────────

export interface VerifiedBlock {
  height: number;
  /** recomputed from header + proposer signature (never the node's `hash` field) */
  blockHash: string;
  chainId: string;
  proposer: string;
  /** recomputed hash of every transaction, in block order */
  txHashes: string[];
  /** the raw (lossless) block as served */
  raw: { [k: string]: LosslessJson };
}
export interface FetchAndVerifyBlockOptions { node: string; chainId: string; fetch?: FetchLike; timeoutMs?: number }
export interface FetchAndVerifyBlockResult {
  ok: boolean;
  block: VerifiedBlock | null;
  /** block `height + 1` as served by the same node (unverified; its header carries the certificate of `height`), or null at the tip */
  next: { [k: string]: LosslessJson } | null;
  checks: FinalityCheck[];
}

/**
 * Verify one raw `BlockV1` (as served by `/api/blocks?from_height=`): shape, chain id, the
 * header's `tx_hash` against the transaction list, the block hash, and the proposer's ML-DSA-65
 * signature over the header.
 */
export function verifyBlock(raw: LosslessJson, opts: { chainId: string; height?: number; node?: string }): { ok: boolean; block: VerifiedBlock | null; checks: FinalityCheck[] } {
  const checks: FinalityCheck[] = [];
  const node = opts.node;
  if (!isObj(raw) || !isObj(raw.header) || !Array.isArray(raw.txs) || typeof raw.proposer_sig !== "string") {
    check(checks, "block.shape", false, "not a BlockV1 {version, header, txs, proposer_sig, hash}", { node });
    return { ok: false, block: null, checks };
  }
  const header = raw.header;
  let headerBytes: string;
  let txHashes: string[];
  try {
    headerBytes = encodeHeaderV1(header);
    txHashes = raw.txs.map((t) => computeSingleTxHash(t));
    check(checks, "block.shape", true, undefined, { node });
  } catch (e) {
    check(checks, "block.shape", false, (e as Error).message, { node });
    return { ok: false, block: null, checks };
  }
  const height = Number((header.height as JsonNumber).raw);
  if (opts.height !== undefined && !check(checks, "block.height", height === opts.height, `served height ${height}, requested ${opts.height}`, { node })) return { ok: false, block: null, checks };
  check(checks, "block.chain_id", header.chain_id === opts.chainId, `header chain_id ${JSON.stringify(header.chain_id)}, expected ${JSON.stringify(opts.chainId)}`, { node });
  const recomputedTxHash = computeTxListHash(raw.txs);
  check(checks, "block.tx_hash", recomputedTxHash === header.tx_hash, `recomputed ${recomputedTxHash} from ${raw.txs.length} transaction(s), header says ${String(header.tx_hash)}`, { node });
  const blockHash = toHex(sha256(concat([utf8(headerBytes), utf8(raw.proposer_sig)])));
  check(checks, "block.hash", blockHash === raw.hash, `recomputed ${blockHash}, node says ${String(raw.hash)}`, { node });
  const proposer = header.proposer_pub_key as string;
  check(checks, "block.proposer_signature", mlDsaVerify(proposer, utf8(headerBytes), raw.proposer_sig), "ML-DSA-65 signature of header.proposer_pub_key over the serialized header", { node });
  const ok = checks.every((c) => c.ok || !c.critical);
  return { ok, block: ok ? { height, blockHash, chainId: opts.chainId, proposer, txHashes, raw } : null, checks };
}

/** Fetch block `height` (and `height + 1`, for its parent certificate) from one node and verify it. */
export async function fetchAndVerifyBlock(height: number, options: FetchAndVerifyBlockOptions): Promise<FetchAndVerifyBlockResult> {
  const net: Net = { fetch: options.fetch ?? defaultFetch(), timeoutMs: options.timeoutMs ?? 15000 };
  const node = apiBase(options.node);
  const checks: FinalityCheck[] = [];
  const r = await getJson(net, `${node}/blocks?from_height=${height}&limit=2`);
  const blocks = r.ok && isObj(r.body) && Array.isArray(r.body.blocks) ? r.body.blocks : null;
  const first = blocks && blocks.length > 0 ? blocks[0] : undefined;
  if (!check(checks, "block.fetch", !!first, !r.ok ? r.error : first ? undefined : `no block at height ${height}`, { node })) return { ok: false, block: null, next: null, checks };
  const v = verifyBlock(first as LosslessJson, { chainId: options.chainId, height, node });
  checks.push(...v.checks);
  let next: { [k: string]: LosslessJson } | null = null;
  const second = blocks && blocks.length > 1 ? blocks[1] : undefined;
  if (isObj(second) && isObj(second.header) && second.header.height instanceof JsonNumber && second.header.height.raw === String(height + 1)) next = second;
  return { ok: v.ok, block: v.block, next, checks };
}

// ─── verifyTxFinalized ──────────────────────────────────────────────────────────────────────

export type FinalityStatus = "finalized" | "included-not-finalized" | "not-found" | "invalid";
export type ValidatorSetTrust = "pinned validator set" | "node-reported validator set";

export interface VerifyTxFinalizedOptions {
  txHash: string;
  /** one or more node API URLs (`https://host/api` or an origin; `/api` is appended if missing) */
  nodes: string[];
  /** e.g. "rougechain-mainnet-1"; must equal every verified header's chain_id and is part of every vote message */
  chainId: string;
  /** pin the validator set (strongly recommended). Without it the CURRENT set is fetched from the first node. */
  trustedValidatorSet?: TrustedValidatorSet;
  /** require tip - height + 1 ≥ this (default 1). Finality, not depth, is what makes a block final. */
  minConfirmations?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
}
export interface VerifyTxFinalizedResult {
  status: FinalityStatus;
  height: number | null;
  /** recomputed block hash */
  blockHash: string | null;
  txIndex: number | null;
  trust: ValidatorSetTrust;
  proof: {
    chainId: string;
    header: { height: number; time: string; prevHash: string; txHash: string; stateRoot: string | null; proposer: string };
    certificateSource: "parent_commit of the next block" | "/api/finality/:height" | null;
    certificate: VerifiedCertificate | null;
    validatorSetSource: ValidatorSetTrust;
    nodesAgreeing: string[];
  } | null;
  /**
   * NOT VERIFIED. The node's receipt status ("Success" or { Failed: reason }). The outcome is
   * not committed in the block header, so a finalized transaction may still have failed.
   */
  outcome: { source: "node receipt"; verified: false; value: LosslessJson | null };
  checks: FinalityCheck[];
}

/**
 * Verify that `txHash` is included in a block that is FINALIZED under FINALITY_V2, recomputing
 * every hash it relies on and checking every signature, and cross-checking the block across
 * `nodes` (a strict majority must serve the same block hash; any conflicting block → "invalid").
 *
 * Returns every check performed (pass/fail), never just a boolean:
 *  - `finalized`: inclusion, block integrity, the finality certificate and the cross-node check passed.
 *  - `included-not-finalized`: the transaction is in a valid block but no certificate exists yet
 *    (e.g. the tip), finality is not active at that height, too few nodes answered, no validator
 *    set could be obtained, or
 *    `minConfirmations` is not met.
 *  - `not-found`: no node knows the transaction, or the block at the claimed height does not
 *    contain it, or the block could not be fetched.
 *  - `invalid`: data failed verification (hash, signature, chain id, certificate, conflicting nodes).
 *
 * IT DOES NOT PROVE THE TRANSACTION SUCCEEDED. Execution outcome is not committed in the block
 * header today: a transaction that failed (for example a transfer with insufficient balance) is
 * still included and finalized. `outcome` carries the node's receipt with `verified: false`.
 *
 * Without `trustedValidatorSet`, the validator set comes from a node (`trust: "node-reported
 * validator set"`), and that node is trusted for it. Nodes expose only the CURRENT set, not the
 * set for a past height; pin the set for real security.
 */
export async function verifyTxFinalized(options: VerifyTxFinalizedOptions): Promise<VerifyTxFinalizedResult> {
  const checks: FinalityCheck[] = [];
  const net: Net = { fetch: options.fetch ?? defaultFetch(), timeoutMs: options.timeoutMs ?? 15000 };
  const trust: ValidatorSetTrust = options.trustedValidatorSet ? "pinned validator set" : "node-reported validator set";
  const result = (status: FinalityStatus, extra: Partial<VerifyTxFinalizedResult> = {}): VerifyTxFinalizedResult => ({
    status, height: null, blockHash: null, txIndex: null, trust, proof: null,
    outcome: { source: "node receipt", verified: false, value: null }, checks, ...extra,
  });
  const txHash = typeof options.txHash === "string" ? options.txHash.toLowerCase() : "";
  const nodes = Array.from(new Set((options.nodes ?? []).map(apiBase)));
  if (!check(checks, "input", isHash(txHash) && nodes.length > 0 && typeof options.chainId === "string" && options.chainId.length > 0,
    "txHash must be 64 hex characters; at least one node and a chainId are required")) return result("invalid");

  // 1. Where is it? The node's answer is a HINT only.
  let hint: number | null = null; let hintNode: string | null = null; let receipt: LosslessJson | null = null;
  for (const node of nodes) {
    const r = await getJson(net, `${node}/tx/${txHash}`);
    if (r.ok && isObj(r.body) && r.body.success === true && r.body.blockHeight instanceof JsonNumber) {
      hint = Number(r.body.blockHeight.raw); hintNode = node; receipt = isObj(r.body.receipt) ? r.body.receipt : null;
      break;
    }
  }
  const outcomeValue = isObj(receipt) && receipt.status !== undefined ? receipt.status : null;
  const outcome = { source: "node receipt" as const, verified: false as const, value: outcomeValue };
  if (!check(checks, "tx.lookup", hint !== null, hint !== null ? `node reports height ${hint} (hint only)` : "no node reports this transaction", { node: hintNode ?? undefined }))
    return result("not-found", { outcome });

  // 2. Fetch and verify the block from the node that answered, falling back to the others.
  let fb: FetchAndVerifyBlockResult | null = null; let primary = hintNode!;
  for (const node of [hintNode!, ...nodes.filter((n) => n !== hintNode)]) {
    const r = await fetchAndVerifyBlock(hint!, { node, chainId: options.chainId, fetch: net.fetch, timeoutMs: net.timeoutMs });
    checks.push(...r.checks);
    if (r.checks.some((c) => c.name === "block.fetch" && c.ok)) { fb = r; primary = node; break; }
  }
  const base = { outcome, height: hint };
  if (!fb) return result("not-found", base);
  if (!fb.ok || !fb.block) return result("invalid", base);
  const block = fb.block;
  const txIndex = block.txHashes.indexOf(txHash);
  const header = block.raw.header as { [k: string]: LosslessJson };
  const withBlock = { ...base, height: block.height, blockHash: block.blockHash };
  if (!check(checks, "tx.in_block", txIndex >= 0, txIndex >= 0 ? `transaction ${txIndex} of ${block.txHashes.length} (hash recomputed)` : `none of the ${block.txHashes.length} transaction(s) in block ${block.height} hashes to ${txHash}`, { node: primary }))
    return result("not-found", withBlock);
  const withTx = { ...withBlock, txIndex };

  // 3. Validator set.
  let vset: TrustedValidatorSet | null = options.trustedValidatorSet ?? null;
  if (vset) {
    check(checks, "validator_set", true, `pinned: ${vset.validators.length} validator(s)${vset.height !== undefined ? ` for height ${vset.height}` : ""}`);
  } else {
    const r = await getJson(net, `${primary}/validators`);
    const list = r.ok && isObj(r.body) && Array.isArray(r.body.validators) ? r.body.validators : null;
    if (list) {
      vset = { validators: list.filter((v) => isObj(v) && v.status === "active" && typeof v.publicKey === "string" && v.stake instanceof JsonNumber)
        .map((v) => { const o = v as { [k: string]: LosslessJson }; return { publicKey: o.publicKey as string, stake: BigInt((o.stake as JsonNumber).raw) }; }) };
    }
    check(checks, "validator_set", !!vset, vset
      ? `node-reported CURRENT set from ${primary}: ${vset.validators.length} active validator(s). The node does not expose the set for a past height; this result trusts the node for the set.`
      : `could not fetch /validators: ${!r.ok ? r.error : "bad response"}`, { node: primary });
  }
  if (vset) {
    const inSet = vset.validators.some((v) => v.publicKey === block.proposer);
    check(checks, "block.proposer_in_set", inSet, inSet ? "the proposer is in the validator set used" : "the proposer is not in the validator set used", { critical: false });
  }

  // 4. Finality certificate: the next block's parent_commit, else /finality/:height.
  let cert: LosslessJson | null = null; let certSource: "parent_commit of the next block" | "/api/finality/:height" | null = null;
  if (fb.next && isObj(fb.next.header) && isObj(fb.next.header.parent_commit)) { cert = fb.next.header.parent_commit; certSource = "parent_commit of the next block"; }
  else {
    for (const node of [primary, ...nodes.filter((n) => n !== primary)]) {
      const r = await getJson(net, `${node}/finality/${block.height}`);
      if (r.ok && isObj(r.body) && r.body.success === true && isObj(r.body.proof)) { cert = r.body.proof; certSource = "/api/finality/:height"; break; }
    }
  }
  let verifiedCert: VerifiedCertificate | null = null;
  const proofOf = () => ({
    chainId: options.chainId,
    header: { height: block.height, time: (header.time as JsonNumber).raw, prevHash: header.prev_hash as string, txHash: header.tx_hash as string, stateRoot: typeof header.state_root === "string" ? header.state_root : null, proposer: block.proposer },
    certificateSource: certSource, certificate: verifiedCert, validatorSetSource: trust, nodesAgreeing,
  });
  const nodesAgreeing: string[] = [primary];
  if (!cert) {
    check(checks, "finality.certificate", false, `no finality certificate for height ${block.height} yet${options.chainId === "rougechain-mainnet-1" && block.height < MAINNET_FINALITY_V2_HEIGHT ? ` (FINALITY_V2 starts at mainnet height ${MAINNET_FINALITY_V2_HEIGHT})` : ""}`);
    return result("included-not-finalized", { ...withTx, proof: proofOf() });
  }
  check(checks, "finality.certificate", true, `from ${certSource}`);
  if (!vset) return result("included-not-finalized", { ...withTx, proof: proofOf() }); // could not obtain a set: finality unproven, nothing failed
  const cv = verifyFinalityCertificate(cert, { chainId: options.chainId, height: block.height, blockHash: block.blockHash, validatorSet: vset });
  checks.push(...cv.checks);
  if (!cv.ok) return result("invalid", { ...withTx, proof: proofOf() });
  verifiedCert = cv.verified!;

  // 5. Cross-check across nodes: strict majority must serve this block hash; any conflict → invalid.
  let conflict = false; let answered = 1;
  for (const node of nodes) {
    if (node === primary) continue;
    const r = await getJson(net, `${node}/blocks?from_height=${block.height}&limit=1`);
    const b = r.ok && isObj(r.body) && Array.isArray(r.body.blocks) && r.body.blocks.length > 0 ? r.body.blocks[0] : null;
    if (!isObj(b) || !isObj(b.header) || !(b.header.height instanceof JsonNumber) || b.header.height.raw !== String(block.height) || typeof b.proposer_sig !== "string") {
      check(checks, "nodes.answer", false, !r.ok ? r.error : `no block at height ${block.height}`, { node, critical: false });
      continue;
    }
    answered++;
    let theirs: string;
    try { theirs = computeBlockHash(b.header, b.proposer_sig); } catch (e) { theirs = `unencodable (${(e as Error).message})`; }
    if (theirs === block.blockHash) { nodesAgreeing.push(node); check(checks, "nodes.same_block", true, `recomputed ${theirs}`, { node }); }
    else { conflict = true; check(checks, "nodes.same_block", false, `serves a different block at height ${block.height}: recomputed ${theirs}, expected ${block.blockHash}`, { node }); }
  }
  const majority = Math.floor(nodes.length / 2) + 1;
  if (conflict) return result("invalid", { ...withTx, proof: proofOf() });
  if (!check(checks, "nodes.majority", nodesAgreeing.length >= majority,
    `${nodesAgreeing.length} of ${nodes.length} node(s) serve this block (${answered} answered, need ${majority})${nodes.length === 1 ? "; a single node is not cross-checked" : ""}`))
    return result("included-not-finalized", { ...withTx, proof: proofOf() });

  // 6. Optional depth.
  const minConf = options.minConfirmations ?? 1;
  if (minConf > 1) {
    const r = await getJson(net, `${primary}/stats`);
    const tip = r.ok && isObj(r.body) && r.body.network_height instanceof JsonNumber ? Number(r.body.network_height.raw) : null;
    const conf = tip === null ? 0 : tip - block.height + 1;
    if (!check(checks, "confirmations", conf >= minConf, tip === null ? "could not read the tip height" : `${conf} confirmation(s) (tip ${tip}), required ${minConf}`, { node: primary }))
      return result("included-not-finalized", { ...withTx, proof: proofOf() });
  }
  return result("finalized", { ...withTx, proof: proofOf() });
}
