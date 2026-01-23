import { sha256, bytesToHex } from "../crypto/hash";

export interface ProposerSelectionResult {
  proposerPubKey: string;
  totalStake: bigint;
  selectionWeight: bigint;
  entropyHex: string;
  entropySource: string;
}

const DEFAULT_QRNG_URL = "https://qrng.anu.edu.au/API/jsonI.php?length=1&type=hex16";

export async function fetchQrngEntropy(): Promise<{ entropyHex: string; source: string }> {
  const url = process.env.QRNG_URL || DEFAULT_QRNG_URL;
  const source = url;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(`QRNG request failed: ${res.status}`);
    }
    const data = await res.json() as { data?: string[]; random?: string };
    const entropyHex = data.random || data.data?.[0];
    if (!entropyHex) {
      throw new Error("QRNG response missing entropy");
    }
    return { entropyHex, source };
  } catch (error) {
    const fallbackEntropy = bytesToHex(sha256(new TextEncoder().encode(String(Date.now()))));
    return { entropyHex: fallbackEntropy, source: "fallback-local" };
  }
}

export function computeSelectionSeed(entropyHex: string, prevHash: string, height: number): bigint {
  const input = `${entropyHex}:${prevHash}:${height}`;
  const seedHex = bytesToHex(sha256(new TextEncoder().encode(input)));
  return BigInt(`0x${seedHex}`);
}

export function selectProposer(
  stakes: Map<string, bigint>,
  seed: bigint,
  entropyHex: string,
  entropySource: string
): ProposerSelectionResult | null {
  if (stakes.size === 0) return null;
  let total = 0n;
  for (const amount of stakes.values()) {
    if (amount > 0n) total += amount;
  }
  if (total <= 0n) return null;

  const selection = seed % total;
  let cumulative = 0n;
  for (const [pubKey, amount] of stakes.entries()) {
    if (amount <= 0n) continue;
    cumulative += amount;
    if (selection < cumulative) {
      return {
        proposerPubKey: pubKey,
        totalStake: total,
        selectionWeight: selection,
        entropyHex,
        entropySource,
      };
    }
  }
  return null;
}

export function parseStakeAmount(payload: unknown): bigint | null {
  if (!payload || typeof payload !== "object") return null;
  const amount = (payload as { amount?: number }).amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return BigInt(Math.floor(amount));
}
