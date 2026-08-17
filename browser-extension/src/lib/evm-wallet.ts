/**
 * EVM (Base) account support for the RougeChain wallet.
 *
 * One seed, two chains: the EVM account is derived from the SAME BIP-39 mnemonic
 * that backs the RougeChain PQC wallet, using the standard Ethereum path
 * m/44'/60'/0'/0/0. So a single recovery phrase controls both the RougeChain
 * (ML-DSA-65) address and the Base (secp256k1) address — no separate key to manage.
 *
 * Signing (EIP-1559 type-2 transactions + EIP-191 personal_sign) is done with the
 * audited micro-eth-signer library — never hand-rolled RLP/signing.
 *
 * A wallet imported from raw keys (no mnemonic) has NO EVM account; callers should
 * surface EIP-1193 error 4100 in that case.
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { addr, Transaction, eip191Signer } from "micro-eth-signer";

export const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface EvmAccount {
    /** EIP-55 checksummed address (0x…). */
    address: string;
    /** 0x-prefixed private key hex. Never leaves the service worker. */
    privateKey: string;
}

function toHexKey(bytes: Uint8Array): string {
    return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive the Base/EVM account from a BIP-39 mnemonic.
 * Returns null when the mnemonic is missing or invalid (e.g. raw-key wallets).
 */
export function deriveEvmAccount(
    mnemonic: string | undefined | null,
    passphrase?: string,
): EvmAccount | null {
    if (!mnemonic || !validateMnemonic(mnemonic.trim(), wordlist)) return null;
    const seed = mnemonicToSeedSync(mnemonic.trim(), passphrase);
    const hd = HDKey.fromMasterSeed(seed).derive(ETH_DERIVATION_PATH);
    if (!hd.privateKey) return null;
    const privateKey = toHexKey(hd.privateKey);
    return { address: addr.fromPrivateKey(privateKey), privateKey };
}

export interface Eip1559Fields {
    chainId: number;
    nonce: number | bigint;
    to: string;
    value?: bigint;
    /** Calldata, 0x-hex. Defaults to "0x". */
    data?: string;
    gasLimit: number | bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}

/**
 * Sign an EIP-1559 (type-2) transaction.
 * Returns the raw 0x… hex ready for eth_sendRawTransaction.
 */
export function signEip1559(privateKey: string, f: Eip1559Fields): string {
    const tx = Transaction.prepare({
        type: "eip1559",
        chainId: BigInt(f.chainId),
        nonce: BigInt(f.nonce),
        to: f.to,
        value: f.value ?? 0n,
        data: f.data ?? "0x",
        gasLimit: BigInt(f.gasLimit),
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    });
    return tx.signBy(privateKey).toHex();
}

/**
 * EIP-191 personal_sign. `message` may be raw bytes or a UTF-8 string.
 * The EIP-1193 `personal_sign` param is a hex-encoded byte string — decode it to
 * bytes with {@link hexToBytes} before calling so the signed digest matches what
 * dApps/relayers expect. Returns a 0x… 65-byte signature.
 */
export function personalSign(privateKey: string, message: string | Uint8Array): string {
    return eip191Signer.sign(message, privateKey);
}

/** Decode a 0x-hex string to bytes (for personal_sign message params). */
export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/**
 * Best-effort UTF-8 preview of a personal_sign payload for the approval UI.
 * Falls back to the original hex when the bytes aren't printable text.
 */
export function decodeSignMessage(hexOrText: string): string {
    try {
        if (!hexOrText.startsWith("0x")) return hexOrText;
        const bytes = hexToBytes(hexOrText);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        // eslint-disable-next-line no-control-regex
        if (/^[\x09\x0A\x0D\x20-\x7E -￿]*$/.test(text)) return text;
        return hexOrText;
    } catch {
        return hexOrText;
    }
}
