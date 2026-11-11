/** signShieldV2Bytes signs only a shield_v2 envelope from the wallet's own key. */
import { describe, expect, it } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { signShieldV2Bytes } from "../src/pqc-signer";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = ml_dsa65.keygen(new Uint8Array(32).fill(7));
const pub = hex(kp.publicKey);
const priv = hex(kp.secretKey);
const enc = (s: string) => hex(new TextEncoder().encode(s));

// The shape serde_json gives encode_tx_for_signing for a shield_v2 envelope (fee 0.0, nonce 0).
function envelope(over: { tx_type?: string; from?: string; nonce?: number; fee?: string; extra?: string; payloadExtra?: string } = {}) {
  const body = "ab".repeat(2546);
  return `{"version":1,"tx_type":"${over.tx_type ?? "shield_v2"}","from_pub_key":"${over.from ?? pub}","nonce":${over.nonce ?? 0},"payload":{"to_pub_key_hex":null,"amount":null,"faucet":null${over.payloadExtra ?? ""},"shield_v2_body":"${body}","shield_v2_proof":"cdef"},"fee":${over.fee ?? "0.0"}${over.extra ?? ""}}`;
}

describe("signShieldV2Bytes", () => {
  it("signs a shield_v2 envelope from its own key", () => {
    const bytes = enc(envelope());
    const sig = signShieldV2Bytes(bytes, priv, pub);
    expect(ml_dsa65.verify(Buffer.from(sig, "hex"), Buffer.from(bytes, "hex"), kp.publicKey)).toBe(true);
  });
  it("refuses any other transaction type", () => {
    expect(() => signShieldV2Bytes(enc(envelope({ tx_type: "transfer" })), priv, pub)).toThrow();
  });
  it("accepts the account nonce", () => {
    expect(() => signShieldV2Bytes(enc(envelope({ nonce: 5 })), priv, pub)).not.toThrow();
  });
  it("refuses another key, a bad nonce, a fee, or a value-moving field", () => {
    expect(() => signShieldV2Bytes(enc(envelope({ from: "00".repeat(1952) })), priv, pub)).toThrow();
    expect(() => signShieldV2Bytes(enc(envelope({ nonce: -1 })), priv, pub)).toThrow();
    expect(() => signShieldV2Bytes(enc(envelope({ fee: "1.0" })), priv, pub)).toThrow();
    expect(() => signShieldV2Bytes(enc(envelope({ payloadExtra: ',"to":"rouge1x"' })), priv, pub)).toThrow();
    expect(() => signShieldV2Bytes(enc(envelope({ extra: ',"chain_id":"x"' })), priv, pub)).toThrow();
  });
  it("refuses non-JSON and domain-tagged bytes", () => {
    expect(() => signShieldV2Bytes("deadbeef", priv, pub)).toThrow();
    expect(() => signShieldV2Bytes(enc("rougechain/tx-v1/chain") + "00" + enc(envelope()), priv, pub)).toThrow();
  });
});
