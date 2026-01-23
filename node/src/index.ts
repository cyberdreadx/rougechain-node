import http from "node:http";
import { L1Node, defaultDataDir } from "./node";
import { encodeTxV1 } from "./codec";
import { sha256, bytesToHex } from "./crypto/hash";

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

async function main() {
  const host = getArg("--host") ?? "127.0.0.1";
  const port = Number(getArg("--port") ?? "4100");
  const peers = parsePeers(getArg("--peers"));
  const mine = hasFlag("--mine");
  const name = getArg("--name") ?? `node-${port}`;
  const chainId = getArg("--chain") ?? "rougechain-devnet-1";

  const node = new L1Node({
    listenHost: host,
    listenPort: port,
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
    res.setHeader("Access-Control-Allow-Origin", "*");
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
      }));
      return;
    }

    if (req.url === "/api/blocks" && req.method === "GET") {
      const blocks = await node.getAllBlocks();
      res.writeHead(200);
      res.end(JSON.stringify({ blocks }));
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

