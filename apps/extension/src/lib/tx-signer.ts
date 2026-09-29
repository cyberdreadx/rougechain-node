// Shared v2 transaction signer for the extension.
//
// Every state-changing v2 request is ML-DSA-65 signed over canonical (deep key-sorted) JSON.
// For value-moving paths the node ALSO enforces a durable account nonce: the signed payload must
// carry `account_nonce` equal to the account's next nonce. A captured signed tx therefore cannot be
// replayed once the account advances — independent of the timestamp/replay window. Fetching the
// nonce at sign time and signing it is what lets the node eventually make the field mandatory.
//
// Non-breaking today: paths the node does not gate simply ignore the extra field.

import { bytesToHex, hexToBytes } from "./pqc-blockchain";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";

export function sortKeysDeep(obj: any): any {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (obj && typeof obj === "object") {
        const sorted: Record<string, any> = {};
        for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
        return sorted;
    }
    return obj;
}

// GET the account's next nonce. Returns the value to sign into `account_nonce`.
// Throws on a failed/garbled response so callers fail closed rather than signing a wrong nonce
// (the node treats a present-but-wrong nonce as a hard error — never coerce it to 0).
export async function fetchNextNonce(publicKey: string, baseUrl?: string): Promise<number> {
    const base = baseUrl || getCoreApiBaseUrl();
    if (!base) throw new Error("No node configured");
    const res = await fetch(`${base}/account/${publicKey}/nonce`, {
        headers: { ...getCoreApiHeaders() },
    });
    const data = await res.json().catch(() => null);
    if (!data || data.success === false || typeof data.next_nonce !== "number") {
        throw new Error("Could not fetch account nonce");
    }
    return data.next_nonce;
}

export interface SignedV2Body {
    payload: Record<string, any>;
    signature: string;
    public_key: string;
}

// Build a canonical signed body. When `withNonce` is set the account nonce is fetched and included.
export async function buildSignedV2(
    wallet: { signingPublicKey: string; signingPrivateKey: string },
    partialPayload: Record<string, any>,
    opts: { withNonce?: boolean; baseUrl?: string } = {}
): Promise<SignedV2Body> {
    const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
    const payload: Record<string, any> = {
        ...partialPayload,
        from: partialPayload.from ?? wallet.signingPublicKey,
        timestamp: partialPayload.timestamp ?? Date.now(),
        nonce: partialPayload.nonce ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    };
    if (opts.withNonce) {
        payload.account_nonce = await fetchNextNonce(wallet.signingPublicKey, opts.baseUrl);
    }
    const sorted = sortKeysDeep(payload);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(sorted));
    const signature = bytesToHex(ml_dsa65.sign(payloadBytes, hexToBytes(wallet.signingPrivateKey)));
    return { payload: sorted, signature, public_key: wallet.signingPublicKey };
}

// Sign (optionally with the durable account nonce) and POST to a v2 endpoint. Returns the parsed
// JSON; throws on { success: false }.
export async function signAndPostV2(
    wallet: { signingPublicKey: string; signingPrivateKey: string },
    endpoint: string,
    partialPayload: Record<string, any>,
    opts: { withNonce?: boolean } = {}
): Promise<any> {
    const base = getCoreApiBaseUrl();
    if (!base) throw new Error("No node configured");
    const body = await buildSignedV2(wallet, partialPayload, { withNonce: opts.withNonce, baseUrl: base });
    const res = await fetch(`${base}${endpoint}`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) throw new Error(data.error || "Request failed");
    return data;
}
