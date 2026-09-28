/**
 * Contract transaction helpers for the dApp signing path.
 *
 * dApps ask the extension to sign `contract_call` / `contract_deploy` payloads (node GAME_READY:
 * POST /api/v2/contract/execute and /api/v2/contract/publish). This module validates those
 * payloads and derives what the approval popup shows: method, args, gas limit and max fee for a
 * call; WASM size, predicted address and fee for a deployment.
 */

import { sha256 } from "@noble/hashes/sha2.js";

export const CONTRACT_MAX_GAS = 10_000_000;
export const CONTRACT_GAS_PRICE_XRGE = 0.000001;
export const CONTRACT_DEPLOY_FEE_XRGE = 10;
/** Longest pretty-printed args string handed to the popup. */
export const ARGS_DISPLAY_LIMIT = 8_000;

export type ContractTxType = "contract_call" | "contract_deploy";

export interface ContractCallDetails {
    kind: "contract_call";
    contractAddr: string;
    method: string;
    argsPretty: string;
    argsTruncated: boolean;
    argsBytes: number;
    gasLimit: number;
    /** True when the payload has no gasLimit and the node default (10M) applies. */
    gasLimitDefaulted: boolean;
    maxFeeXrge: number;
}

export interface ContractDeployDetails {
    kind: "contract_deploy";
    wasmSize: number;
    codeHash: string;
    nonce: string;
    predictedAddress: string;
    feeXrge: number;
}

export type ContractTxDetails = ContractCallDetails | ContractDeployDetails;

export function isContractTxType(t: unknown): t is ContractTxType {
    return t === "contract_call" || t === "contract_deploy";
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Strict standard-base64 decode (the node uses base64 STANDARD with padding). */
export function base64ToBytes(b64: string): Uint8Array {
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error("wasm must be standard base64");
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const out = new Uint8Array((b64.length / 4) * 3 - pad);
    let o = 0;
    for (let i = 0; i < b64.length; i += 4) {
        const n = (B64.indexOf(b64[i]) << 18) | (B64.indexOf(b64[i + 1]) << 12)
            | ((b64[i + 2] === "=" ? 0 : B64.indexOf(b64[i + 2])) << 6)
            | (b64[i + 3] === "=" ? 0 : B64.indexOf(b64[i + 3]));
        if (o < out.length) out[o++] = (n >> 16) & 255;
        if (o < out.length) out[o++] = (n >> 8) & 255;
        if (o < out.length) out[o++] = n & 255;
    }
    return out;
}

/** Same derivation as the node's `v2_binding::contract_address_v2`. */
export function predictContractAddress(from: string, nonce: string, wasm: Uint8Array): string {
    const enc = new TextEncoder();
    const parts = [enc.encode("rougechain/contract/v2"), enc.encode(from), new Uint8Array([0]),
        enc.encode(nonce), new Uint8Array([0]), sha256(wasm)];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return toHex(sha256(buf).slice(0, 20));
}

/**
 * Validate a contract payload and derive the approval details. `signer` is the wallet's signing
 * key; the payload's `from` (when present) must equal it — the node rejects anything else.
 */
export function analyzeContractPayload(
    payload: Record<string, unknown>,
    signer: string,
): { details: ContractTxDetails } | { error: string } {
    const from = payload.from;
    if (from !== undefined && from !== signer) {
        return { error: "payload.from is not this wallet's signing key" };
    }
    if (payload.type === "contract_call") {
        const contractAddr = payload.contractAddr;
        const method = payload.method;
        if (typeof contractAddr !== "string" || !contractAddr) return { error: "contract_call needs contractAddr" };
        if (typeof method !== "string" || !method) return { error: "contract_call needs method" };
        const g = payload.gasLimit;
        if (g !== undefined && (typeof g !== "number" || !Number.isInteger(g) || g < 1 || g > CONTRACT_MAX_GAS)) {
            return { error: `gasLimit must be an integer between 1 and ${CONTRACT_MAX_GAS}` };
        }
        const gasLimit = typeof g === "number" ? g : CONTRACT_MAX_GAS;
        const args = payload.args === undefined ? null : payload.args;
        let pretty: string;
        try { pretty = args === null ? "{}" : JSON.stringify(args, null, 2); } catch { return { error: "args must be JSON" }; }
        const argsBytes = new TextEncoder().encode(JSON.stringify(args ?? {})).length;
        const argsTruncated = pretty.length > ARGS_DISPLAY_LIMIT;
        return {
            details: {
                kind: "contract_call",
                contractAddr,
                method,
                argsPretty: argsTruncated ? pretty.slice(0, ARGS_DISPLAY_LIMIT) : pretty,
                argsTruncated,
                argsBytes,
                gasLimit,
                gasLimitDefaulted: g === undefined,
                maxFeeXrge: gasLimit * CONTRACT_GAS_PRICE_XRGE,
            },
        };
    }
    if (payload.type === "contract_deploy") {
        if (typeof payload.wasm !== "string" || !payload.wasm) return { error: "contract_deploy needs wasm (base64)" };
        const nonce = payload.nonce;
        if (typeof nonce !== "string" || nonce.length < 8) return { error: "contract_deploy needs a nonce of at least 8 characters" };
        let wasm: Uint8Array;
        try { wasm = base64ToBytes(payload.wasm); } catch (e) { return { error: (e as Error).message }; }
        if (wasm.length === 0) return { error: "wasm is empty" };
        return {
            details: {
                kind: "contract_deploy",
                wasmSize: wasm.length,
                codeHash: toHex(sha256(wasm)),
                nonce,
                predictedAddress: predictContractAddress(signer, nonce, wasm),
                feeXrge: CONTRACT_DEPLOY_FEE_XRGE,
            },
        };
    }
    return { error: "not a contract transaction" };
}

/** Copy of the payload that is safe to park in session storage for the popup (no raw WASM). */
export function payloadForDisplay(payload: Record<string, unknown>, details?: ContractTxDetails): Record<string, unknown> {
    if (details?.kind === "contract_deploy") {
        return { ...payload, wasm: `<${details.wasmSize} bytes of WASM, sha256 ${details.codeHash.slice(0, 16)}…>` };
    }
    return payload;
}

export function contractEndpoint(t: ContractTxType): string {
    return t === "contract_call" ? "/v2/contract/execute" : "/v2/contract/publish";
}
