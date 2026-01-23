import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BlockV1, ChainConfig, P2PMessage, TxV1, SlashPayload } from "./types";
import { ChainStore } from "./storage/chain-store";
import { TcpPeer, type PeerEndpoint } from "./p2p/tcp-peer";
import { computeBlockHash, computeTxHash, encodeHeaderV1, encodeTxV1 } from "./codec";
import { pqcKeygen, pqcSign, pqcVerify, type PQKeypair } from "./crypto/pqc";
import { sha256, bytesToHex } from "./crypto/hash";
import { computeSelectionSeed, fetchQrngEntropy, parseStakeAmount, selectProposer, type ProposerSelectionResult } from "./consensus/proposer";

// Fee constants (in XRGE)
// Fees are collected from transactions and go to the block proposer (miner)
// This incentivizes block production and network security
const BASE_TRANSFER_FEE = 0.1; // 0.1 XRGE per transfer
const TOKEN_CREATION_FEE = 100; // 100 XRGE to create a new token
const MINT_FEE = 1; // 1 XRGE per mint operation
const JAIL_BLOCKS = 20; // Devnet/testnet jail duration
const SLASH_DIVISOR = 10n; // 10% of stake

export interface NodeOptions {
  listenHost: string;
  listenPort: number;
  advertiseHost?: string;
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
  private peerEndpoints: Map<TcpPeer, PeerEndpoint> = new Map();
  private knownPeers: Set<string> = new Set();
  private mempool: Map<string, TxV1> = new Map();
  private keys: PQKeypair | null = null;
  private server: net.Server | null = null;
  private lastSelection: { height: number; result: ProposerSelectionResult } | null = null;
  private lastSelectionLogHeight: number | null = null;
  private lastSlashHeight: Map<string, number> = new Map();

  constructor(opts: NodeOptions) {
    this.opts = opts;
    this.store = new ChainStore(opts.dataDir);
  }

