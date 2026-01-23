import { hexToBytes, bytesToHex } from "./hash";

export interface PQKeypair {
  publicKeyHex: string;
  secretKeyHex: string;
  algorithm: "ML-DSA-65";
  // Internal: store raw bytes to avoid hex conversion issues
  _secretKeyBytes?: Uint8Array;
}

async function getMlDsa65() {
  // Keep this as a runtime import so the repo still builds even before deps are installed.
  // Once you install deps, this resolves to the real implementation.
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await import("@noble/post-quantum/ml-dsa.js");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return (mod as any).ml_dsa65 as {
      keygen(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
      sign(msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
      verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean;
    };
  } catch (e) {
    throw new Error(
      [
        "Missing dependency: @noble/post-quantum",
        "Install Node.js (includes npm), then run:",
        "  npm install",
        "",
        "Underlying error:",
        e instanceof Error ? e.message : String(e),
      ].join("\n")
    );
  }
}

export async function pqcKeygen(): Promise<PQKeypair> {
  const ml = await getMlDsa65();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const kp = ml.keygen(seed);
  // CRITICAL: The key from keygen might have a larger underlying buffer
  // Create a completely isolated copy with exactly the right size
  const secretKeyBuffer = new ArrayBuffer(4032);
  const secretKeyBytes = new Uint8Array(secretKeyBuffer);
  // Copy byte-by-byte to ensure complete isolation
  for (let i = 0; i < 4032; i++) {
    secretKeyBytes[i] = kp.secretKey[i];
  }
  return {
    algorithm: "ML-DSA-65",
    publicKeyHex: bytesToHex(kp.publicKey),
    secretKeyHex: bytesToHex(kp.secretKey),
    _secretKeyBytes: secretKeyBytes, // Store raw bytes for direct use
  };
}

export async function pqcSign(secretKeyHex: string, message: Uint8Array, rawSecretKeyBytes?: Uint8Array): Promise<string> {
  const ml = await getMlDsa65();
  
  // If raw bytes are provided (from keygen), use them directly to avoid hex conversion issues
  if (rawSecretKeyBytes && rawSecretKeyBytes.length === 4032) {
    // ALWAYS create a fresh isolated copy to ensure the buffer is exactly 4032 bytes
    // The library's decode function uses subarray which can read beyond if the buffer is larger
    const keyBuffer = new ArrayBuffer(4032);
    const isolatedKey = new Uint8Array(keyBuffer);
    // Copy byte-by-byte to ensure complete isolation
    for (let i = 0; i < 4032; i++) {
      isolatedKey[i] = rawSecretKeyBytes[i];
    }
    
    // Verify isolation
    if (isolatedKey.buffer.byteLength !== 4032 || isolatedKey.byteOffset !== 0) {
      throw new Error(`Failed to create isolated key: buffer=${isolatedKey.buffer.byteLength}, offset=${isolatedKey.byteOffset}`);
    }
    try {
      const sig = ml.sign(message, isolatedKey);
      return bytesToHex(sig);
    } catch (signError) {
      console.error(`[pqcSign] ❌ Signing failed:`, signError);
      throw signError;
    }
  }
  
  // Fallback: convert from hex (for backwards compatibility)
  const cleanHex = secretKeyHex.trim();
  
  if (cleanHex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${cleanHex.length} (must be even)`);
  }
  
  const secretKeyBytes = hexToBytes(cleanHex);
  
  if (secretKeyBytes.length !== 4032) {
    throw new Error(`Invalid secret key length: expected 4032 bytes, got ${secretKeyBytes.length}`);
  }
  
  // Create isolated ArrayBuffer
  const keyBuffer = new ArrayBuffer(4032);
  const isolatedKey = new Uint8Array(keyBuffer);
  for (let i = 0; i < 4032; i++) {
    isolatedKey[i] = secretKeyBytes[i];
  }
  if (isolatedKey.byteOffset !== 0 || isolatedKey.buffer.byteLength !== 4032) {
    throw new Error(`Failed to create isolated key array: offset=${isolatedKey.byteOffset}, buffer size=${isolatedKey.buffer.byteLength}`);
  }
  
  try {
    const sig = ml.sign(message, isolatedKey);
    return bytesToHex(sig);
  } catch (signError) {
    console.error(`[pqcSign] ❌ Signing failed:`, signError);
    throw signError;
  }
}

export async function pqcVerify(publicKeyHex: string, message: Uint8Array, signatureHex: string): Promise<boolean> {
  const ml = await getMlDsa65();
  return ml.verify(hexToBytes(signatureHex), message, hexToBytes(publicKeyHex));
}

