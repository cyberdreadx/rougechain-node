import http from "node:http";
import { L1Node, defaultDataDir } from "./node";
import { encodeTxV1 } from "./codec";
import { sha256, bytesToHex, hexToBytes } from "./crypto/hash";

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePeers(raw: string | null): Array<{ host: string; port: number }> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((hp) => {
      const [host, portStr] = hp.split(":");
      return { host, port: Number(portStr) };
    })
    .filter((p) => p.host && Number.isFinite(p.port));
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function main() {
  const host = getArg("--host") ?? "127.0.0.1";
  const port = Number(getArg("--port") ?? "4100");
  const peers = parsePeers(getArg("--peers"));
  const mine = hasFlag("--mine");
  const name = getArg("--name") ?? `node-${port}`;
  const chainId = getArg("--chain") ?? "rougechain-devnet-1";
  const advertiseHost = getArg("--advertise") ?? undefined;

  const node = new L1Node({
    listenHost: host,
    listenPort: port,
    advertiseHost,
    peers,
    mine,
    dataDir: defaultDataDir(name),
    chain: {
      chainId,
      genesisTime: Date.now(),
      blockTimeMs: Number(getArg("--blockTimeMs") ?? "1000"), // Default 1 second for faster devnet
    },
  });

  await node.start();
  console.log(`\n✅ RougeChain L1 Node running`);
  console.log(`   Chain ID: ${chainId}`);
  console.log(`   P2P Port: ${port}`);
  console.log(`   Peers: ${peers.length > 0 ? peers.map(p => `${p.host}:${p.port}`).join(", ") : "none (standalone)"}`);
  console.log(`   Mining: ${mine ? "YES" : "NO"}`);
  console.log(`   Block Time: ${Number(getArg("--blockTimeMs") ?? "1000")}ms\n`);

  // Start HTTP API server for React UI
  const apiPort = Number(getArg("--apiPort") ?? String(port + 1000));
  const apiServer = http.createServer(async (req, res) => {
    // Handle CORS preflight (OPTIONS) requests
    if (req.method === "OPTIONS") {
      setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }
    
    // Set CORS headers for all responses
    setCorsHeaders(req, res);
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/api/stats" && req.method === "GET") {
      const height = await node.getChainHeight();
      const peerCount = node.getPeerCount();
      const feeStats = await node.getFeeStats();
      res.writeHead(200);
      res.end(JSON.stringify({
        connectedPeers: peerCount,
        networkHeight: height,
        isMining: node.isMining(),
        nodeId: node.getNodeId(),
        totalFeesCollected: feeStats.totalFees,
        feesInLastBlock: feeStats.lastBlockFees,
        chainId: chainId, // Include chain ID so frontend can detect mainnet
      }));
      return;
    }

    if (req.url === "/api/selection" && req.method === "GET") {
      const selection = await node.getSelectionInfo();
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        height: selection.height,
        proposer: selection.result?.proposerPubKey ?? null,
        totalStake: selection.result?.totalStake?.toString() ?? null,
        selectionWeight: selection.result?.selectionWeight?.toString() ?? null,
        entropySource: selection.result?.entropySource ?? null,
        entropyHex: selection.result?.entropyHex ?? null,
      }));
      return;
    }

    if (req.url === "/api/validators" && req.method === "GET") {
      const set = await node.getValidatorSet();
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        validators: set.validators,
        totalStake: set.totalStake,
      }));
      return;
    }

    if (req.url === "/api/blocks" && req.method === "GET") {
      const blocks = await node.getAllBlocks();
      res.writeHead(200);
      res.end(JSON.stringify({ blocks }));
      return;
    }

    // Public API: Get transactions (extracted from blocks)
    if (req.url === "/api/transactions" && req.method === "GET") {
      const blocks = await node.getAllBlocks();
      const allTxs: Array<{
        tx: unknown;
        blockHeight: number;
        blockHash: string;
        blockTime: number;
      }> = [];
      
      for (const block of blocks) {
        for (const tx of block.txs) {
          allTxs.push({
            tx,
            blockHeight: block.header.height,
            blockHash: block.hash,
            blockTime: block.header.time,
          });
        }
      }
      
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, transactions: allTxs }));
      return;
    }

    // Public API: Create wallet (generate keypair)
    if (req.url === "/api/wallet/create" && req.method === "POST") {
      try {
        const keypair = await node.createWallet();
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          publicKey: keypair.publicKeyHex,
          privateKey: keypair.secretKeyHex, // In production, encrypt this!
          algorithm: keypair.algorithm,
        }));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }));
      }
      return;
    }

    // Public API: Submit transaction
    if (req.url === "/api/tx/submit" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            fromPrivateKey: string;
            fromPublicKey: string;
            toPublicKey: string;
            amount: number;
            fee?: number;
          };
          
          const tx = await node.submitUserTx(
            data.fromPrivateKey,
            data.fromPublicKey,
            data.toPublicKey,
            data.amount,
            data.fee
          );
          
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            txId: bytesToHex(sha256(encodeTxV1(tx))),
            tx,
          }));
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Invalid transaction",
          }));
        }
      });
      return;
    }

    if (req.url === "/api/stake/submit" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            fromPrivateKey: string;
            fromPublicKey: string;
            amount: number;
            fee?: number;
          };
          const tx = await node.submitStakeTx(
            data.fromPrivateKey,
            data.fromPublicKey,
            data.amount,
            data.fee
          );
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            txId: bytesToHex(sha256(encodeTxV1(tx))),
            tx,
          }));
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Invalid stake transaction",
          }));
        }
      });
      return;
    }

    if (req.url === "/api/unstake/submit" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            fromPrivateKey: string;
            fromPublicKey: string;
            amount: number;
            fee?: number;
          };
          const tx = await node.submitUnstakeTx(
            data.fromPrivateKey,
            data.fromPublicKey,
            data.amount,
            data.fee
          );
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            txId: bytesToHex(sha256(encodeTxV1(tx))),
            tx,
          }));
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Invalid unstake transaction",
          }));
        }
      });
      return;
    }

    // Public API: Faucet (mint tokens for devnet ONLY - disabled on mainnet)
    if (req.url === "/api/faucet" && req.method === "POST") {
      // SECURITY: Disable faucet on mainnet
      if (!chainId.includes("devnet") && !chainId.includes("testnet")) {
        res.writeHead(403);
        res.end(JSON.stringify({
          success: false,
          error: "Faucet is disabled on mainnet. Use devnet or testnet for testing.",
        }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            recipientPublicKey: string;
            amount?: number;
          };
          
          // For faucet, we create a special transaction from a "FAUCET" address
          // In a real system, this would be a mint transaction type
          // For now, we'll use the node's own keypair to send tokens (devnet only)
          if (!node.isMining()) {
            res.writeHead(400);
            res.end(JSON.stringify({
              success: false,
              error: "Faucet only works when node is mining",
            }));
            return;
          }
          
          // Get node's keypair (miner)
          const nodeKeys = await node.getMinerKeys();
          if (!nodeKeys) {
            res.writeHead(500);
            res.end(JSON.stringify({
              success: false,
              error: "Node not configured for mining",
            }));
            return;
          }
          
          // Validate key format
          if (!nodeKeys.secretKeyHex || typeof nodeKeys.secretKeyHex !== "string") {
            res.writeHead(500);
            res.end(JSON.stringify({
              success: false,
              error: "Invalid miner key format",
            }));
            return;
          }
          
          // Debug: Log key lengths and validate BEFORE using
          console.log(`[Faucet] Secret key hex length: ${nodeKeys.secretKeyHex.length} (expected: 8064 for 4032 bytes)`);
          console.log(`[Faucet] Public key hex length: ${nodeKeys.publicKeyHex.length}`);
          
          // Validate hex string length before using
          // Check if hex string is valid (even length, correct size)
          const secretKeyHex = nodeKeys.secretKeyHex.trim();
          
          // Check for invalid hex characters
          if (!/^[0-9a-fA-F]+$/.test(secretKeyHex)) {
            const invalidChars = secretKeyHex.split('').filter(c => !/[0-9a-fA-F]/.test(c));
            console.error(`[Faucet] Invalid hex characters found: ${invalidChars.slice(0, 20).join('')}`);
            res.writeHead(500);
            res.end(JSON.stringify({
              success: false,
              error: `Invalid miner key: contains non-hex characters. Please restart the node.`,
            }));
            return;
          }
          
          if (secretKeyHex.length % 2 !== 0) {
            console.error(`[Faucet] Invalid secret key hex: odd length ${secretKeyHex.length}`);
            res.writeHead(500);
            res.end(JSON.stringify({
              success: false,
              error: `Invalid miner key: hex string has odd length ${secretKeyHex.length}. Node needs to be restarted.`,
            }));
            return;
          }
          
          // Convert to bytes to verify actual length (Buffer.from handles invalid hex differently)
          const testBytes = hexToBytes(secretKeyHex);
          console.log(`[Faucet] Secret key converts to ${testBytes.length} bytes (expected: 4032, hex length: ${secretKeyHex.length})`);
          
          if (testBytes.length !== 4032) {
            console.error(`[Faucet] Invalid secret key: ${testBytes.length} bytes, expected 4032 (hex length: ${secretKeyHex.length}, expected: 8064)`);
            res.writeHead(500);
            res.end(JSON.stringify({
              success: false,
              error: `Invalid miner key: secret key is ${testBytes.length} bytes (${secretKeyHex.length} hex chars), expected 4032 bytes (8064 hex chars). Please restart the node to regenerate keys.`,
            }));
            return;
          }
          
          // Use the trimmed/validated hex string
          const validatedKeys = {
            ...nodeKeys,
            secretKeyHex: secretKeyHex,
          };
          
          // Submit a transfer from the miner (acting as faucet) to the recipient
          // Fee is 0 for faucet transactions
          try {
            const tx = await node.submitFaucetTx(
              validatedKeys.secretKeyHex,
              validatedKeys.publicKeyHex,
              data.recipientPublicKey,
              data.amount ?? 10000
            );
            
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              txId: bytesToHex(sha256(encodeTxV1(tx))),
              tx,
              message: `Faucet transaction submitted. ${data.amount ?? 10000} XRGE will be included in the next block.`,
            }));
          } catch (txError) {
            console.error("[Faucet] Transaction submission error:", txError);
            res.writeHead(400);
            res.end(JSON.stringify({
              success: false,
              error: txError instanceof Error ? txError.message : "Failed to submit faucet transaction",
            }));
            return;
          }
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Invalid faucet request",
          }));
        }
      });
      return;
    }

    // Public API: Get balance (placeholder - needs state system)
    if (req.url?.startsWith("/api/balance/") && req.method === "GET") {
      const publicKey = req.url.split("/api/balance/")[1];
      if (publicKey) {
        const balance = await node.getBalance(publicKey);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, balance }));
        return;
      }
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const apiHost = getArg("--apiHost") ?? host; // Use same host as P2P, or allow override
  apiServer.listen(apiPort, apiHost, () => {
    console.log(`📡 HTTP API listening on http://${apiHost}:${apiPort}/api/stats`);
    if (apiHost === "0.0.0.0") {
      console.log(`   Public API accessible from any interface`);
    }
  });

  // Basic interactive: if started with --sendTo <pubkeyHex> --amount <n>
  const sendTo = getArg("--sendTo");
  const amount = getArg("--amount");
  if (sendTo && amount) {
    await node.submitTransferTx(sendTo, Number(amount));
  }

  // Keep process alive
  process.stdin.resume();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

