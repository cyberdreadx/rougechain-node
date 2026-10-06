/**
 * signMessage / verifyMessage / Sign-In with RougeChain, and the domain-separation proof: a
 * signed message can never be a transaction signature (and the other way round).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { pubkeyToAddress } from "../src/address";
import { createSignedTransfer, serializePayload, signTransaction, verifyTransaction, type TransactionPayload } from "../src/pqc-signer";
import {
  MAX_SIGN_MESSAGE_BYTES,
  SIGNED_MESSAGE_PREFIX,
  SIGN_MESSAGE_USE_SIGN_TRANSACTION_ERROR,
  claimedSignInDomain,
  createSignInMessage,
  looksLikeTransactionPayload,
  messageSigningBytes,
  parseSignInMessage,
  reviewSignMessageRequest,
  signMessage,
  verifyMessage,
  verifySignIn,
  visibleMessageText,
  type SignInFields,
  type SignMessageReview,
} from "../src/message-signing";
import vector from "./fixtures/sign-message-vector.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = (p: string) => readFileSync(path.resolve(here, "../../..", p), "utf8");

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const kp = ml_dsa65.keygen(new Uint8Array(32).fill(7));
const pub = hex(kp.publicKey);
const priv = hex(kp.secretKey);
const other = ml_dsa65.keygen(new Uint8Array(32).fill(8));
const otherPub = hex(other.publicKey);
const otherPriv = hex(other.secretKey);
const ch = (code: number) => String.fromCharCode(code);

describe("signed bytes", () => {
  it("are prefix || decimal(byte length) || LF || message", () => {
    expect(SIGNED_MESSAGE_PREFIX.charCodeAt(0)).toBe(0x19);
    expect(SIGNED_MESSAGE_PREFIX.slice(1)).toBe("RougeChain Signed Message:\n");
    const bytes = messageSigningBytes("hello");
    expect(new TextDecoder().decode(bytes)).toBe(ch(0x19) + "RougeChain Signed Message:\n5\nhello");
    // length is the UTF-8 BYTE length, not the character count
    const multi = "h" + ch(0xe9) + "llo " + ch(0x2713);
    expect(new TextDecoder().decode(messageSigningBytes(multi))).toBe(ch(0x19) + "RougeChain Signed Message:\n10\n" + multi);
    // a Uint8Array is signed as is
    expect(hex(messageSigningBytes(new Uint8Array([0, 255, 1])))).toBe(hex(new TextEncoder().encode(SIGNED_MESSAGE_PREFIX + "3\n")) + "00ff01");
    expect(hex(messageSigningBytes(new TextEncoder().encode("hello")))).toBe(hex(bytes));
  });

  it("the length prefix makes the framing unambiguous", () => {
    expect(hex(messageSigningBytes("1\nab"))).not.toBe(hex(messageSigningBytes("ab")));
    expect(hex(messageSigningBytes(""))).toBe(hex(new TextEncoder().encode(SIGNED_MESSAGE_PREFIX + "0\n")));
  });

  it("refuses a string whose UTF-8 encoding would be lossy", () => {
    expect(() => messageSigningBytes("a" + ch(0xd800))).toThrow(/well-formed/);
    expect(() => signMessage(priv, ch(0xdc00) + "a")).toThrow(/well-formed/);
    expect(verifyMessage(pub, "a" + ch(0xd800), "00")).toBe(false);
  });
});

describe("signMessage / verifyMessage", () => {
  const sig = signMessage(priv, "hello");

  it("round-trips for strings and bytes", () => {
    expect(sig).toMatch(/^[0-9a-f]{6618}$/);
    expect(verifyMessage(pub, "hello", sig)).toBe(true);
    expect(verifyMessage(pub, new TextEncoder().encode("hello"), sig)).toBe(true);
    expect(verifyMessage(pub.toUpperCase(), "hello", sig.toUpperCase())).toBe(true);
    const bin = new Uint8Array([1, 2, 3, 0x19]);
    expect(verifyMessage(pub, bin, signMessage(priv, bin))).toBe(true);
  });

  it("is a signature over the prefixed bytes, not over the bare message", () => {
    expect(ml_dsa65.verify(unhex(sig), messageSigningBytes("hello"), kp.publicKey)).toBe(true);
    expect(ml_dsa65.verify(unhex(sig), new TextEncoder().encode("hello"), kp.publicKey)).toBe(false);
  });

  it("returns false for another message, key or signature", () => {
    expect(verifyMessage(pub, "hello ", sig)).toBe(false);
    expect(verifyMessage(pub, "Hello", sig)).toBe(false);
    expect(verifyMessage(otherPub, "hello", sig)).toBe(false);
    expect(verifyMessage(pub, "hello", signMessage(otherPriv, "hello"))).toBe(false);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(verifyMessage(pub, "hello", flipped)).toBe(false);
  });

  it("never throws on malformed input", () => {
    const bad: unknown[] = [undefined, null, 42, {}, [], "", "zz", "abc", "00", sig.slice(2), sig + "00", pub.slice(2), "g".repeat(3904), "g".repeat(6618)];
    for (const b of bad) {
      expect(verifyMessage(b as string, "hello", sig)).toBe(false);
      expect(verifyMessage(pub, "hello", b as string)).toBe(false);
      expect(verifyMessage(pub, b as string, sig)).toBe(false);
    }
  });

  it("signMessage refuses a private key that is not hex", () => {
    expect(() => signMessage("not hex", "hello")).toThrow();
    expect(() => signMessage("", "hello")).toThrow();
  });
});

describe("shared test vector (the same file is checked by the SDK and by Qwalla)", () => {
  it("the fixed key is the one in the vector", async () => {
    const k = ml_dsa65.keygen(unhex(vector.seedHex));
    expect(hex(k.publicKey)).toBe(vector.publicKey);
    expect(await pubkeyToAddress(vector.publicKey)).toBe(vector.address);
  });

  it("signed bytes are reproduced exactly and the recorded signature verifies", () => {
    expect(hex(messageSigningBytes(vector.message))).toBe(vector.signedBytesHex);
    expect(vector.signedBytesHex.startsWith("19")).toBe(true);
    expect(verifyMessage(vector.publicKey, vector.message, vector.signature)).toBe(true);
    expect(verifyMessage(vector.publicKey, vector.message + " ", vector.signature)).toBe(false);
  });

  it("a fresh signature by the vector key verifies too (signing is randomized)", () => {
    const k = ml_dsa65.keygen(unhex(vector.seedHex));
    const again = signMessage(hex(k.secretKey), vector.message);
    expect(verifyMessage(vector.publicKey, vector.message, again)).toBe(true);
  });

  it("the vector message is a canonical sign-in message", async () => {
    const res = await verifySignIn({
      message: vector.message, signature: vector.signature, publicKey: vector.publicKey,
      expectedDomain: "tickets.example.com", expectedNonce: "4f9c2d1e8a7b6c5d0011", expectedChainId: "rougechain-mainnet-1",
      now: Date.parse("2026-10-06T12:01:00.000Z"),
    });
    expect(res).toMatchObject({ valid: true, address: vector.address });
  });
});

/**
 * DOMAIN SEPARATION. Every byte string the node verifies a TRANSACTION signature over is a JSON
 * document starting with `{` (after optional JSON whitespace). Signed-message bytes start with
 * 0x19 and are never JSON. The Rust facts are asserted against the node source so this fails if
 * a new, non-JSON signing format is ever added without revisiting this proof.
 */
