import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BlockV1, ChainConfig, P2PMessage, TxV1 } from "./types";
import { ChainStore } from "./storage/chain-store";
import { TcpPeer, type PeerEndpoint } from "./p2p/tcp-peer";
import { computeBlockHash, computeTxHash, encodeHeaderV1, encodeTxV1 } from "./codec";
import { pqcKeygen, pqcSign, pqcVerify, type PQKeypair } from "./crypto/pqc";
import { sha256, bytesToHex } from "./crypto/hash";
import { encodeTxV1 } from "./codec";

// Fee constants (in XRGE)
// Fees are collected from transactions and go to the block proposer (miner)
// This incentivizes block production and network security
const BASE_TRANSFER_FEE = 0.1; // 0.1 XRGE per transfer
const TOKEN_CREATION_FEE = 100; // 100 XRGE to create a new token
const MINT_FEE = 1; // 1 XRGE per mint operation

export interface NodeOptions {
  listenHost: string;
  listenPort: number;
  peers: PeerEndpoint[];
  mine: boolean;
  dataDir: string;
  chain: ChainConfig;
}

export class L1Node {
  private opts: NodeOptions;
  private nodeId = randomUUID();
  private store: ChainStore;
  private peers: Set<TcpPeer> = new Set();
  private mempool: Map<string, TxV1> = new Map();
  private keys: PQKeypair | null = null;
  private server: net.Server | null = null;

  constructor(opts: NodeOptions) {
    this.opts = opts;
    this.store = new ChainStore(opts.dataDir);
  }

  async start(): Promise<void> {
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Initializing...`);
    await this.store.init();
    this.keys = await this.loadOrCreateKeys();
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Generated PQC keypair (ML-DSA-65)`);

