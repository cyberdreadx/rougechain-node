import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper functions for hex conversion
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Initialize Supabase client
function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
  );
}

// Hash a block using SHA-256
async function hashBlock(block: { 
  index: number; 
  timestamp: number; 
  data: string; 
  previousHash: string; 
  nonce: number 
}): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(
    `${block.index}${block.timestamp}${block.data}${block.previousHash}${block.nonce}`
  );
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mine a block (find valid nonce with proof-of-work)
async function mineBlock(
  index: number,
  data: string,
  previousHash: string,
  difficulty: number = 2
): Promise<{ index: number; timestamp: number; data: string; previousHash: string; hash: string; nonce: number }> {
  let nonce = 0;
  let hash = "";
  const timestamp = Date.now();
  const target = "0".repeat(difficulty);

  while (!hash.startsWith(target)) {
    nonce++;
    hash = await hashBlock({ index, timestamp, data, previousHash, nonce });
    if (nonce > 1000000) break; // Safety limit
  }

  return { index, timestamp, data, previousHash, hash, nonce };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, payload } = body;
    console.log("Received action:", action, "payload keys:", payload ? Object.keys(payload) : "none");
    const supabase = getSupabaseClient();

    switch (action) {
      case "generate-keypair": {
        // Generate REAL ML-DSA-65 (Dilithium) keypair
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const keypair = ml_dsa65.keygen(seed);
        
        const publicKeyHex = bytesToHex(keypair.publicKey);
        const privateKeyHex = bytesToHex(keypair.secretKey);

        // Store public key in database
        const { error: dbError } = await supabase
          .from("pqc_keypairs")
          .insert({
            public_key: publicKeyHex,
            algorithm: "ML-DSA-65",
          });

        if (dbError) {
          console.error("DB error storing keypair:", dbError);
        }

        return new Response(JSON.stringify({
          success: true,
          keypair: {
            publicKey: publicKeyHex,
            privateKey: privateKeyHex,
          },
          algorithm: "ML-DSA-65 (CRYSTALS-Dilithium)",
          publicKeySize: `${keypair.publicKey.length} bytes`,
          privateKeySize: `${keypair.secretKey.length} bytes`,
          standard: "FIPS 204",
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
        
        // Sign with REAL ML-DSA-65
        const privateKeyBytes = hexToBytes(privateKey);
        const messageBytes = new TextEncoder().encode(blockHash);
        const signature = ml_dsa65.sign(privateKeyBytes, messageBytes);
        
        return new Response(JSON.stringify({
          success: true,
          signature: bytesToHex(signature),
          signatureSize: `${signature.length} bytes`,
          algorithm: "ML-DSA-65 (FIPS 204)",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "verify-signature": {
        const { blockHash, signature, publicKey } = payload;
        
        try {
          // Verify with REAL ML-DSA-65
          const publicKeyBytes = hexToBytes(publicKey);
          const signatureBytes = hexToBytes(signature);
          const messageBytes = new TextEncoder().encode(blockHash);
          
          const valid = ml_dsa65.verify(publicKeyBytes, messageBytes, signatureBytes);
          
          return new Response(JSON.stringify({
            success: true,
            valid,
            algorithm: "ML-DSA-65 (FIPS 204)",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({
            success: true,
            valid: false,
            error: e instanceof Error ? e.message : "Verification failed",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      case "create-genesis": {
        // Generate REAL ML-DSA-65 keypair
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const keypair = ml_dsa65.keygen(seed);
        
        const publicKeyHex = bytesToHex(keypair.publicKey);
        const privateKeyHex = bytesToHex(keypair.secretKey);

        // Mine genesis block
        const genesisData = "Genesis Block - PQC Blockchain";
        const block = await mineBlock(0, genesisData, "0".repeat(64), 2);
        
        // Sign with REAL ML-DSA-65
        const messageBytes = new TextEncoder().encode(block.hash);
        const signature = ml_dsa65.sign(keypair.secretKey, messageBytes);
        const signatureHex = bytesToHex(signature);

        const fullBlock = {
          ...block,
          signature: signatureHex,
          signerPublicKey: publicKeyHex,
        };

        // Store block in database
        const { error: blockError } = await supabase
          .from("pqc_blocks")
          .insert({
            block_index: fullBlock.index,
            timestamp: fullBlock.timestamp,
            data: fullBlock.data,
            previous_hash: fullBlock.previousHash,
            hash: fullBlock.hash,
            nonce: fullBlock.nonce,
            signature: fullBlock.signature,
            signer_public_key: fullBlock.signerPublicKey,
          });

        if (blockError) {
          console.error("DB error storing genesis:", blockError);
        }

        // Store public key
        await supabase
          .from("pqc_keypairs")
          .insert({
            public_key: publicKeyHex,
            algorithm: "ML-DSA-65",
          });

        return new Response(JSON.stringify({
          success: true,
          block: fullBlock,
          keypair: {
            publicKey: publicKeyHex,
            privateKey: privateKeyHex,
          },
          crypto: {
            algorithm: "ML-DSA-65 (CRYSTALS-Dilithium)",
            standard: "FIPS 204",
            publicKeySize: `${keypair.publicKey.length} bytes`,
            signatureSize: `${signature.length} bytes`,
            securityLevel: "NIST Level 3 (192-bit classical)",
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "save-block": {
        const { block } = payload;
        
        const { error } = await supabase
          .from("pqc_blocks")
          .insert({
            block_index: block.index,
            timestamp: block.timestamp,
            data: block.data,
            previous_hash: block.previousHash,
            hash: block.hash,
            nonce: block.nonce,
            signature: block.signature,
            signer_public_key: block.signerPublicKey,
          });

        if (error) {
          return new Response(JSON.stringify({
            success: false,
            error: error.message,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({
          success: true,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "load-chain": {
        const { data: blocks, error } = await supabase
          .from("pqc_blocks")
          .select("*")
          .order("block_index", { ascending: true });

        if (error) {
          return new Response(JSON.stringify({
            success: false,
            error: error.message,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Transform to frontend format
        const chain = (blocks || []).map(b => ({
          index: b.block_index,
          timestamp: b.timestamp,
          data: b.data,
          previousHash: b.previous_hash,
          hash: b.hash,
          nonce: b.nonce,
          signature: b.signature,
          signerPublicKey: b.signer_public_key,
        }));

        return new Response(JSON.stringify({
          success: true,
          chain,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "reset-chain": {
        // Clear all blocks for a fresh start
        await supabase.from("pqc_blocks").delete().neq("block_index", -999);
        await supabase.from("pqc_keypairs").delete().neq("id", "00000000-0000-0000-0000-000000000000");

        return new Response(JSON.stringify({
          success: true,
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