  async start(): Promise<void> {
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Initializing...`);
    await this.store.init();
    this.keys = await this.loadOrCreateKeys();
    // Validate keys after generation
    if (this.keys) {
      const secretKeyBytes = this.keys.secretKeyHex.length / 2; // Hex is 2 chars per byte
      const publicKeyBytes = this.keys.publicKeyHex.length / 2;
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Generated PQC keypair (ML-DSA-65)`);
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Secret key: ${this.keys.secretKeyHex.length} hex chars = ${secretKeyBytes} bytes (expected: 4032)`);
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Public key: ${this.keys.publicKeyHex.length} hex chars = ${publicKeyBytes} bytes`);
      if (secretKeyBytes !== 4032) {
        console.error(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  WARNING: Secret key has wrong length! Expected 4032 bytes, got ${secretKeyBytes}`);
      }
    }

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
      await this.connectToPeer(ep);
    }
  }

  private attachPeer(peer: TcpPeer) {
    this.peers.add(peer);
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Peer connected (total: ${this.peers.size})`);
    peer.on("close", () => {
      this.peers.delete(peer);
      this.peerEndpoints.delete(peer);
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
      listenHost: this.getAdvertisedHost(),
      listenPort: this.opts.listenPort,
    };
    peer.send(msg);
  }

  private async onMessage(peer: TcpPeer, msg: P2PMessage) {
    switch (msg.type) {
      case "HELLO": {
        if (msg.chainId !== this.opts.chain.chainId) return;
        const advertised = this.getEndpointFromHello(peer, msg);
        if (advertised) {
          this.knownPeers.add(this.endpointKey(advertised));
          this.peerEndpoints.set(peer, advertised);
          void this.connectToPeer(advertised);
        }
        const tip = await this.store.getTip();
        if (msg.height > tip.height) {
          peer.send({ type: "GET_BLOCK", height: tip.height + 1 });
        } else if (msg.height < tip.height) {
          peer.send({ type: "TIP", height: tip.height, hash: tip.hash });
        }
        peer.send({ type: "PEERS", peers: this.getKnownPeers() });
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
        const accepted = await this.acceptTx(msg.tx);
        if (accepted) {
          // Gossip to other peers
          this.broadcast(msg, peer);
        }
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
      case "PEERS": {
        for (const ep of msg.peers) {
          void this.connectToPeer(ep);
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

  private async connectToPeer(ep: PeerEndpoint): Promise<void> {
    const key = this.endpointKey(ep);
    if (this.isSelfEndpoint(ep)) return;
    if (this.knownPeers.has(key)) {
      if (this.isAlreadyConnected(key)) return;
    }
    try {
      const peer = await TcpPeer.connect(ep);
      this.knownPeers.add(key);
      this.peerEndpoints.set(peer, ep);
      this.attachPeer(peer);
    } catch {
      // Peer may be offline; ignore.
    }
  }

  private getAdvertisedHost(): string {
    if (this.opts.advertiseHost) return this.opts.advertiseHost;
    if (this.opts.listenHost === "0.0.0.0" || this.opts.listenHost === "::") {
      return "127.0.0.1";
    }
    return this.opts.listenHost;
  }

  private getEndpointFromHello(peer: TcpPeer, msg: Extract<P2PMessage, { type: "HELLO" }>): PeerEndpoint | null {
    if (msg.listenHost && msg.listenPort) {
      return { host: msg.listenHost, port: msg.listenPort };
    }
    const remote = peer.getRemoteEndpoint();
    if (!remote || !msg.listenPort) return null;
    return { host: remote.host, port: msg.listenPort };
  }

  private getKnownPeers(): PeerEndpoint[] {
    const peers: PeerEndpoint[] = [];
    for (const key of this.knownPeers) {
      const [host, portRaw] = key.split(":");
      const port = Number(portRaw);
      if (!host || !Number.isFinite(port)) continue;
      peers.push({ host, port });
    }
    return peers;
  }

  private endpointKey(ep: PeerEndpoint): string {
    return `${ep.host}:${ep.port}`;
  }

  private isSelfEndpoint(ep: PeerEndpoint): boolean {
    return ep.port === this.opts.listenPort;
  }

  private isAlreadyConnected(key: string): boolean {
    for (const ep of this.peerEndpoints.values()) {
      if (this.endpointKey(ep) === key) return true;
    }
    return false;
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
    tx.sig = await pqcSign(this.keys.secretKeyHex, bytes, (this.keys as any)._secretKeyBytes);
    await this.acceptTx(tx);
    this.broadcast({ type: "TX", tx });
    return tx;
  }

  private async acceptTx(tx: TxV1): Promise<boolean> {
    if (tx.version !== 1) {
      console.warn(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  Rejected tx: invalid version`);
      return false;
    }
    const ok = await pqcVerify(tx.fromPubKey, encodeTxV1(tx), tx.sig);
    if (!ok) {
      console.warn(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  Rejected tx: invalid signature`);
      return false;
    }
    const id = bytesToHex(sha256(encodeTxV1(tx)));
    if (!this.mempool.has(id)) {
      this.mempool.set(id, tx);
      console.log(`[Node ${this.nodeId.slice(0, 8)}] ✅ Added tx to mempool (id: ${id.slice(0, 16)}..., mempool: ${this.mempool.size})`);
    }
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
    if (!sigOk) {
      await this.maybeSlash(block.header.proposerPubKey, "invalid-proposer-sig", block.header.height);
      return false;
    }

    const txHash = computeTxHash(block.txs);
    if (txHash !== block.header.txHash) return false;

    const expectedHash = computeBlockHash(headerBytes, block.proposerSig);
    if (expectedHash !== block.hash) return false;

    // Verify tx signatures in parallel for faster validation (devnet: no balances/state yet)
    const txVerifications = block.txs.map(async (tx) => {
      return pqcVerify(tx.fromPubKey, encodeTxV1(tx), tx.sig);
    });
    const txResults = await Promise.all(txVerifications);
    if (txResults.some(ok => !ok)) {
      await this.maybeSlash(block.header.proposerPubKey, "invalid-tx-sig", block.header.height);
      return false;
    }

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
        const shouldMine = await this.isSelectedProposer();
        if (shouldMine) {
          await this.tryProduceBlock();
        }
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
    const bypassSelection = await this.shouldBypassSelection();
    const selection = bypassSelection ? null : await this.getProposerSelection(height, tip.hash);
    if (!bypassSelection && (!selection || selection.proposerPubKey !== this.keys.publicKeyHex)) {
      return;
    }

    const txs = Array.from(this.mempool.values()).slice(0, 250);
    if (txs.length > 0) {
      console.log(`[Node ${this.nodeId.slice(0, 8)}] 📦 Including ${txs.length} transaction(s) in block #${height}`);
    }
    const txHash = computeTxHash(txs);

    const header = {
      version: 1 as const,
      chainId: this.opts.chain.chainId,
      height,
      time: Date.now(),
      prevHash: tip.hash,
      txHash,
      proposerPubKey: selection?.proposerPubKey ?? this.keys.publicKeyHex,
    };

    const headerBytes = encodeHeaderV1(header);
    const proposerSig = await pqcSign(this.keys.secretKeyHex, headerBytes, (this.keys as any)._secretKeyBytes);
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

  private async isSelectedProposer(): Promise<boolean> {
    if (!this.keys) return false;
    if (await this.shouldBypassSelection()) {
      console.log(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  No active stake set; bypassing proposer selection for devnet/testnet mining`);
      return true;
    }
    const tip = await this.store.getTip();
    const height = tip.height + 1;
    const selection = await this.getProposerSelection(height, tip.hash);
    if (!selection) return false;
    const isMe = selection.proposerPubKey === this.keys.publicKeyHex;
    if (isMe) {
      console.log(`[Node ${this.nodeId.slice(0, 8)}] 🧬 Selected proposer for height ${height} (total stake: ${selection.totalStake.toString()})`);
    } else if (this.lastSelectionLogHeight !== height) {
      this.lastSelectionLogHeight = height;
      console.log(
        `[Node ${this.nodeId.slice(0, 8)}] ⏳ Waiting for proposer ${selection.proposerPubKey.slice(0, 16)}... at height ${height}`
      );
    }
    return isMe;
  }

  private async getProposerSelection(height: number, prevHash: string): Promise<ProposerSelectionResult | null> {
    if (this.lastSelection && this.lastSelection.height === height) {
      return this.lastSelection.result;
    }
    const stakes = await this.getValidatorStakes();
    const { entropyHex, source } = await fetchQrngEntropy();
    const seed = computeSelectionSeed(entropyHex, prevHash, height);
    const result = selectProposer(stakes, seed, entropyHex, source);
    if (result) {
      this.lastSelection = { height, result };
    }
    return result;
  }

  private async getValidatorStakes(): Promise<Map<string, bigint>> {
    const tip = await this.store.getTip();
    const state = await this.buildValidatorState();
    const stakes = new Map<string, bigint>();
    for (const [pubKey, info] of state.entries()) {
      if (info.jailedUntil > tip.height) continue;
      if (info.stake > 0n) {
        stakes.set(pubKey, info.stake);
      }
    }
    return stakes;
  }

  private async shouldBypassSelection(): Promise<boolean> {
    const chainId = this.opts.chain.chainId;
    if (!chainId.includes("devnet") && !chainId.includes("testnet")) {
      return false;
    }
    const stakes = await this.getValidatorStakes();
    let total = 0n;
    for (const stake of stakes.values()) {
      total += stake;
    }
    // Devnet/testnet convenience:
    // - If there is no stake yet, keep mining so stake txs can land.
    // - If there are no peers, allow solo mining.
    return total === 0n || this.peers.size === 0;
  }

  private parseSlashPayload(payload: unknown): SlashPayload | null {
    if (!payload || typeof payload !== "object") return null;
    const { targetPubKey, amount, reason } = payload as SlashPayload;
    if (typeof targetPubKey !== "string") return null;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
    return { targetPubKey, amount, reason };
  }

  private async buildValidatorState(): Promise<Map<string, { stake: bigint; slashCount: number; jailedUntil: number }>> {
    const blocks = await this.store.getAllBlocks();
    const state = new Map<string, { stake: bigint; slashCount: number; jailedUntil: number }>();
    const ensure = (pubKey: string) => {
      const current = state.get(pubKey);
      if (current) return current;
      const fresh = { stake: 0n, slashCount: 0, jailedUntil: 0 };
      state.set(pubKey, fresh);
      return fresh;
    };

    for (const block of blocks) {
      for (const tx of block.txs) {
        if (tx.type === "stake" || tx.type === "unstake") {
          const amount = parseStakeAmount(tx.payload);
          if (!amount) continue;
          const entry = ensure(tx.fromPubKey);
          if (tx.type === "stake") {
            entry.stake += amount;
          } else {
            entry.stake = entry.stake - amount;
            if (entry.stake < 0n) entry.stake = 0n;
          }
          continue;
        }
        if (tx.type === "slash") {
          const payload = this.parseSlashPayload(tx.payload);
          if (!payload) continue;
          const entry = ensure(payload.targetPubKey);
          entry.stake = entry.stake - BigInt(Math.floor(payload.amount));
          if (entry.stake < 0n) entry.stake = 0n;
          entry.slashCount += 1;
          entry.jailedUntil = Math.max(entry.jailedUntil, block.header.height + JAIL_BLOCKS);
        }
      }
    }
    return state;
  }

  private async maybeSlash(targetPubKey: string, reason: string, height: number): Promise<void> {
    if (!this.keys) return;
    if (this.keys.publicKeyHex === targetPubKey) return;
    const chainId = this.opts.chain.chainId;
    if (!chainId.includes("devnet") && !chainId.includes("testnet")) return;

    const lastHeight = this.lastSlashHeight.get(targetPubKey);
    if (lastHeight === height) return;
    this.lastSlashHeight.set(targetPubKey, height);

    const stakes = await this.getValidatorStakes();
    const current = stakes.get(targetPubKey) ?? 0n;
    if (current <= 0n) return;
    const slashAmount = current / SLASH_DIVISOR;
    const amount = slashAmount > 0n ? slashAmount : 1n;

    const tx: TxV1 = {
      version: 1,
      type: "slash",
      fromPubKey: this.keys.publicKeyHex,
      nonce: Date.now(),
      payload: {
        targetPubKey,
        amount: Number(amount),
        reason,
      },
      fee: 0,
      sig: "",
    };
    const bytes = encodeTxV1(tx);
    tx.sig = await pqcSign(this.keys.secretKeyHex, bytes, (this.keys as any)._secretKeyBytes);
    const ok = await pqcVerify(this.keys.publicKeyHex, bytes, tx.sig);
    if (!ok) return;
    const accepted = await this.acceptTx(tx);
    if (accepted) {
      this.broadcast({ type: "TX", tx });
      console.warn(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  Slashed ${targetPubKey.slice(0, 16)}... for ${reason}`);
    }
  }

  async getValidatorSet(): Promise<{
    validators: { publicKey: string; stake: string; status: string; slashCount: number; jailedUntil: number }[];
    totalStake: string;
  }> {
    const tip = await this.store.getTip();
    const state = await this.buildValidatorState();
    const validators = Array.from(state.entries())
      .filter(([, info]) => info.stake > 0n || info.slashCount > 0)
      .map(([publicKey, info]) => {
        const status = info.jailedUntil > tip.height
          ? "jailed"
          : info.stake > 0n
          ? "active"
          : "inactive";
        return {
          publicKey,
          stake: info.stake.toString(),
          status,
          slashCount: info.slashCount,
          jailedUntil: info.jailedUntil,
        };
      });
    const totalStake = validators.reduce((sum, v) => sum + BigInt(v.stake), 0n);
    return { validators, totalStake: totalStake.toString() };
  }

  async getSelectionInfo(): Promise<{ height: number; result: ProposerSelectionResult | null }> {
    const tip = await this.store.getTip();
    const height = tip.height + 1;
    const result = await this.getProposerSelection(height, tip.hash);
    return { height, result };
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
    
    const accepted = await this.acceptTx(tx);
    if (!accepted) {
      throw new Error("Transaction was not accepted into mempool");
    }
    this.broadcast({ type: "TX", tx });
    console.log(`[Node ${this.nodeId.slice(0, 8)}] 📤 User transaction submitted: ${amount} XRGE from ${fromPublicKeyHex.slice(0, 16)}... to ${toPublicKeyHex.slice(0, 16)}...`);
    return tx;
  }

  // Public API: Submit faucet transaction (devnet/testnet only)
  async submitFaucetTx(
    fromPrivateKeyHex: string,
    fromPublicKeyHex: string,
    toPublicKeyHex: string,
    amount: number
  ): Promise<TxV1> {
    const tx: TxV1 = {
      version: 1,
      type: "transfer",
      fromPubKey: fromPublicKeyHex,
      nonce: Date.now(),
      payload: { toPubKeyHex: toPublicKeyHex, amount, faucet: true },
      fee: 0,
      sig: "",
    };
    const bytes = encodeTxV1(tx);
    tx.sig = await pqcSign(fromPrivateKeyHex, bytes);

    const ok = await pqcVerify(fromPublicKeyHex, bytes, tx.sig);
    if (!ok) throw new Error("Invalid signature");

    const accepted = await this.acceptTx(tx);
    if (!accepted) {
      throw new Error("Transaction was not accepted into mempool");
    }
    this.broadcast({ type: "TX", tx });
    return tx;
  }

  // Public API: Submit stake transaction
  async submitStakeTx(
    fromPrivateKeyHex: string,
    fromPublicKeyHex: string,
    amount: number,
    fee?: number
  ): Promise<TxV1> {
    const tx: TxV1 = {
      version: 1,
      type: "stake",
      fromPubKey: fromPublicKeyHex,
      nonce: Date.now(),
      payload: { amount },
      fee: fee ?? BASE_TRANSFER_FEE,
      sig: "",
    };
    const bytes = encodeTxV1(tx);
    tx.sig = await pqcSign(fromPrivateKeyHex, bytes);
    const ok = await pqcVerify(fromPublicKeyHex, bytes, tx.sig);
    if (!ok) throw new Error("Invalid signature");
    const accepted = await this.acceptTx(tx);
    if (!accepted) {
      throw new Error("Transaction was not accepted into mempool");
    }
    this.broadcast({ type: "TX", tx });
    return tx;
  }

  // Public API: Submit unstake transaction
  async submitUnstakeTx(
    fromPrivateKeyHex: string,
    fromPublicKeyHex: string,
    amount: number,
    fee?: number
  ): Promise<TxV1> {
    const tx: TxV1 = {
      version: 1,
      type: "unstake",
      fromPubKey: fromPublicKeyHex,
      nonce: Date.now(),
      payload: { amount },
      fee: fee ?? BASE_TRANSFER_FEE,
      sig: "",
    };
    const bytes = encodeTxV1(tx);
    tx.sig = await pqcSign(fromPrivateKeyHex, bytes);
    const ok = await pqcVerify(fromPublicKeyHex, bytes, tx.sig);
    if (!ok) throw new Error("Invalid signature");
    const accepted = await this.acceptTx(tx);
    if (!accepted) {
      throw new Error("Transaction was not accepted into mempool");
    }
    this.broadcast({ type: "TX", tx });
    return tx;
  }

  // Public API: Get miner keys (for faucet)
  async getMinerKeys(): Promise<PQKeypair | null> {
    if (!this.keys) return null;
    // Return a copy to avoid any reference issues
    return {
      algorithm: this.keys.algorithm,
      publicKeyHex: this.keys.publicKeyHex,
      secretKeyHex: this.keys.secretKeyHex, // Return as-is, should be a string
    };
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
        if (tx.type === "stake") {
          if (tx.fromPubKey === publicKeyHex) {
            const payload = tx.payload as { amount?: number };
            balance -= (payload.amount ?? 0) + tx.fee;
          }
        }
        if (tx.type === "unstake") {
          if (tx.fromPubKey === publicKeyHex) {
            const payload = tx.payload as { amount?: number };
            balance += (payload.amount ?? 0) - tx.fee;
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