    await this.startServer();
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Listening on ${this.opts.listenHost}:${this.opts.listenPort}`);
    
    await this.connectToSeeds();
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Connected to ${this.peers.size} peer(s)`);

    if (this.opts.mine) {
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Mining enabled (block time: ${this.opts.chain.blockTimeMs}ms)`);
      this.startMiningLoop();
    } else {
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Running as follower (not mining)`);
    }
  }

  private async loadOrCreateKeys(): Promise<PQKeypair> {
    // Minimal: generate fresh per node start for now.
    // Production: persist encrypted keystore + support hot/cold keys.
    return pqcKeygen();
  }

  private async startServer(): Promise<void> {
    this.server = net.createServer((socket) => {
      const peer = new TcpPeer(socket);
      this.attachPeer(peer);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.listenPort, this.opts.listenHost, () => resolve());
    });
  }

  private async connectToSeeds(): Promise<void> {
    for (const ep of this.opts.peers) {
      try {
        const peer = await TcpPeer.connect(ep);
        this.attachPeer(peer);
      } catch {
        // Seed may be offline; ignore.
      }
    }
  }

  private attachPeer(peer: TcpPeer) {
    this.peers.add(peer);
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Peer connected (total: ${this.peers.size})`);
    peer.on("close", () => {
      this.peers.delete(peer);
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Peer disconnected (total: ${this.peers.size})`);
    });
    peer.on("error", () => void 0);
    peer.on("message", (msg) => void this.onMessage(peer, msg));
    void this.sendHello(peer);
  }

  private async sendHello(peer: TcpPeer) {
    const tip = await this.store.getTip();
    const msg: P2PMessage = {
      type: "HELLO",
      nodeId: this.nodeId,
      chainId: this.opts.chain.chainId,
      height: tip.height,
    };
    peer.send(msg);
  }

  private async onMessage(peer: TcpPeer, msg: P2PMessage) {
    switch (msg.type) {
      case "HELLO": {
        if (msg.chainId !== this.opts.chain.chainId) return;
        const tip = await this.store.getTip();
        if (msg.height > tip.height) {
          peer.send({ type: "GET_BLOCK", height: tip.height + 1 });
        } else if (msg.height < tip.height) {
          peer.send({ type: "TIP", height: tip.height, hash: tip.hash });
        }
        return;
      }
      case "GET_TIP": {
        const tip = await this.store.getTip();
        peer.send({ type: "TIP", height: tip.height, hash: tip.hash });
        return;
      }
      case "TIP": {
        const tip = await this.store.getTip();
        if (msg.height > tip.height) {
          peer.send({ type: "GET_BLOCK", height: tip.height + 1 });
        }
        return;
      }
      case "GET_BLOCK": {
        const b = await this.store.getBlock(msg.height);
        if (b) peer.send({ type: "BLOCK", block: b });
        return;
      }
      case "TX": {
        await this.acceptTx(msg.tx);
        // Gossip
        this.broadcast(msg, peer);
        return;
      }
      case "BLOCK": {
        const accepted = await this.acceptBlock(msg.block);
        if (accepted) {
          // Ask for next block from same peer (simple sync)
          peer.send({ type: "GET_BLOCK", height: msg.block.header.height + 1 });
          this.broadcast(msg, peer);
        }
        return;
      }
    }
  }

  private broadcast(msg: P2PMessage, except?: TcpPeer) {
    for (const p of this.peers) {
      if (p === except) continue;
      p.send(msg);
    }
  }

  async submitTransferTx(toPubKeyHex: string, amount: number, fee?: number): Promise<TxV1> {
    if (!this.keys) throw new Error("node not started");
    const tx: TxV1 = {
      version: 1,
      type: "transfer",
      fromPubKey: this.keys.publicKeyHex,
      nonce: Date.now(), // devnet placeholder
      payload: { toPubKeyHex, amount },
      fee: fee ?? BASE_TRANSFER_FEE,
      sig: "",
    };
    const bytes = encodeTxV1(tx);
    tx.sig = await pqcSign(this.keys.secretKeyHex, bytes);
    await this.acceptTx(tx);
    this.broadcast({ type: "TX", tx });
    return tx;
  }

  private async acceptTx(tx: TxV1): Promise<boolean> {
    if (tx.version !== 1) return false;
    const ok = await pqcVerify(tx.fromPubKey, encodeTxV1(tx), tx.sig);
    if (!ok) return false;
    const id = bytesToHex(sha256(encodeTxV1(tx)));
    if (!this.mempool.has(id)) this.mempool.set(id, tx);
    return true;
  }

  private async acceptBlock(block: BlockV1): Promise<boolean> {
    // Basic validation: header linkage + proposer signature + hash match
    if (block.version !== 1 || block.header.version !== 1) return false;
    if (block.header.chainId !== this.opts.chain.chainId) return false;

    const tip = await this.store.getTip();
    if (block.header.height !== tip.height + 1) return false;
    if (block.header.prevHash !== tip.hash) return false;

    const headerBytes = encodeHeaderV1(block.header);
    const sigOk = await pqcVerify(block.header.proposerPubKey, headerBytes, block.proposerSig);
    if (!sigOk) return false;

    const txHash = computeTxHash(block.txs);
    if (txHash !== block.header.txHash) return false;

    const expectedHash = computeBlockHash(headerBytes, block.proposerSig);
    if (expectedHash !== block.hash) return false;

    // Verify tx signatures in parallel for faster validation (devnet: no balances/state yet)
    const txVerifications = block.txs.map(async (tx) => {
      return pqcVerify(tx.fromPubKey, encodeTxV1(tx), tx.sig);
    });
    const txResults = await Promise.all(txVerifications);
    if (txResults.some(ok => !ok)) return false;

    await this.store.appendBlock(block);
    // Remove included txs from mempool
    for (const tx of block.txs) {
      const id = bytesToHex(sha256(encodeTxV1(tx)));
      this.mempool.delete(id);
    }
    return true;
  }

  private startMiningLoop() {
    // Start immediately, then continue with interval
    const tick = async () => {
      const startTime = Date.now();
      try {
        await this.tryProduceBlock();
      } catch {
        // ignore in devnet loop
      } finally {
        // Calculate remaining time to maintain consistent block time
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, this.opts.chain.blockTimeMs - elapsed);
        setTimeout(tick, remaining);
      }
    };
    void tick(); // Start immediately
  }

  private async tryProduceBlock(): Promise<void> {
    if (!this.keys) return;
    const tip = await this.store.getTip();
    const height = tip.height + 1;

    const txs = Array.from(this.mempool.values()).slice(0, 250);
    const txHash = computeTxHash(txs);

    const header = {
      version: 1 as const,
      chainId: this.opts.chain.chainId,
      height,
      time: Date.now(),
      prevHash: tip.hash,
      txHash,
      proposerPubKey: this.keys.publicKeyHex,
    };

    const headerBytes = encodeHeaderV1(header);
    const proposerSig = await pqcSign(this.keys.secretKeyHex, headerBytes);
    const hash = computeBlockHash(headerBytes, proposerSig);

    const block: BlockV1 = {
      version: 1,
      header,
      txs,
      proposerSig,
      hash,
    };

    const accepted = await this.acceptBlock(block);
    if (accepted) {
      const totalFees = txs.reduce((sum, tx) => sum + tx.fee, 0);
      const blockTime = Date.now() - header.time;
      console.log(`[Node ${this.nodeId.slice(0, 8)}] ✅ Mined block #${height} (${txs.length} txs, ${totalFees.toFixed(2)} XRGE fees, ${blockTime}ms, hash: ${hash.slice(0, 16)}...)`);
      this.broadcast({ type: "BLOCK", block });
    } else {
      // Block rejected (shouldn't happen for self-mined, but log if it does)
      console.warn(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  Self-mined block #${height} rejected`);
    }
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  async getChainHeight(): Promise<number> {
    const tip = await this.store.getTip();
    return tip.height;
  }

  getNodeId(): string {
    return this.nodeId;
  }

  isMining(): boolean {
    return this.opts.mine;
  }

  async getAllBlocks(): Promise<BlockV1[]> {
    return this.store.getAllBlocks();
  }

  async getFeeStats(): Promise<{ totalFees: number; lastBlockFees: number }> {
    const blocks = await this.store.getAllBlocks();
    const totalFees = blocks.reduce((sum, block) => {
      return sum + block.txs.reduce((txSum, tx) => txSum + tx.fee, 0);
    }, 0);
    
    const lastBlockFees = blocks.length > 0
      ? blocks[blocks.length - 1].txs.reduce((sum, tx) => sum + tx.fee, 0)
      : 0;

    return { totalFees, lastBlockFees };
  }

  // Public API: Create wallet (generate keypair)
  async createWallet(): Promise<PQKeypair> {
    return pqcKeygen();
  }

  // Public API: Submit transaction from user
  async submitUserTx(
    fromPrivateKeyHex: string,
    fromPublicKeyHex: string,
    toPublicKeyHex: string,
    amount: number,
    fee?: number
  ): Promise<TxV1> {
    const tx: TxV1 = {
      version: 1,
      type: "transfer",
      fromPubKey: fromPublicKeyHex,
      nonce: Date.now(), // TODO: Use proper nonce from state
      payload: { toPubKeyHex: toPublicKeyHex, amount },
      fee: fee ?? BASE_TRANSFER_FEE,
      sig: "",
    };
    const bytes = encodeTxV1(tx);
    tx.sig = await pqcSign(fromPrivateKeyHex, bytes);
    
    // Verify signature before accepting
    const ok = await pqcVerify(fromPublicKeyHex, bytes, tx.sig);
    if (!ok) throw new Error("Invalid signature");
    
    await this.acceptTx(tx);
    this.broadcast({ type: "TX", tx });
    return tx;
  }

  // Public API: Get balance (simple implementation - scans chain)
  async getBalance(publicKeyHex: string): Promise<number> {
    // TODO: Implement proper state/balance tracking
    // For now, scan all blocks to calculate balance
    const blocks = await this.store.getAllBlocks();
    let balance = 0;
    
    for (const block of blocks) {
      for (const tx of block.txs) {
        if (tx.type === "transfer") {
          const payload = tx.payload as { toPubKeyHex?: string; amount?: number };
          // Received
          if (payload.toPubKeyHex === publicKeyHex) {
            balance += payload.amount ?? 0;
          }
          // Sent
          if (tx.fromPubKey === publicKeyHex) {
            balance -= (payload.amount ?? 0) + tx.fee;
          }
        }
      }
    }
    
    return Math.max(0, balance);
  }
}

export function defaultDataDir(nodeName: string): string {
  return path.join(os.homedir(), ".rougechain-devnet", nodeName);
}

