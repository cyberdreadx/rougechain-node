// signMessage / verifyMessage / Sign-In with RougeChain in the published build. The full refusal
// matrix and the domain-separation proof live in packages/core/test/message-signing.test.ts (the
// two source files are kept identical by that test); this checks the built package and the shared
// test vector. Run after `npm run build`: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Wallet,
  signMessage,
  verifyMessage,
  messageSigningBytes,
  createSignInMessage,
  parseSignInMessage,
  verifySignIn,
  reviewSignMessageRequest,
  signTransaction,
  verifyTransaction,
  serializePayload,
  pubkeyToAddress,
  bytesToHex,
  SIGNED_MESSAGE_PREFIX,
  MAX_SIGN_MESSAGE_BYTES,
} from "../dist/index.js";

const vector = JSON.parse(readFileSync(new URL("./fixtures/sign-message-vector.json", import.meta.url), "utf8"));
const wallet = Wallet.generate();
const other = Wallet.generate();

test("signed bytes: 0x19 prefix, decimal byte length, LF, message", () => {
  assert.equal(SIGNED_MESSAGE_PREFIX.charCodeAt(0), 0x19);
  assert.equal(new TextDecoder().decode(messageSigningBytes("hello")), "\x19RougeChain Signed Message:\n5\nhello");
  assert.equal(messageSigningBytes(new Uint8Array([9, 9]))[0], 0x19);
});

test("shared vector: signed bytes reproduced, recorded signature verifies", async () => {
  assert.equal(bytesToHex(messageSigningBytes(vector.message)), vector.signedBytesHex);
  assert.equal(verifyMessage(vector.publicKey, vector.message, vector.signature), true);
  assert.equal(verifyMessage(vector.publicKey, vector.message + "x", vector.signature), false);
  assert.equal(await pubkeyToAddress(vector.publicKey), vector.address);
});

test("signMessage / verifyMessage round trip; verifyMessage never throws", () => {
  const sig = signMessage(wallet.privateKey, "hello");
  assert.equal(verifyMessage(wallet.publicKey, "hello", sig), true);
  assert.equal(verifyMessage(wallet.publicKey, new TextEncoder().encode("hello"), sig), true);
  assert.equal(verifyMessage(other.publicKey, "hello", sig), false);
  assert.equal(verifyMessage(wallet.publicKey, "hello!", sig), false);
  for (const bad of [undefined, null, 1, {}, "", "zz", "00"]) {
    assert.equal(verifyMessage(bad, "hello", sig), false);
    assert.equal(verifyMessage(wallet.publicKey, "hello", bad), false);
  }
});

test("domain separation: message and transaction signatures are not interchangeable", () => {
  const payload = { type: "transfer", from: wallet.publicKey, to: other.publicKey, amount: 1, fee: 1, token: "XRGE", timestamp: 1, nonce: "n" };
  const tx = signTransaction(payload, wallet.privateKey, wallet.publicKey);
  const json = new TextDecoder().decode(serializePayload(payload));
  assert.equal(serializePayload(payload)[0], 0x7b);
  assert.equal(messageSigningBytes(json)[0], 0x19);
  assert.equal(verifyTransaction(tx), true);
  assert.equal(verifyMessage(wallet.publicKey, json, tx.signature), false);
  assert.equal(verifyTransaction({ ...tx, signature: signMessage(wallet.privateKey, json) }), false);
});

test("sign-in: create, parse, verify and every refusal", async () => {
  const address = await pubkeyToAddress(wallet.publicKey);
  const fields = {
    domain: "tickets.example.com", address, uri: "https://tickets.example.com/login",
    statement: "Sign in to see your tickets.", nonce: "4f9c2d1e8a7b6c5d",
    issuedAt: "2026-10-06T12:00:00.000Z", expirationTime: "2026-10-06T12:10:00.000Z", chainId: "rougechain-mainnet-1",
  };
  const message = createSignInMessage(fields);
  assert.equal(message.split("\n")[0], "tickets.example.com wants you to sign in with your RougeChain account:");
  assert.equal(message.split("\n")[1], address);
  assert.deepEqual(parseSignInMessage(message), fields);
  assert.equal(parseSignInMessage(message + "\n"), null);
  assert.throws(() => createSignInMessage({ ...fields, nonce: "short" }), /nonce/);

  const signature = signMessage(wallet.privateKey, message);
  const expected = { expectedDomain: "tickets.example.com", expectedNonce: fields.nonce, expectedChainId: "rougechain-mainnet-1", now: Date.parse("2026-10-06T12:01:00.000Z") };
  const base = { message, signature, publicKey: wallet.publicKey, ...expected };
  assert.deepEqual(await verifySignIn(base), { valid: true, address, publicKey: wallet.publicKey, fields });

  const refusals = [
    [{ message: "hello" }, "malformed_message"],
    [{ signature: "00" }, "invalid_signature"],
    [{ publicKey: other.publicKey }, "invalid_signature"],
    [{ expectedDomain: "evil.example" }, "domain_mismatch"],
    [{ expectedNonce: "0000000000000000" }, "nonce_mismatch"],
    [{ expectedChainId: "rougechain-devnet-1" }, "chain_id_mismatch"],
    [{ now: Date.parse("2026-10-06T11:58:00.000Z") }, "issued_in_future"],
    [{ now: Date.parse("2026-10-06T12:10:00.000Z") }, "expired"],
    [{ now: Date.parse("2026-10-06T12:09:00.000Z"), maxAgeMs: 60_000 }, "too_old"],
  ];
  for (const [patch, error] of refusals) {
    assert.deepEqual(await verifySignIn({ ...base, ...patch }), { valid: false, error }, error);
  }
  // signed by another key but naming this wallet's address
  const forged = signMessage(other.privateKey, message);
  assert.deepEqual(await verifySignIn({ ...base, signature: forged, publicKey: other.publicKey }), { valid: false, error: "address_mismatch" });
});

test("wallet-side review: cap, transaction-looking messages, domain warning", async () => {
  assert.equal(MAX_SIGN_MESSAGE_BYTES, 4096);
  assert.ok("error" in reviewSignMessageRequest("a".repeat(4097), "https://a.example"));
  assert.match(reviewSignMessageRequest('{"type":"transfer"}', "https://a.example").error, /signTransaction/);
  const r = reviewSignMessageRequest(vector.message, "https://evil.example", vector.address, 0);
  assert.equal(r.domainMismatch, true);
  assert.equal(r.signIn.domain, "tickets.example.com");
  assert.equal(reviewSignMessageRequest(vector.message, "https://tickets.example.com", vector.address, 0).domainMismatch, false);
});
