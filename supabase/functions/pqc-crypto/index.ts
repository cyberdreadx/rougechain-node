import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";

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

      // ===== MESSENGER WALLET ACTIONS =====

      case "create-wallet": {
        const { displayName } = payload;
        
        // Generate ML-DSA-65 keypair for signing
        const signingSeed = crypto.getRandomValues(new Uint8Array(32));
        const signingKeypair = ml_dsa65.keygen(signingSeed);
        
        // Generate ML-KEM-768 keypair for encryption
        const encryptionSeed = crypto.getRandomValues(new Uint8Array(64));
        const encryptionKeypair = ml_kem768.keygen(encryptionSeed);
        
        const signingPublicKeyHex = bytesToHex(signingKeypair.publicKey);
        const signingPrivateKeyHex = bytesToHex(signingKeypair.secretKey);
        const encryptionPublicKeyHex = bytesToHex(encryptionKeypair.publicKey);
        const encryptionPrivateKeyHex = bytesToHex(encryptionKeypair.secretKey);

        // Store wallet in database (public keys only)
        const { data: wallet, error: walletError } = await supabase
          .from("wallets")
          .insert({
            display_name: displayName,
            signing_public_key: signingPublicKeyHex,
            encryption_public_key: encryptionPublicKeyHex,
          })
          .select()
          .single();

        if (walletError) {
          return new Response(JSON.stringify({
            success: false,
            error: walletError.message,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          wallet: {
            id: wallet.id,
            displayName: wallet.display_name,
            signingPublicKey: signingPublicKeyHex,
            encryptionPublicKey: encryptionPublicKeyHex,
          },
          privateKeys: {
            signingPrivateKey: signingPrivateKeyHex,
            encryptionPrivateKey: encryptionPrivateKeyHex,
          },
          algorithms: {
            signing: "ML-DSA-65 (FIPS 204)",
            encryption: "ML-KEM-768 (FIPS 203)",
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "encrypt-message": {
        const { plaintext, recipientEncryptionPublicKey, senderSigningPrivateKey } = payload;
        
        // Encapsulate a shared secret using recipient's ML-KEM public key
        const recipientPubKeyBytes = hexToBytes(recipientEncryptionPublicKey);
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientPubKeyBytes);
        
        // Copy to a fresh ArrayBuffer to avoid type issues
        const keyBuffer = new ArrayBuffer(32);
        new Uint8Array(keyBuffer).set(sharedSecret.slice(0, 32));
        
        const aesKey = await crypto.subtle.importKey(
          "raw",
          keyBuffer,
          { name: "AES-GCM" },
          false,
          ["encrypt"]
        );
        
        // Encrypt the message with AES-GCM
        const ivBuffer = new ArrayBuffer(12);
        const iv = new Uint8Array(ivBuffer);
        crypto.getRandomValues(iv);
        
        const plaintextBytes = new TextEncoder().encode(plaintext);
        const encryptedBytes = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: ivBuffer },
          aesKey,
          plaintextBytes
        );
        
        // Sign the plaintext with sender's ML-DSA private key
        const senderPrivKeyBytes = hexToBytes(senderSigningPrivateKey);
        const signature = ml_dsa65.sign(senderPrivKeyBytes, plaintextBytes);
        
        // Package: cipherText (KEM) + iv + encryptedData
        const encryptedData = {
          kemCipherText: bytesToHex(cipherText),
          iv: bytesToHex(iv),
          encryptedContent: bytesToHex(new Uint8Array(encryptedBytes)),
        };

        return new Response(JSON.stringify({
          success: true,
          encryptedPackage: JSON.stringify(encryptedData),
          signature: bytesToHex(signature),
          algorithm: "ML-KEM-768 + AES-256-GCM",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "decrypt-message": {
        const { encryptedPackage, recipientEncryptionPrivateKey, senderSigningPublicKey, signature } = payload;
        
        try {
          const encryptedData = JSON.parse(encryptedPackage);
          
          // Decapsulate shared secret using recipient's ML-KEM private key
          const recipientPrivKeyBytes = hexToBytes(recipientEncryptionPrivateKey);
          const kemCipherTextBytes = hexToBytes(encryptedData.kemCipherText);
          const sharedSecret = ml_kem768.decapsulate(kemCipherTextBytes, recipientPrivKeyBytes);
          
          // Copy to a fresh ArrayBuffer to avoid type issues
          const keyBuffer = new ArrayBuffer(32);
          new Uint8Array(keyBuffer).set(sharedSecret.slice(0, 32));
          
          const aesKey = await crypto.subtle.importKey(
            "raw",
            keyBuffer,
            { name: "AES-GCM" },
            false,
            ["decrypt"]
          );
          
          // Decrypt the message - copy to fresh buffers
          const ivBytes = hexToBytes(encryptedData.iv);
          const ivBuffer = new ArrayBuffer(ivBytes.length);
          new Uint8Array(ivBuffer).set(ivBytes);
          
          const contentBytes = hexToBytes(encryptedData.encryptedContent);
          const contentBuffer = new ArrayBuffer(contentBytes.length);
          new Uint8Array(contentBuffer).set(contentBytes);
          
          const decryptedBytes = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: ivBuffer },
            aesKey,
            contentBuffer
          );
          
          const plaintext = new TextDecoder().decode(decryptedBytes);
          
          // Verify signature
          const senderPubKeyBytes = hexToBytes(senderSigningPublicKey);
          const signatureBytes = hexToBytes(signature);
          const plaintextBytes = new TextEncoder().encode(plaintext);
          const validSignature = ml_dsa65.verify(senderPubKeyBytes, plaintextBytes, signatureBytes);

          return new Response(JSON.stringify({
            success: true,
            plaintext,
            signatureValid: validSignature,
            algorithm: "ML-KEM-768 + AES-256-GCM",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : "Decryption failed",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      case "get-wallets": {
        const { data: wallets, error } = await supabase
          .from("wallets")
          .select("id, display_name, signing_public_key, encryption_public_key, created_at")
          .order("created_at", { ascending: false });

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
          wallets: wallets.map(w => ({
            id: w.id,
            displayName: w.display_name,
            signingPublicKey: w.signing_public_key,
            encryptionPublicKey: w.encryption_public_key,
            createdAt: w.created_at,
          })),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ===== VALIDATOR SYSTEM ACTIONS =====

      case "register-validator": {
        const { walletId, signingPublicKey, stakeAmount, tier } = payload;
        
        // Minimum stake requirements by tier
        const minStake: Record<string, number> = {
          standard: 10000, // 10,000 XRGE
          operator: 100000, // 100,000 XRGE  
          genesis: 1000000, // 1,000,000 XRGE
        };

        const requiredStake = minStake[tier] || minStake.standard;
        if (stakeAmount < requiredStake) {
          return new Response(JSON.stringify({
            success: false,
            error: `Minimum stake for ${tier} tier is ${requiredStake.toLocaleString()} XRGE`,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Check if already a validator
        const { data: existing } = await supabase
          .from("validators")
          .select("id")
          .eq("wallet_id", walletId)
          .single();

        if (existing) {
          return new Response(JSON.stringify({
            success: false,
            error: "Wallet is already registered as a validator",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Register the validator
        const { data: validator, error: validatorError } = await supabase
          .from("validators")
          .insert({
            wallet_id: walletId,
            signing_public_key: signingPublicKey,
            staked_amount: stakeAmount,
            tier: tier || "standard",
            status: "active",
          })
          .select()
          .single();

        if (validatorError) {
          return new Response(JSON.stringify({
            success: false,
            error: validatorError.message,
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Record staking history
        await supabase.from("staking_history").insert({
          validator_id: validator.id,
          action: "stake",
          amount: stakeAmount,
        });

        return new Response(JSON.stringify({
          success: true,
          validator: {
            id: validator.id,
            tier: validator.tier,
            status: validator.status,
            stakedAmount: validator.staked_amount,
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-validators": {
        const { data: validators, error } = await supabase
          .from("validators")
          .select("*")
          .order("staked_amount", { ascending: false });

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
          validators: validators.map(v => ({
            id: v.id,
            walletId: v.wallet_id,
            tier: v.tier,
            status: v.status,
            stakedAmount: Number(v.staked_amount),
            signingPublicKey: v.signing_public_key,
            commissionRate: Number(v.commission_rate),
            blocksProposed: v.blocks_proposed,
            blocksValidated: v.blocks_validated,
            uptimePercentage: Number(v.uptime_percentage),
            lastSeenAt: v.last_seen_at,
            registeredAt: v.registered_at,
            quantumEntropyContributions: v.quantum_entropy_contributions,
          })),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "select-proposer": {
        // Quantum-weighted random proposer selection using stake + entropy
        const { data: activeValidators, error } = await supabase
          .from("validators")
          .select("*")
          .eq("status", "active")
          .order("staked_amount", { ascending: false });

        if (error || !activeValidators?.length) {
          return new Response(JSON.stringify({
            success: false,
            error: "No active validators available",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Generate quantum entropy for selection
        const entropy = crypto.getRandomValues(new Uint8Array(32));
        const entropyHex = bytesToHex(entropy);

        // Calculate weighted selection based on stake
        const totalStake = activeValidators.reduce((sum, v) => sum + Number(v.staked_amount), 0);
        const randomValue = parseInt(entropyHex.slice(0, 8), 16) % totalStake;

        let cumulativeStake = 0;
        let selectedValidator = activeValidators[0];

        for (const validator of activeValidators) {
          cumulativeStake += Number(validator.staked_amount);
          if (randomValue < cumulativeStake) {
            selectedValidator = validator;
            break;
          }
        }

        // Store entropy contribution
        await supabase.from("quantum_entropy").insert({
          validator_id: selectedValidator.id,
          entropy_value: entropyHex,
          block_index: 0, // Will be updated when block is mined
          used_for_selection: true,
        });

        return new Response(JSON.stringify({
          success: true,
          proposer: {
            id: selectedValidator.id,
            walletId: selectedValidator.wallet_id,
            tier: selectedValidator.tier,
            stakedAmount: Number(selectedValidator.staked_amount),
            signingPublicKey: selectedValidator.signing_public_key,
          },
          entropy: entropyHex,
          totalStake,
          selectionWeight: (Number(selectedValidator.staked_amount) / totalStake * 100).toFixed(2) + "%",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "validate-block": {
        const { validatorId, blockHash, blockIndex, signature, isProposer } = payload;

        // Record the validation
        const { error } = await supabase.from("block_validations").insert({
          block_hash: blockHash,
          block_index: blockIndex,
          validator_id: validatorId,
          signature,
          is_proposer: isProposer || false,
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

        // Update validator stats
        if (isProposer) {
          await supabase.rpc("increment_blocks_proposed", { val_id: validatorId });
        } else {
          await supabase.rpc("increment_blocks_validated", { val_id: validatorId });
        }

        // Update last seen
        await supabase
          .from("validators")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", validatorId);

        return new Response(JSON.stringify({
          success: true,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "distribute-rewards": {
        const { blockIndex, totalFees, proposerId } = payload;

        // Get all validators who validated this block
        const { data: validations } = await supabase
          .from("block_validations")
          .select("validator_id, is_proposer")
          .eq("block_index", blockIndex);

        if (!validations?.length) {
          return new Response(JSON.stringify({
            success: false,
            error: "No validations found for this block",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Block reward (fixed) + fees
        const blockReward = 10; // 10 XRGE per block
        const proposerShare = 0.5; // 50% to proposer
        const validatorShare = 0.5; // 50% split among validators

        const proposerReward = Math.floor((blockReward + totalFees) * proposerShare);
        const validatorRewardPool = Math.floor((blockReward + totalFees) * validatorShare);
        const perValidatorReward = Math.floor(validatorRewardPool / validations.length);

        // Distribute rewards
        for (const validation of validations) {
          const reward = validation.is_proposer ? proposerReward : perValidatorReward;
          
          await supabase.from("validator_rewards").insert({
            validator_id: validation.validator_id,
            block_index: blockIndex,
            reward_amount: reward,
            fee_share: validation.is_proposer ? totalFees * proposerShare : 0,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          distributed: {
            blockReward,
            totalFees,
            proposerReward,
            perValidatorReward,
            validatorCount: validations.length,
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "slash-validator": {
        const { validatorId, reason, percentage } = payload;

        // Get validator
        const { data: validator } = await supabase
          .from("validators")
          .select("*")
          .eq("id", validatorId)
          .single();

        if (!validator) {
          return new Response(JSON.stringify({
            success: false,
            error: "Validator not found",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Calculate slash amount
        const slashPercentage = percentage || 10; // Default 10%
        const slashAmount = Math.floor(Number(validator.staked_amount) * slashPercentage / 100);

        // Update validator
        await supabase
          .from("validators")
          .update({
            staked_amount: Number(validator.staked_amount) - slashAmount,
            slashed_amount: Number(validator.slashed_amount) + slashAmount,
            status: slashPercentage >= 100 ? "jailed" : validator.status,
          })
          .eq("id", validatorId);

        // Record slashing event
        await supabase.from("slashing_events").insert({
          validator_id: validatorId,
          reason,
          amount_slashed: slashAmount,
        });

        // Record in staking history
        await supabase.from("staking_history").insert({
          validator_id: validatorId,
          action: "slash",
          amount: slashAmount,
        });

        return new Response(JSON.stringify({
          success: true,
          slashed: {
            validatorId,
            reason,
            amountSlashed: slashAmount,
            percentageSlashed: slashPercentage,
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "contribute-entropy": {
        const { validatorId, blockIndex } = payload;

        // Generate quantum random entropy
        const entropy = crypto.getRandomValues(new Uint8Array(64));
        const entropyHex = bytesToHex(entropy);

        // Store entropy
        await supabase.from("quantum_entropy").insert({
          validator_id: validatorId,
          entropy_value: entropyHex,
          block_index: blockIndex,
        });

        // Increment validator's entropy contributions
        await supabase
          .from("validators")
          .update({
            quantum_entropy_contributions: (
              await supabase
                .from("validators")
                .select("quantum_entropy_contributions")
                .eq("id", validatorId)
                .single()
            ).data?.quantum_entropy_contributions + 1 || 1,
          })
          .eq("id", validatorId);

        return new Response(JSON.stringify({
          success: true,
          entropy: entropyHex.slice(0, 32) + "...", // Truncate for display
          fullLength: entropy.length,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-validator-stats": {
        const { validatorId } = payload;

        const [validatorResult, rewardsResult, stakingResult, validationsResult] = await Promise.all([
          supabase.from("validators").select("*").eq("id", validatorId).single(),
          supabase.from("validator_rewards").select("*").eq("validator_id", validatorId),
          supabase.from("staking_history").select("*").eq("validator_id", validatorId).order("created_at", { ascending: false }),
          supabase.from("block_validations").select("*").eq("validator_id", validatorId),
        ]);

        if (validatorResult.error) {
          return new Response(JSON.stringify({
            success: false,
            error: "Validator not found",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const totalRewards = rewardsResult.data?.reduce((sum, r) => sum + Number(r.reward_amount), 0) || 0;
        const totalFeeShare = rewardsResult.data?.reduce((sum, r) => sum + Number(r.fee_share), 0) || 0;

        return new Response(JSON.stringify({
          success: true,
          validator: validatorResult.data,
          stats: {
            totalRewards,
            totalFeeShare,
            stakingHistory: stakingResult.data,
            validationsCount: validationsResult.data?.length || 0,
            proposedBlocks: validationsResult.data?.filter(v => v.is_proposer).length || 0,
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "unstake": {
        const { validatorId, amount } = payload;

        const { data: validator } = await supabase
          .from("validators")
          .select("*")
          .eq("id", validatorId)
          .single();

        if (!validator) {
          return new Response(JSON.stringify({
            success: false,
            error: "Validator not found",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (amount > Number(validator.staked_amount)) {
          return new Response(JSON.stringify({
            success: false,
            error: "Insufficient staked amount",
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const newStakedAmount = Number(validator.staked_amount) - amount;

        // Check if below minimum stake for tier
        const minStake: Record<string, number> = {
          standard: 10000,
          operator: 100000,
          genesis: 1000000,
        };

        let newStatus = validator.status;
        let newTier = validator.tier;

        if (newStakedAmount < minStake.standard) {
          newStatus = "unbonding";
        } else if (newStakedAmount < minStake[validator.tier]) {
          // Downgrade tier
          if (validator.tier === "genesis" && newStakedAmount >= minStake.operator) {
            newTier = "operator";
          } else if (validator.tier !== "standard" && newStakedAmount >= minStake.standard) {
            newTier = "standard";
          }
        }

        await supabase
          .from("validators")
          .update({
            staked_amount: newStakedAmount,
            status: newStatus,
            tier: newTier,
            unbonding_at: newStatus === "unbonding" ? new Date().toISOString() : null,
          })
          .eq("id", validatorId);

        await supabase.from("staking_history").insert({
          validator_id: validatorId,
          action: "unstake",
          amount,
        });

        return new Response(JSON.stringify({
          success: true,
          unstaked: {
            amount,
            newStakedAmount,
            newStatus,
            newTier,
          },
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
