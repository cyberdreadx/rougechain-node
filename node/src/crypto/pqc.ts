import { hexToBytes, bytesToHex } from "./hash";

export interface PQKeypair {
  publicKeyHex: string;
  secretKeyHex: string;
  algorithm: "ML-DSA-65";
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
      sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array;
      verify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean;
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
  return {
    algorithm: "ML-DSA-65",
    publicKeyHex: bytesToHex(kp.publicKey),
    secretKeyHex: bytesToHex(kp.secretKey),
  };
}

export async function pqcSign(secretKeyHex: string, message: Uint8Array): Promise<string> {
  const ml = await getMlDsa65();
  const sig = ml.sign(hexToBytes(secretKeyHex), message);
  return bytesToHex(sig);
}

export async function pqcVerify(publicKeyHex: string, message: Uint8Array, signatureHex: string): Promise<boolean> {
  const ml = await getMlDsa65();
  return ml.verify(hexToBytes(publicKeyHex), message, hexToBytes(signatureHex));
}

