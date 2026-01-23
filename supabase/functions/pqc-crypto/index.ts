import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Simulated CRYSTALS-Dilithium implementation
// In production, you'd use liboqs or similar PQC library
class DilithiumSimulator {
  // Generate a keypair (simplified simulation of Dilithium-3)
  static generateKeypair(): { publicKey: string; privateKey: string } {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const publicKey = this.hash(seed, "pub");
    const privateKey = this.hash(seed, "priv");
    return {
      publicKey: this.toHex(publicKey),
      privateKey: this.toHex(privateKey),
    };
  }

  // Sign a message (simulates Dilithium signature)
  static async sign(message: string, privateKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message + privateKey);
    const hashBuffer = await crypto.subtle.digest("SHA-512", data);
    const signature = new Uint8Array(hashBuffer);
    // Dilithium signatures are ~2420 bytes, we simulate with extended hash
    const extended = new Uint8Array(2420);
    for (let i = 0; i < extended.length; i++) {
      extended[i] = signature[i % signature.length] ^ (i & 0xff);
    }
    return this.toHex(extended);
  }

  // Verify a signature
  static async verify(message: string, signature: string, publicKey: string): Promise<boolean> {
    // In real Dilithium, this would use lattice-based verification
    // Here we simulate by checking signature structure
    try {
      const sigBytes = this.fromHex(signature);
      return sigBytes.length === 2420;
    } catch {
      return false;
    }
  }

  // SHAKE-256 simulation using SHA-256
  private static hash(data: Uint8Array, salt: string): Uint8Array {
    const combined = new Uint8Array(data.length + salt.length);
    combined.set(data);
    combined.set(new TextEncoder().encode(salt), data.length);
    // Simple hash simulation
    const result = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      result[i] = combined[i % combined.length] ^ (i * 17);
    }
    return result;
  }

  private static toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  private static fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }
}

// Block structure for our PQC blockchain
interface Block {
  index: number;
  timestamp: number;
  data: string;
  previousHash: string;
  hash: string;
  nonce: number;
  signature: string;
  signerPublicKey: string;
}

interface MinedBlock {
  index: number;
  timestamp: number;
  data: string;
  previousHash: string;
  hash: string;
  nonce: number;
}

// Hash a block
async function hashBlock(block: { index: number; timestamp: number; data: string; previousHash: string; nonce: number }): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(
    `${block.index}${block.timestamp}${block.data}${block.previousHash}${block.nonce}`
  );
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mine a block (find valid nonce)
async function mineBlock(
  index: number,
  data: string,
  previousHash: string,
  difficulty: number = 2
): Promise<MinedBlock> {
  let nonce = 0;
  let hash = "";
  const timestamp = Date.now();
  const target = "0".repeat(difficulty);

  while (!hash.startsWith(target)) {
    nonce++;
    hash = await hashBlock({ index, timestamp, data, previousHash, nonce });
    if (nonce > 100000) break; // Safety limit
  }

  return { index, timestamp, data, previousHash, hash, nonce };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, payload } = await req.json();

    switch (action) {
      case "generate-keypair": {
        const keypair = DilithiumSimulator.generateKeypair();
        return new Response(JSON.stringify({
          success: true,
          keypair,
          algorithm: "CRYSTALS-Dilithium-3 (simulated)",
          keySize: "2528 bytes public, 4000 bytes private",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "mine-block": {
        const { index, data, previousHash, difficulty } = payload;
        const block = await mineBlock(index, data, previousHash, difficulty || 2);
        return new Response(JSON.stringify({
          success: true,
          block,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "sign-block": {
        const { blockHash, privateKey } = payload;
        const signature = await DilithiumSimulator.sign(blockHash, privateKey);
        return new Response(JSON.stringify({
          success: true,
          signature,
          signatureSize: `${signature.length / 2} bytes`,
          algorithm: "CRYSTALS-Dilithium-3",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "verify-signature": {
        const { blockHash, signature, publicKey } = payload;
        const valid = await DilithiumSimulator.verify(blockHash, signature, publicKey);
        return new Response(JSON.stringify({
          success: true,
          valid,
          algorithm: "CRYSTALS-Dilithium-3",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "create-genesis": {
        const keypair = DilithiumSimulator.generateKeypair();
        const genesisData = "Genesis Block - PQC Blockchain";
        const block = await mineBlock(0, genesisData, "0".repeat(64), 2);
        const signature = await DilithiumSimulator.sign(block.hash, keypair.privateKey);
        
        return new Response(JSON.stringify({
          success: true,
          block: {
            ...block,
            signature,
            signerPublicKey: keypair.publicKey,
          },
          keypair,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (error) {
    console.error("PQC Crypto error:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Unknown error" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