describe("domain separation: a signed message is never a transaction signature", () => {
  const typesRs = repo("core/types/src/lib.rs");
  const nodeRs = repo("core/daemon/src/node.rs");
  const mainRs = repo("core/daemon/src/main.rs");
  const bindingRs = repo("core/daemon/src/v2_binding.rs");
  const fn = (src: string, start: string, len = 2600) => {
    const i = src.indexOf(start);
    expect(i, `${start} not found`).toBeGreaterThan(-1);
    return src.slice(i, i + len);
  };

  it("format 1 + 6 (V1, authority-cosigned withdraw): encode_tx_for_signing is serde_json of a struct => first byte {", () => {
    const body = fn(typesRs, "pub fn encode_tx_for_signing(tx: &TxV1) -> Vec<u8>", 700);
    expect(body).toContain("struct Signable<'a>");
    expect(body).toContain("serde_json::to_vec(&s)");
  });

  it("format 2 (V1 legacy): encode_tx_v1 is serde_json of the TxV1 struct => first byte {", () => {
    expect(fn(typesRs, "pub fn encode_tx_v1(tx: &TxV1) -> Vec<u8>", 120)).toContain("serde_json::to_vec(tx)");
    expect(typesRs).toMatch(/#\[derive\([^)]*Serialize[^)]*\)\]\s*pub struct TxV1 \{/);
  });

  it("format 3 (/api/v2/*): verify_signed_tx only verifies bytes that are JSON equal to an object payload", () => {
    const body = fn(mainRs, "async fn verify_signed_tx(req: &SignedTransactionRequest)");
    expect(body).toContain("serde_json::from_slice(&raw)");
    expect(body).toContain("if parsed != req.payload");
    expect(body).toContain("serde_json::to_string(&req.payload)");
    // a `timestamp` member is required, so the payload is a JSON object
    expect(body).toContain('req.payload.get("timestamp")');
    expect(body).toContain("payload must include a 'timestamp' field");
  });

  it("formats 4 + 5 (signed_payload from peers / blocks, CLI envelope): the binding requires a JSON object", () => {
    const body = fn(bindingRs, "fn verify_binding(tx: &TxV1", 700);
    expect(body).toContain("serde_json::from_str(sp)");
    expect(body).toContain('if !p.is_object() { return Err("signed_payload is not a JSON object"');
    // ...in the mempool always, and in consensus from the TX_UNIQUENESS height
    expect(fn(nodeRs, "fn insert_tx_to_mempool(&self, tx: TxV1)", 1600)).toContain("crate::v2_binding::verify_v2_binding_at(&tx, next_height)?;");
    expect(fn(nodeRs, "fn check_block_tx_uniqueness(&self, block: &BlockV1)", 900)).toContain("crate::v2_binding::verify_v2_binding_at(tx, block.header.height)");
    expect(nodeRs).toContain("pub const TX_UNIQUENESS_ACTIVATION_HEIGHT: Option<u64> = Some(90);");
    // a block is only accepted at tip + 1, so the heights below activation are closed history
    expect(fn(nodeRs, "pub fn import_block(&self, block: BlockV1)", 1400)).toContain("if block.header.height != tip.height + 1 {");
  });

  it("the node verifies a transaction signature over exactly these inputs and no other", () => {
    // Every pqc_verify call in the daemon, by the expression it verifies. A new call site with a
    // new kind of input makes this fail: add it to the proof (message-signing.ts) first.
    const inputs = new Set<string>();
    for (const src of [nodeRs, mainRs]) {
      for (const m of src.matchAll(/pqc_verify\(\s*&?([A-Za-z0-9_.]+),\s*&?([A-Za-z0-9_.()]+(?:\([^)]*\))?),/g)) inputs.add(m[2]);
    }
    expect([...inputs].sort()).toEqual([
      "b", // encode_tx_for_signing(tx)            (authority-cosigned bridge_withdraw)
      "bytes", // encode_tx_for_signing(tx) / signed_payload bytes
      "bytes_legacy", // encode_tx_v1(legacy)
      "bytes_new", // encode_tx_for_signing(tx)
      "encode_tx_for_signing(&m)", // tests
      "encode_tx_for_signing(&t)", // tests
      "encode_tx_for_signing(tx)", // tests
      "encode_tx_v1(&legacy)", // tests
      "header_bytes", // encode_header_v1 (block proposer, JSON)
      "payload_bytes", // /api/v2 batch: JSON equal to payload
      "sp.as_bytes()", // signed_payload (JSON object, see above)
      "ts_str.as_bytes()", // validator rate-limit header: a decimal timestamp
      "verify_bytes", // verify_signed_tx / verify_signed_request: JSON equal to payload
    ]);
  });

  it("signed-message bytes start with 0x19 and are never JSON; transaction bytes start with {", () => {
    const messages = ["hello", "{}", '{"type":"transfer"}', " {\"a\":1}", "", "\n", vector.message, JSON.stringify({ from: pub, to: otherPub, amount: 1 })];
    for (const m of messages) {
      const bytes = messageSigningBytes(m);
      expect(bytes[0]).toBe(0x19);
      // what serde_json does with them: a raw control character is not valid JSON anywhere
      expect(() => JSON.parse(new TextDecoder().decode(bytes))).toThrow();
    }
    const payloads: TransactionPayload[] = [
      { type: "transfer", from: pub, to: otherPub, amount: 1, fee: 1, token: "XRGE", timestamp: 1, nonce: "n" },
      { type: "contract_call", from: pub, contractAddr: "ab", method: "m", args: [ch(0x19) + "RougeChain Signed Message:\n"], timestamp: 1, nonce: "n" },
      { type: "nft_mint", from: pub, name: ch(0x19), timestamp: 1, nonce: ch(0x19) },
    ];
    for (const p of payloads) {
      const bytes = serializePayload(p);
      expect(bytes[0]).toBe(0x7b);
      expect(Array.from(bytes).includes(0x19)).toBe(false); // JSON escapes control characters
    }
    // JSON whitespace is the only thing a JSON document may start with besides a value
    for (const first of [0x19, 0x00, 0x1f]) expect(() => JSON.parse(ch(first) + "{}")).toThrow();
  });

  it("a message signature does not verify as a transaction, even for the same text", () => {
    const tx = createSignedTransfer(pub, priv, otherPub, 5);
    const json = new TextDecoder().decode(serializePayload(tx.payload));
    // sign the transaction's exact JSON as a MESSAGE (what a wallet would do if tricked)
    const msgSig = signMessage(priv, json);
    expect(verifyMessage(pub, json, msgSig)).toBe(true);
    expect(verifyTransaction({ ...tx, signature: msgSig })).toBe(false);
    expect(ml_dsa65.verify(unhex(msgSig), serializePayload(tx.payload), kp.publicKey)).toBe(false);
  });

  it("a transaction signature does not verify as a message", () => {
    const tx = signTransaction({ type: "transfer", from: pub, to: otherPub, amount: 5, fee: 1, token: "XRGE", timestamp: 1, nonce: "n" }, priv, pub);
    const json = new TextDecoder().decode(serializePayload(tx.payload));
    expect(verifyTransaction(tx)).toBe(true);
    expect(verifyMessage(pub, json, tx.signature)).toBe(false);
    expect(verifyMessage(pub, serializePayload(tx.payload), tx.signature)).toBe(false);
  });
});

describe("sign-in message", () => {
  let address = "";
  const base = (): SignInFields => ({
    domain: "tickets.example.com",
    address,
    uri: "https://tickets.example.com/login",
    statement: "Sign in to see your tickets.",
    nonce: "4f9c2d1e8a7b6c5d",
    issuedAt: "2026-10-06T12:00:00.000Z",
    expirationTime: "2026-10-06T12:10:00.000Z",
    chainId: "rougechain-mainnet-1",
    resources: ["https://tickets.example.com/events/42", "rouge:token:TICKET"],
  });
  const NOW = Date.parse("2026-10-06T12:01:00.000Z");

  it("setup: address of the test key", async () => {
    address = await pubkeyToAddress(pub);
    expect(address.startsWith("rouge1")).toBe(true);
  });

  it("has the canonical text, with a fixed first line", () => {
    expect(createSignInMessage(base())).toBe([
      "tickets.example.com wants you to sign in with your RougeChain account:",
      address,
      "",
      "Sign in to see your tickets.",
      "",
      "URI: https://tickets.example.com/login",
      "Version: 1",
      "Chain ID: rougechain-mainnet-1",
      "Nonce: 4f9c2d1e8a7b6c5d",
      "Issued At: 2026-10-06T12:00:00.000Z",
      "Expiration Time: 2026-10-06T12:10:00.000Z",
      "Resources:",
      "- https://tickets.example.com/events/42",
      "- rouge:token:TICKET",
    ].join("\n"));
    const minimal = createSignInMessage({ domain: "localhost:5173", address, uri: "http://localhost:5173", nonce: "A".repeat(16), issuedAt: "2026-10-06T12:00:00Z", chainId: "rougechain-devnet-1" });
    expect(minimal).toBe(`localhost:5173 wants you to sign in with your RougeChain account:\n${address}\n\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: rougechain-devnet-1\nNonce: AAAAAAAAAAAAAAAA\nIssued At: 2026-10-06T12:00:00Z`);
  });

  it("parse(create(fields)) === fields for every optional-field combination", () => {
    for (const statement of [undefined, "Hello there."]) {
      for (const expirationTime of [undefined, "2026-10-06T12:10:00.000Z"]) {
        for (const resources of [undefined, [], ["https://a.example/x"]]) {
          const f: SignInFields = { ...base(), statement, expirationTime, resources };
          for (const k of Object.keys(f) as (keyof SignInFields)[]) if (f[k] === undefined) delete f[k];
          expect(parseSignInMessage(createSignInMessage(f))).toEqual(f);
        }
      }
    }
  });

  it("create refuses every invalid field", () => {
    const bad: [Partial<SignInFields>, RegExp][] = [
      [{ domain: "" }, /domain/],
      [{ domain: "https://tickets.example.com" }, /domain/],
      [{ domain: "tickets.example.com/path" }, /domain/],
      [{ domain: "tickets.example.com\nevil.example" }, /domain/],
      [{ domain: "tickets example.com" }, /domain/],
      [{ address: "rouge1notanaddress" }, /address/],
      [{ address: pub }, /address/],
      [{ address: address.toUpperCase() }, /address/],
      [{ uri: "" }, /uri/],
      [{ uri: "https://a.example/ x" }, /uri/],
      [{ uri: "https://a.example/\nNonce: x" }, /uri/],
      [{ statement: "" }, /statement/],
      [{ statement: "two\nlines" }, /statement/],
      [{ statement: " padded " }, /statement/],
      [{ statement: "hidden" + ch(0x202e) + "text" }, /statement/],
      [{ nonce: "short" }, /nonce/],
      [{ nonce: "a".repeat(15) }, /nonce/],
      [{ nonce: "has space 0123456789" }, /nonce/],
      [{ nonce: "a".repeat(129) }, /nonce/],
      [{ issuedAt: "yesterday" }, /issuedAt/],
      [{ issuedAt: "2026-10-06T12:00:00" }, /issuedAt/],
      [{ issuedAt: "2026-13-40T12:00:00Z" }, /issuedAt/],
      [{ expirationTime: "soon" }, /expirationTime/],
      [{ chainId: "" }, /chainId/],
      [{ chainId: "main net" }, /chainId/],
      [{ resources: ["has space"] }, /resource/],
      [{ resources: "x" as unknown as string[] }, /resources/],
    ];
    for (const [patch, re] of bad) {
      expect(() => createSignInMessage({ ...base(), ...patch }), JSON.stringify(patch)).toThrow(re);
    }
    expect(() => createSignInMessage(null as unknown as SignInFields)).toThrow();
  });

  it("parse refuses anything that is not the canonical text", () => {
    const good = createSignInMessage(base());
    expect(parseSignInMessage(good)).not.toBeNull();
    const variants = [
      good + "\n",
      " " + good,
      good.replace(/\n/g, "\r\n"),
      good.replace("Version: 1", "Version: 2"),
      good.replace("Nonce: ", "Nonce:  "),
      good.replace("Nonce: 4f9c2d1e8a7b6c5d", "Nonce: short"),
      good.replace("URI: ", "Uri: "),
      good.replace("Chain ID: rougechain-mainnet-1\nNonce: 4f9c2d1e8a7b6c5d", "Nonce: 4f9c2d1e8a7b6c5d\nChain ID: rougechain-mainnet-1"),
      good.replace(" wants you to sign in with your RougeChain account:", " wants you to sign in with your Ethereum account:"),
      good.replace(address, address.toUpperCase()),
      good.replace(address, "rouge1qqqqqqqq"),
      good + "\n- https://extra.example\nNonce: 0000000000000000",
      good + "\nRequest ID: 1",
      good.replace("Sign in to see your tickets.", "Sign in.\nSecond statement line"),
      "hello",
      "",
    ];
    for (const v of variants) expect(parseSignInMessage(v), JSON.stringify(v.slice(0, 80))).toBeNull();
    for (const v of [undefined, null, 5, {}]) expect(parseSignInMessage(v as unknown as string)).toBeNull();
  });

  it("claimedSignInDomain reads the first line even when the rest is not canonical", () => {
    expect(claimedSignInDomain(createSignInMessage(base()))).toBe("tickets.example.com");
    expect(claimedSignInDomain("evil.example wants you to sign in with your RougeChain account:\nwhatever")).toBe("evil.example");
    expect(claimedSignInDomain("evil.example wants you to sign in with your RougeChain account:\r\nx")).toBe("evil.example");
    expect(claimedSignInDomain("hello")).toBeNull();
  });

  describe("verifySignIn", () => {
    const expected = { expectedDomain: "tickets.example.com", expectedNonce: "4f9c2d1e8a7b6c5d", expectedChainId: "rougechain-mainnet-1", now: NOW };
    const signed = (fields: SignInFields, key = priv) => {
      const message = createSignInMessage(fields);
      return { message, signature: signMessage(key, message), publicKey: pub };
    };

    it("accepts a correct sign-in", async () => {
      const res = await verifySignIn({ ...signed(base()), ...expected });
      expect(res).toEqual({ valid: true, address, publicKey: pub, fields: base() });
      // domain comparison is case-insensitive; now may be a Date
      expect((await verifySignIn({ ...signed(base()), ...expected, expectedDomain: "Tickets.Example.com", now: new Date(NOW) })).valid).toBe(true);
    });

    it("refuses a message that is not a sign-in message", async () => {
      const s = { message: "I agree to the terms", signature: signMessage(priv, "I agree to the terms"), publicKey: pub };
      expect(await verifySignIn({ ...s, ...expected })).toEqual({ valid: false, error: "malformed_message" });
    });

    it("refuses an invalid signature, and a signature over a different text", async () => {
      const s = signed(base());
      expect(await verifySignIn({ ...s, signature: "00", ...expected })).toEqual({ valid: false, error: "invalid_signature" });
      const tampered = s.message.replace("events/42", "events/43");
      expect(parseSignInMessage(tampered)).not.toBeNull();
      expect(await verifySignIn({ ...s, message: tampered, ...expected })).toEqual({ valid: false, error: "invalid_signature" });
      expect(await verifySignIn({ ...s, publicKey: otherPub, ...expected })).toEqual({ valid: false, error: "invalid_signature" });
    });

    it("refuses a transaction signature presented as a sign-in", async () => {
      const s = signed(base());
      const txSig = hex(ml_dsa65.sign(new TextEncoder().encode(s.message), kp.secretKey)); // bare bytes, no prefix
      expect(await verifySignIn({ ...s, signature: txSig, ...expected })).toEqual({ valid: false, error: "invalid_signature" });
    });

    it("refuses when the address in the message is not the signer's", async () => {
      // the OTHER key signs a message naming THIS key's address
      const message = createSignInMessage(base());
      const res = await verifySignIn({ message, signature: signMessage(otherPriv, message), publicKey: otherPub, ...expected });
      expect(res).toEqual({ valid: false, error: "address_mismatch" });
    });

    it("refuses another domain", async () => {
      const s = signed({ ...base(), domain: "evil.example" });
      expect(await verifySignIn({ ...s, ...expected })).toEqual({ valid: false, error: "domain_mismatch" });
      expect(await verifySignIn({ ...signed(base()), ...expected, expectedDomain: "" })).toEqual({ valid: false, error: "domain_mismatch" });
      expect(await verifySignIn({ ...signed(base()), ...expected, expectedDomain: "tickets.example.com:8443" })).toEqual({ valid: false, error: "domain_mismatch" });
    });

    it("refuses another nonce", async () => {
      expect(await verifySignIn({ ...signed(base()), ...expected, expectedNonce: "ffffffffffffffff" })).toEqual({ valid: false, error: "nonce_mismatch" });
      expect(await verifySignIn({ ...signed(base()), ...expected, expectedNonce: undefined as unknown as string })).toEqual({ valid: false, error: "nonce_mismatch" });
    });

    it("refuses another chain id", async () => {
      expect(await verifySignIn({ ...signed(base()), ...expected, expectedChainId: "rougechain-devnet-1" })).toEqual({ valid: false, error: "chain_id_mismatch" });
    });

    it("refuses issuedAt in the future beyond the skew, accepts it within", async () => {
      const s = signed(base());
      const issued = Date.parse("2026-10-06T12:00:00.000Z");
      expect(await verifySignIn({ ...s, ...expected, now: issued - 61_000 })).toEqual({ valid: false, error: "issued_in_future" });
      expect((await verifySignIn({ ...s, ...expected, now: issued - 59_000 })).valid).toBe(true);
      expect(await verifySignIn({ ...s, ...expected, now: issued - 59_000, maxClockSkewMs: 0 })).toEqual({ valid: false, error: "issued_in_future" });
    });

    it("refuses an expired message (at and after the expiration time)", async () => {
      const s = signed(base());
      const exp = Date.parse("2026-10-06T12:10:00.000Z");
      expect((await verifySignIn({ ...s, ...expected, now: exp - 1 })).valid).toBe(true);
      expect(await verifySignIn({ ...s, ...expected, now: exp })).toEqual({ valid: false, error: "expired" });
      expect(await verifySignIn({ ...s, ...expected, now: exp + 86_400_000 })).toEqual({ valid: false, error: "expired" });
    });

    it("maxAgeMs bounds a message without an expiry", async () => {
      const f = base();
      delete f.expirationTime;
      const s = signed(f);
      const issued = Date.parse(f.issuedAt);
      expect((await verifySignIn({ ...s, ...expected, now: issued + 365 * 86_400_000 })).valid).toBe(true);
      expect(await verifySignIn({ ...s, ...expected, now: issued + 600_001, maxAgeMs: 600_000 })).toEqual({ valid: false, error: "too_old" });
      expect((await verifySignIn({ ...s, ...expected, now: issued + 600_000, maxAgeMs: 600_000 })).valid).toBe(true);
    });

    it("never rejects or throws on garbage", async () => {
      for (const g of [undefined, null, 5, "x", {}, { message: 5 }, { message: "x", signature: {}, publicKey: [] }]) {
        const res = await verifySignIn(g as never);
        expect(res.valid).toBe(false);
      }
      expect(await verifySignIn({ ...signed(base()), ...expected, now: NaN })).toEqual({ valid: false, error: "malformed_message" });
    });
  });

  describe("what a wallet checks and shows (reviewSignMessageRequest)", () => {
    const ORIGIN = "https://tickets.example.com";
    const ok = (r: ReturnType<typeof reviewSignMessageRequest>): SignMessageReview => {
      if ("error" in r) throw new Error(r.error);
      return r;
    };

    it("refuses non-strings, empty, oversized and ill-formed messages", () => {
      for (const m of [undefined, null, 5, {}, ["a"]]) expect(reviewSignMessageRequest(m, ORIGIN)).toEqual({ error: "signMessage requires { message: string }" });
      expect(reviewSignMessageRequest("", ORIGIN)).toHaveProperty("error");
      expect(reviewSignMessageRequest("a" + ch(0xd800), ORIGIN)).toEqual({ error: "message is not well-formed Unicode" });
      expect("error" in reviewSignMessageRequest("a".repeat(MAX_SIGN_MESSAGE_BYTES), ORIGIN)).toBe(false);
      expect(reviewSignMessageRequest("a".repeat(MAX_SIGN_MESSAGE_BYTES + 1), ORIGIN)).toEqual({ error: "message is too long (4097 bytes; the limit is 4096)" });
      // the cap is in BYTES: 2,049 two-byte characters are 4,098 bytes
      expect(reviewSignMessageRequest(ch(0xe9).repeat(2049), ORIGIN)).toHaveProperty("error");
    });

    it("refuses anything that looks like a transaction payload or a signed request", () => {
      const txLike = [
        '{"type":"transfer","to":"x","amount":1}',
        '  {"tx_type":"stake","payload":{}}\n',
        ch(0xfeff) + '{"type":"transfer"}',
        '{"from":"abc","timestamp":1,"nonce":"n"}',
        JSON.stringify({ type: "contract_call", contractAddr: "ab", method: "m" }, null, 2),
        new TextDecoder().decode(serializePayload({ type: "transfer", from: "aa", to: "bb", amount: 1, timestamp: 1, nonce: "n" })),
      ];
      for (const m of txLike) {
        expect(looksLikeTransactionPayload(m), m.slice(0, 40)).toBe(true);
        expect(reviewSignMessageRequest(m, ORIGIN)).toEqual({ error: SIGN_MESSAGE_USE_SIGN_TRANSACTION_ERROR });
      }
      expect(SIGN_MESSAGE_USE_SIGN_TRANSACTION_ERROR).toContain("signTransaction");
      for (const m of ["hello", '{"hello":"world"}', "[1,2]", '"type"', "type: transfer", '{"type":', "{}"]) {
        expect(looksLikeTransactionPayload(m), m).toBe(false);
        expect("error" in reviewSignMessageRequest(m, ORIGIN)).toBe(false);
      }
    });

    it("a plain message: full text, byte and line counts, no sign-in view", () => {
      const r = ok(reviewSignMessageRequest("line one\nline two\n\nline four", ORIGIN, address));
      expect(r).toMatchObject({ message: "line one\nline two\n\nline four", display: "line one\nline two\n\nline four", byteLength: 28, lineCount: 4, originHost: "tickets.example.com", signIn: null, signInMalformed: false, domainMismatch: false, addressMismatch: false, expired: false, claimedDomain: null });
    });

    it("renders control and invisible characters visibly, removing nothing", () => {
      const raw = "a" + ch(0x0d) + "b" + ch(0x09) + "c" + ch(0x1b) + "[2Kd" + ch(0x00) + ch(0x7f) + ch(0x202e) + "e" + ch(0x200b) + ch(0x2028) + ch(0xfeff) + ch(0x85) + "\nend";
      const shown = visibleMessageText(raw);
      expect(shown).toBe(
        "a" + ch(0x240d) + "b" + ch(0x2409) + "c" + ch(0x241b) + "[2Kd" + ch(0x2400) + ch(0x2421)
        + ch(0x27e8) + "U+202E" + ch(0x27e9) + "e" + ch(0x27e8) + "U+200B" + ch(0x27e9) + ch(0x27e8) + "U+2028" + ch(0x27e9)
        + ch(0x27e8) + "U+FEFF" + ch(0x27e9) + ch(0x27e8) + "U+0085" + ch(0x27e9) + "\nend",
      );
      // no raw control / bidi / zero-width character survives, and only real LFs break lines
      expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(shown)).toBe(false);
      for (const c of [0x202e, 0x200b, 0x2028, 0xfeff]) expect(shown.includes(ch(c))).toBe(false);
      expect(shown.split("\n")).toHaveLength(2);
      // ordinary text, accents, CJK and emoji are untouched
      const plain = "Caf" + ch(0xe9) + " " + ch(0x65e5) + ch(0x672c) + " " + String.fromCodePoint(0x1f600);
      expect(visibleMessageText(plain)).toBe(plain);
      expect(ok(reviewSignMessageRequest(raw, ORIGIN)).display).toBe(shown);
    });

    it("a sign-in for the requesting site: structured fields, no warning", () => {
      const r = ok(reviewSignMessageRequest(createSignInMessage(base()), ORIGIN, address, NOW));
      expect(r.signIn).toEqual(base());
      expect(r).toMatchObject({ domainMismatch: false, addressMismatch: false, expired: false, signInMalformed: false, claimedDomain: "tickets.example.com" });
    });

    it("warns when the message's domain is not the requesting site", () => {
      const msg = createSignInMessage(base());
      for (const origin of ["https://evil.example", "https://tickets.example.com.evil.example", "https://tickets.example.com:8443", "https://sub.tickets.example.com", "not a url"]) {
        expect(ok(reviewSignMessageRequest(msg, origin, address, NOW)).domainMismatch, origin).toBe(true);
      }
      expect(ok(reviewSignMessageRequest(msg, "https://TICKETS.example.com", address, NOW)).domainMismatch).toBe(false);
      // a port in the origin must be in the message's domain
      const local = createSignInMessage({ ...base(), domain: "localhost:5173" });
      expect(ok(reviewSignMessageRequest(local, "http://localhost:5173", address, NOW)).domainMismatch).toBe(false);
      expect(ok(reviewSignMessageRequest(local, "http://localhost:3000", address, NOW)).domainMismatch).toBe(true);
    });

    it("warns on a sign-in-looking message that is not canonical, still comparing its claimed domain", () => {
      const sloppy = "evil.example wants you to sign in with your RougeChain account:\n" + address + "\n\nNonce: 1";
      const r = ok(reviewSignMessageRequest(sloppy, ORIGIN, address, NOW));
      expect(r).toMatchObject({ signIn: null, signInMalformed: true, claimedDomain: "evil.example", domainMismatch: true });
      const sameSite = sloppy.replace("evil.example", "tickets.example.com");
      expect(ok(reviewSignMessageRequest(sameSite, ORIGIN, address, NOW))).toMatchObject({ signInMalformed: true, domainMismatch: false });
    });

    it("warns when the sign-in names another wallet's address, or has expired", async () => {
      const msg = createSignInMessage(base());
      const otherAddress = await pubkeyToAddress(otherPub);
      expect(ok(reviewSignMessageRequest(msg, ORIGIN, otherAddress, NOW)).addressMismatch).toBe(true);
      expect(ok(reviewSignMessageRequest(msg, ORIGIN, address, NOW)).addressMismatch).toBe(false);
      expect(ok(reviewSignMessageRequest(msg, ORIGIN, address, Date.parse("2026-10-06T12:10:00.000Z"))).expired).toBe(true);
    });
  });
});

describe("core and SDK carry the same implementation", () => {
  it("packages/core/src/message-signing.ts and sdk/src/message-signing.ts differ only in the import path", () => {
    const core = repo("packages/core/src/message-signing.ts");
    const sdk = repo("sdk/src/message-signing.ts");
    expect(sdk).toBe(core.replace('from "./address";', 'from "./address.js";'));
  });

  it("the SDK and core vector files are identical", () => {
    expect(repo("sdk/test/fixtures/sign-message-vector.json")).toBe(repo("packages/core/test/fixtures/sign-message-vector.json"));
  });
});
