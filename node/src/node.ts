import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BlockV1, ChainConfig, P2PMessage, TxV1, SlashPayload, VoteMessage, VoteType } from "./types";
import { ChainStore } from "./storage/chain-store";
import { ValidatorStateStore, type ValidatorState } from "./storage/validator-store";
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
  validatorKeys?: {
    publicKeyHex: string;
    secretKeyHex: string;
    algorithm: "ML-DSA-65";
  };
}

export class L1Node {
  private opts: NodeOptions;
  private nodeId = randomUUID();
  private store: ChainStore;
  private validatorStore: ValidatorStateStore;
  private peers: Set<TcpPeer> = new Set();
  private peerEndpoints: Map<TcpPeer, PeerEndpoint> = new Map();
  private knownPeers: Set<string> = new Set();
  private mempool: Map<string, TxV1> = new Map();
  private keys: PQKeypair | null = null;
  private server: net.Server | null = null;
  private lastSelection: { height: number; result: ProposerSelectionResult } | null = null;
  private lastSelectionLogHeight: number | null = null;
  private lastSlashHeight: Map<string, number> = new Map();
  private pendingBlocks: Map<number, BlockV1> = new Map();
  private finalizedHeight = 0;
  private voteState: Map<number, {
    prevote: Map<string, Map<string, VoteMessage>>;
    precommit: Map<string, Map<string, VoteMessage>>;
    byVoter: Map<string, { prevote?: string; precommit?: string }>;
  }> = new Map();
  private voteHistory: Map<number, { prevoteVoters: Set<string>; precommitVoters: Set<string> }> = new Map();

  constructor(opts: NodeOptions) {
    this.opts = opts;
    this.store = new ChainStore(opts.dataDir);
    this.validatorStore = new ValidatorStateStore(opts.dataDir);
  }

