// dApp signTransaction request preparation (pure; used by the service worker, covered by tests).

import { analyzeContractPayload, isContractTxType, type ContractTxDetails } from "./contract-tx";
import { reviewPayloadChainId, type NetworkReview } from "./chain-binding";

export function sortKeysDeep(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (obj !== null && typeof obj === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return obj;
}

export function serializePayload(payload: Record<string, unknown>): string {
    return JSON.stringify(sortKeysDeep(payload));
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export type PreparedSignRequest = { payload: Record<string, unknown>; details?: ContractTxDetails; network: NetworkReview };

/**
 * Normalize a dApp signTransaction request. The site's `signViaExtension` sends
 * `{ payload, serializedHex }` (the exact bytes it will submit as `payload_bytes_hex`); other
 * dApps send the payload itself. For the envelope, the bytes must be the canonical serialization
 * of the payload (so the popup shows exactly what is signed) and the payload cannot be changed.
 * Contract payloads are validated and get approval details; outside the envelope, missing
 * from/timestamp/nonce are filled in and the filled payload is returned to the dApp.
 *
 * Network binding: a payload naming a `chainId` other than the wallet's selected network is
 * refused. Outside the envelope a missing `chainId` is filled in with the selected network's.
 * An envelope without `chainId` (older dApps; its bytes are fixed) is allowed for now and flagged
 * `network.missing`, which the approval screen shows as a warning.
 */
export function prepareSignRequest(
    raw: Record<string, unknown>,
    signer: string,
    selectedChainId: string,
): { error: string } | PreparedSignRequest {
    let payload = raw;
    const isEnvelope = raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        && typeof raw.serializedHex === "string";
    if (isEnvelope) {
        payload = raw.payload as Record<string, unknown>;
        const expected = bytesToHex(new TextEncoder().encode(serializePayload(payload)));
        if ((raw.serializedHex as string).toLowerCase() !== expected) {
            return { error: "serializedHex does not match the payload" };
        }
    }
    const review = reviewPayloadChainId(payload, selectedChainId);
    if ("error" in review) return { error: review.error };
    let network = review;
    if (!isEnvelope && review.missing) {
        payload = { ...payload, chainId: selectedChainId };
        network = { ...review, chainId: selectedChainId, name: review.selectedName, missing: false };
    }
    if (!isContractTxType(payload.type)) return { payload, network };
    if (!isEnvelope) {
        payload = {
            ...payload,
            from: payload.from ?? signer,
            timestamp: payload.timestamp ?? Date.now(),
            nonce: payload.nonce ?? crypto.randomUUID(),
        };
    }
    const analyzed = analyzeContractPayload(payload, signer);
    if ("error" in analyzed) return { error: analyzed.error };
    return { payload, details: analyzed.details, network };
}

/**
 * A payload the wallet itself completes and submits (`sendTransaction`): refuse a different
 * `chainId`, otherwise sign the selected network's.
 */
export function bindSendPayload(
    payload: Record<string, unknown>,
    selectedChainId: string,
): { error: string } | { payload: Record<string, unknown>; network: NetworkReview } {
    const review = reviewPayloadChainId(payload, selectedChainId);
    if ("error" in review) return { error: review.error };
    return {
        payload: { ...payload, chainId: selectedChainId },
        network: { ...review, chainId: selectedChainId, name: review.selectedName, missing: false },
    };
}