  async start(): Promise<void> {
    console.log(`[Node ${this.nodeId.slice(0, 8)}] Initializing...`);
    await this.store.init();
    await this.validatorStore.init();
    const tip = await this.store.getTip();
    await this.syncValidatorState(tip.height);
    this.finalizedHeight = tip.height;
    this.keys = await this.loadOrCreateKeys();
    if (this.opts.validatorKeys) {
      console.log(`[Node ${this.nodeId.slice(0, 8)}] Using provided validator keys`);
    }
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
    if (this.opts.validatorKeys) {
      const cleanPub = this.opts.validatorKeys.publicKeyHex.trim();
      const cleanSecret = this.opts.validatorKeys.secretKeyHex.trim();
      if (!/^[0-9a-fA-F]+$/.test(cleanPub) || !/^[0-9a-fA-F]+$/.test(cleanSecret)) {
        throw new Error("Validator keys must be hex-encoded");
      }
      if (cleanSecret.length !== 8064) {
        throw new Error(`Invalid validator secret key length: ${cleanSecret.length} hex chars (expected 8064)`);
      }
      return {
        algorithm: "ML-DSA-65",
        publicKeyHex: cleanPub,
        secretKeyHex: cleanSecret,
      };
    }
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
      case "VOTE": {
        await this.onVoteMessage(msg.vote);
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

  private getVoteState(height: number) {
    const existing = this.voteState.get(height);
    if (existing) return existing;
    const created = {
      prevote: new Map<string, Map<string, VoteMessage>>(),
      precommit: new Map<string, Map<string, VoteMessage>>(),
      byVoter: new Map<string, { prevote?: string; precommit?: string }>(),
    };
    this.voteState.set(height, created);
    return created;
  }

  private encodeVoteData(vote: Omit<VoteMessage, "signature">): Uint8Array {
    const payload = `${vote.type}|${vote.height}|${vote.round}|${vote.blockHash}|${vote.voterPubKey}`;
    return new TextEncoder().encode(payload);
  }

  private async isActiveValidator(pubKey: string): Promise<boolean> {
    const stakes = await this.getValidatorStakes();
    return (stakes.get(pubKey) ?? 0n) > 0n;
  }

  private async getTotalStake(): Promise<bigint> {
    const stakes = await this.getValidatorStakes();
    let total = 0n;
    for (const stake of stakes.values()) {
      total += stake;
    }
    return total;
  }

  private async getActiveValidatorCount(): Promise<number> {
    const stakes = await this.getValidatorStakes();
    return stakes.size;
  }

  private async getVotePower(height: number, type: VoteType, blockHash: string): Promise<bigint> {
    const state = this.voteState.get(height);
    if (!state) return 0n;
    const bucket = type === "prevote" ? state.prevote : state.precommit;
    const votes = bucket.get(blockHash);
    if (!votes) return 0n;
    const stakes = await this.getValidatorStakes();
    let power = 0n;
    for (const voter of votes.keys()) {
      power += stakes.get(voter) ?? 0n;
    }
    return power;
  }

  private hasEquivocated(state: { prevote?: string; precommit?: string }, type: VoteType, blockHash: string) {
    if (type === "prevote" && state.prevote && state.prevote !== blockHash) return true;
    if (type === "precommit" && state.precommit && state.precommit !== blockHash) return true;
    return false;
  }

  private recordVoteHistory(height: number, vote: VoteMessage) {
    const history = this.voteHistory.get(height) ?? {
      prevoteVoters: new Set<string>(),
      precommitVoters: new Set<string>(),
    };
    if (vote.type === "prevote") {
      history.prevoteVoters.add(vote.voterPubKey);
    } else {
      history.precommitVoters.add(vote.voterPubKey);
    }
    this.voteHistory.set(height, history);
    const pruneBefore = Math.max(0, height - 100);
    for (const entry of this.voteHistory.keys()) {
      if (entry < pruneBefore) {
        this.voteHistory.delete(entry);
      }
    }
  }

  private async maybeCastVote(type: VoteType, block: BlockV1): Promise<void> {
    if (!this.keys) return;
    const isValidator = await this.isActiveValidator(this.keys.publicKeyHex);
    if (!isValidator) return;
    const height = block.header.height;
    const state = this.getVoteState(height);
    const voterState = state.byVoter.get(this.keys.publicKeyHex) ?? {};
    if ((type === "prevote" && voterState.prevote) || (type === "precommit" && voterState.precommit)) {
      return;
    }

    const vote: VoteMessage = {
      type,
      height,
      round: 0,
      blockHash: block.hash,
      voterPubKey: this.keys.publicKeyHex,
      signature: "",
    };
    const bytes = this.encodeVoteData({ ...vote, signature: "" });
    vote.signature = await pqcSign(this.keys.secretKeyHex, bytes, (this.keys as any)._secretKeyBytes);
    this.onVoteMessage(vote);
    this.broadcast({ type: "VOTE", vote });
  }

  private async onVoteMessage(vote: VoteMessage): Promise<void> {
    if (vote.height <= this.finalizedHeight) return;
    if (!await this.isActiveValidator(vote.voterPubKey)) return;

    const bytes = this.encodeVoteData({ ...vote, signature: "" });
    const ok = await pqcVerify(vote.voterPubKey, bytes, vote.signature);
    if (!ok) return;

    const state = this.getVoteState(vote.height);
    const byVoter = state.byVoter.get(vote.voterPubKey) ?? {};
    if (this.hasEquivocated(byVoter, vote.type, vote.blockHash)) {
      await this.maybeSlash(vote.voterPubKey, `equivocation-${vote.type}`, vote.height);
      return;
    }
    if (vote.type === "prevote") {
      byVoter.prevote = vote.blockHash;
    } else {
      byVoter.precommit = vote.blockHash;
    }
    state.byVoter.set(vote.voterPubKey, byVoter);

    const bucket = vote.type === "prevote" ? state.prevote : state.precommit;
    const entries = bucket.get(vote.blockHash) ?? new Map<string, VoteMessage>();
    entries.set(vote.voterPubKey, vote);
    bucket.set(vote.blockHash, entries);
    this.recordVoteHistory(vote.height, vote);

    await this.checkVoteQuorum(vote.height, vote.blockHash);
  }

  private async checkVoteQuorum(height: number, blockHash: string): Promise<void> {
    const totalStake = await this.getTotalStake();
    if (totalStake === 0n) return;
    const prevotePower = await this.getVotePower(height, "prevote", blockHash);
    const precommitPower = await this.getVotePower(height, "precommit", blockHash);

    const hasPrevoteQuorum = prevotePower * 3n > totalStake * 2n;
    if (hasPrevoteQuorum) {
      const pending = this.pendingBlocks.get(height);
      if (pending && pending.hash === blockHash) {
        await this.maybeCastVote("precommit", pending);
      }
    }

    const hasPrecommitQuorum = precommitPower * 3n > totalStake * 2n;
    if (hasPrecommitQuorum) {
      const pending = this.pendingBlocks.get(height);
      if (pending && pending.hash === blockHash) {
        await this.finalizeBlock(pending);
      }
    }
  }

  private async finalizeBlock(block: BlockV1): Promise<void> {
    const tip = await this.store.getTip();
    if (block.header.height !== tip.height + 1) return;

    await this.store.appendBlock(block);
    await this.applyValidatorBlock(block);
    await this.validatorStore.setMetaHeight(block.header.height);
    this.finalizedHeight = Math.max(this.finalizedHeight, block.header.height);
    this.pendingBlocks.delete(block.header.height);
    this.voteState.delete(block.header.height);

    for (const tx of block.txs) {
      const id = bytesToHex(sha256(encodeTxV1(tx)));
      this.mempool.delete(id);
    }
    const totalFees = block.txs.reduce((sum, tx) => sum + tx.fee, 0);
    console.log(
      `[Node ${this.nodeId.slice(0, 8)}] ✅ Finalized block #${block.header.height} (${block.txs.length} txs, ${totalFees.toFixed(2)} XRGE fees, hash: ${block.hash.slice(0, 16)}...)`
    );
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
    if (block.header.height <= this.finalizedHeight) return false;

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

    const totalStake = await this.getTotalStake();
    if (totalStake === 0n) {
      await this.finalizeBlock(block);
      return true;
    }
    const activeValidators = await this.getActiveValidatorCount();
    if (this.peers.size === 0 || activeValidators <= 1) {
      console.warn(`[Node ${this.nodeId.slice(0, 8)}] ⚠️  Finalizing block #${block.header.height} without quorum (devnet/testnet single-node)`);
      await this.finalizeBlock(block);
      return true;
    }

    const existing = this.pendingBlocks.get(block.header.height);
    if (existing && existing.hash !== block.hash) {
      return false;
    }
    this.pendingBlocks.set(block.header.height, block);
    await this.maybeCastVote("prevote", block);
    await this.checkVoteQuorum(block.header.height, block.hash);
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
      console.log(`[Node ${this.nodeId.slice(0, 8)}] 📣 Proposed block #${height} (${txs.length} txs, ${totalFees.toFixed(2)} XRGE fees, ${blockTime}ms, hash: ${hash.slice(0, 16)}...)`);
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
    const state = new Map<string, { stake: bigint; slashCount: number; jailedUntil: number }>();
    const entries = await this.validatorStore.listValidators();
    for (const entry of entries) {
      state.set(entry.publicKey, {
        stake: entry.state.stake,
        slashCount: entry.state.slashCount,
        jailedUntil: entry.state.jailedUntil,
      });
    }
    return state;
  }

  private async syncValidatorState(tipHeight: number): Promise<void> {
    const lastHeight = await this.validatorStore.getMetaHeight();
    if (lastHeight > tipHeight) {
      await this.validatorStore.reset();
      await this.validatorStore.setMetaHeight(-1);
    }
    const startHeight = Math.max(0, (await this.validatorStore.getMetaHeight()) + 1);
    if (startHeight > tipHeight) return;
    await this.store.scanBlocks(async (block) => {
      if (block.header.height < startHeight) return;
      await this.applyValidatorBlock(block);
      await this.validatorStore.setMetaHeight(block.header.height);
    }, startHeight);
  }

  private async applyValidatorBlock(block: BlockV1): Promise<void> {
    for (const tx of block.txs) {
      await this.applyValidatorTx(tx, block.header.height);
    }
  }

  private async applyValidatorTx(tx: TxV1, height: number): Promise<void> {
    const ensure = async (publicKey: string): Promise<ValidatorState> => {
      return (await this.validatorStore.getValidator(publicKey)) ?? {
        stake: 0n,
        slashCount: 0,
        jailedUntil: 0,
        entropyContributions: 0,
      };
    };

    if (tx.type === "stake" || tx.type === "unstake") {
      const amount = parseStakeAmount(tx.payload);
      if (!amount) return;
      const entry = await ensure(tx.fromPubKey);
      if (tx.type === "stake") {
        entry.stake += amount;
      } else {
        entry.stake = entry.stake - amount;
        if (entry.stake < 0n) entry.stake = 0n;
      }
      await this.persistValidatorState(tx.fromPubKey, entry, height);
      return;
    }

    if (tx.type === "slash") {
      const payload = this.parseSlashPayload(tx.payload);
      if (!payload) return;
      const entry = await ensure(payload.targetPubKey);
      entry.stake = entry.stake - BigInt(Math.floor(payload.amount));
      if (entry.stake < 0n) entry.stake = 0n;
      entry.slashCount += 1;
      entry.jailedUntil = Math.max(entry.jailedUntil, height + JAIL_BLOCKS);
      await this.persistValidatorState(payload.targetPubKey, entry, height);
    }
  }

  private async persistValidatorState(publicKey: string, state: ValidatorState, height: number): Promise<void> {
    const shouldKeep = state.stake > 0n || state.slashCount > 0 || state.jailedUntil > height;
    if (!shouldKeep) {
      await this.validatorStore.deleteValidator(publicKey);
      return;
    }
    await this.validatorStore.setValidator(publicKey, state);
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
    validators: { publicKey: string; stake: string; status: string; slashCount: number; jailedUntil: number; entropyContributions: number }[];
    totalStake: string;
  }> {
    const tip = await this.store.getTip();
    const entries = await this.validatorStore.listValidators();
    const validators = entries
      .filter((entry) => entry.state.stake > 0n || entry.state.slashCount > 0)
      .map(({ publicKey, state }) => {
        const status = state.jailedUntil > tip.height
          ? "jailed"
          : state.stake > 0n
          ? "active"
          : "inactive";
        return {
          publicKey,
          stake: state.stake.toString(),
          status,
          slashCount: state.slashCount,
          jailedUntil: state.jailedUntil,
          entropyContributions: state.entropyContributions ?? 0,
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

  async getFinalityStatus(): Promise<{
    finalizedHeight: number;
    tipHeight: number;
    totalStake: string;
    quorumStake: string;
  }> {
    const tip = await this.store.getTip();
    const totalStake = await this.getTotalStake();
    const quorumStake = totalStake === 0n ? 0n : (totalStake * 2n) / 3n + 1n;
    return {
      finalizedHeight: this.finalizedHeight,
      tipHeight: tip.height,
      totalStake: totalStake.toString(),
      quorumStake: quorumStake.toString(),
    };
  }

  async getVoteSummary(height: number): Promise<{
    height: number;
    totalStake: string;
    quorumStake: string;
    prevote: Array<{ blockHash: string; voters: number; stake: string }>;
    precommit: Array<{ blockHash: string; voters: number; stake: string }>;
  }> {
    const totalStake = await this.getTotalStake();
    const quorumStake = totalStake === 0n ? 0n : (totalStake * 2n) / 3n + 1n;
    const state = this.voteState.get(height);
    const stakes = await this.getValidatorStakes();

    const summarize = (bucket: Map<string, Map<string, VoteMessage>>) => {
      return Array.from(bucket.entries()).map(([blockHash, votes]) => {
        let stake = 0n;
        for (const voter of votes.keys()) {
          stake += stakes.get(voter) ?? 0n;
        }
        return {
          blockHash,
          voters: votes.size,
          stake: stake.toString(),
        };
      });
    };

    return {
      height,
      totalStake: totalStake.toString(),
      quorumStake: quorumStake.toString(),
      prevote: summarize(state?.prevote ?? new Map()),
      precommit: summarize(state?.precommit ?? new Map()),
    };
  }

  async getValidatorVoteStats(): Promise<{
    totalHeights: number;
    validators: Array<{
      publicKey: string;
      prevoteParticipation: number;
      precommitParticipation: number;
      lastSeenHeight: number | null;
    }>;
  }> {
    const heights = Array.from(this.voteHistory.keys()).sort((a, b) => a - b);
    const totalHeights = heights.length;
    const stats = new Map<string, { prevotes: number; precommits: number; lastSeen: number | null }>();

    for (const height of heights) {
      const entry = this.voteHistory.get(height);
      if (!entry) continue;
      for (const voter of entry.prevoteVoters) {
        const current = stats.get(voter) ?? { prevotes: 0, precommits: 0, lastSeen: null };
        current.prevotes += 1;
        current.lastSeen = height;
        stats.set(voter, current);
      }
      for (const voter of entry.precommitVoters) {
        const current = stats.get(voter) ?? { prevotes: 0, precommits: 0, lastSeen: null };
        current.precommits += 1;
        current.lastSeen = height;
        stats.set(voter, current);
      }
    }

    const validators = Array.from(stats.entries()).map(([publicKey, value]) => ({
      publicKey,
      prevoteParticipation: totalHeights > 0 ? (value.prevotes / totalHeights) * 100 : 0,
      precommitParticipation: totalHeights > 0 ? (value.precommits / totalHeights) * 100 : 0,
      lastSeenHeight: value.lastSeen,
    }));

    return { totalHeights, validators };
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

  // Public API: Submit validator vote (optional HTTP entrypoint)
  async submitVote(vote: VoteMessage): Promise<void> {
    await this.onVoteMessage(vote);
    this.broadcast({ type: "VOTE", vote });
  }

  // Public API: Submit entropy contribution (metadata only)
  async submitEntropyContribution(publicKey: string): Promise<void> {
    const current = (await this.validatorStore.getValidator(publicKey)) ?? {
      stake: 0n,
      slashCount: 0,
      jailedUntil: 0,
      entropyContributions: 0,
    };
    current.entropyContributions += 1;
    await this.validatorStore.setValidator(publicKey, current);
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

