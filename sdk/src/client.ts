import {
  createSignedTransfer,
  createSignedTokenCreation,
  createSignedSwap,
  createSignedPoolCreation,
  createSignedAddLiquidity,
  createSignedRemoveLiquidity,
  createSignedStake,
  createSignedUnstake,
  createSignedFaucetRequest,
  createSignedBurn,
  createSignedBridgeWithdraw,
  createSignedNftCreateCollection,
  createSignedNftMint,
  createSignedNftBatchMint,
  createSignedNftTransfer,
  createSignedNftBurn,
  createSignedNftLock,
  createSignedNftFreezeCollection,
  createSignedTokenMetadataUpdate,
  createSignedTokenMetadataClaim,
  createSignedShield,
  createSignedShieldedTransfer,
  createSignedUnshield,
  createSignedPushRegister,
  createSignedPushUnregister,
  signRequest,
} from "./signer.js";
import type {
  WalletKeys,
  ApiResponse,
  SignedTransaction,
  NodeStats,
  Block,
  TokenMetadata,
  BalanceResponse,
  LiquidityPool,
  SwapQuote,
  PoolEvent,
  PoolStats,
  NftCollection,
  NftToken,
  Validator,
  BridgeConfig,
  BridgeWithdrawal,
  XrgeBridgeConfig,
  TransferParams,
  CreateTokenParams,
  SwapParams,
  CreatePoolParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
  StakeParams,
  CreateNftCollectionParams,
  MintNftParams,
  BatchMintNftParams,
  TransferNftParams,
  BurnNftParams,
  LockNftParams,
  FreezeCollectionParams,
  BridgeWithdrawParams,
  BridgeClaimParams,
  XrgeBridgeClaimParams,
  XrgeBridgeWithdrawParams,
  SwapQuoteParams,
  TokenMetadataUpdateParams,
  TokenHolder,
  NameEntry,
  ResolvedName,
  MailMessage,
  SendMailParams,
  MessengerWallet,
  MessengerConversation,
  MessengerMessage,
  PriceSnapshot,
  ShieldParams,
  ShieldedTransferParams,
  UnshieldParams,
  ShieldedStats,
  RollupStatus,
  RollupBatchResult,
  RollupSubmitParams,
  RollupSubmitResult,
  MintTokenParams,
  FeeInfo,
  FinalityProof,
} from "./types.js";
import { createShieldedNote, type ShieldedNote } from "./shielded.js";

type FetchFn = typeof globalThis.fetch;

export interface RougeChainOptions {
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: FetchFn;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
}

export class RougeChain {
  /** @internal */ readonly baseUrl: string;
  /** @internal */ readonly fetchFn: FetchFn;
  /** @internal */ readonly headers: Record<string, string>;

  public readonly nft: NftClient;
  public readonly dex: DexClient;
  public readonly bridge: BridgeClient;
  public readonly mail: MailClient;
  public readonly messenger: MessengerClient;
  public readonly shielded: ShieldedClient;

  constructor(baseUrl: string, options: RougeChainOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) {
      this.headers["X-API-Key"] = options.apiKey;
    }

    this.nft = new NftClient(this);
    this.dex = new DexClient(this);
    this.bridge = new BridgeClient(this);
    this.mail = new MailClient(this);
    this.messenger = new MessengerClient(this);
    this.shielded = new ShieldedClient(this);
  }

  // ===== Internal helpers =====

  /** @internal */
  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  /** @internal */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `POST ${path} failed: ${res.status} ${res.statusText} ${text}`
      );
    }
    return res.json() as Promise<T>;
  }

  /** @internal */
  async submitTx(
    endpoint: string,
    signedTx: SignedTransaction
  ): Promise<ApiResponse> {
    try {
      const raw = await this.post<Record<string, unknown>>(endpoint, signedTx);
      const { success, error, ...rest } = raw;
      return {
        success: success as boolean,
        error: error as string | undefined,
        data: Object.keys(rest).length > 0 ? rest : undefined,
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ===== Stats & Health =====

  async getStats(): Promise<NodeStats> {
    return this.get<NodeStats>("/stats");
  }

  async getHealth(): Promise<{ status: string; chain_id: string; height: number }> {
    return this.get("/health");
  }

  // ===== Blocks =====

  async getBlocks(opts: { limit?: number } = {}): Promise<Block[]> {
    const q = opts.limit ? `?limit=${opts.limit}` : "";
    const data = await this.get<{ blocks: Block[] }>(`/blocks${q}`);
    return data.blocks;
  }

  async getBlocksSummary(
    range: "1h" | "24h" | "7d" = "24h"
  ): Promise<unknown> {
    return this.get(`/blocks/summary?range=${range}`);
  }

  // ===== Balance =====

  async getBalance(publicKey: string): Promise<BalanceResponse> {
    return this.get<BalanceResponse>(`/balance/${publicKey}`);
  }

  async getTokenBalance(publicKey: string, token: string): Promise<number> {
    const data = await this.get<{ balance: number }>(
      `/balance/${publicKey}/${token}`
    );
    return data.balance;
  }

  // ===== Transactions =====

  async getTransactions(
    opts: { limit?: number; offset?: number } = {}
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    const q = params.toString();
    return this.get(`/txs${q ? `?${q}` : ""}`);
  }

  // ===== Tokens =====

  async getTokens(): Promise<TokenMetadata[]> {
    const data = await this.get<{ tokens: TokenMetadata[]; success: boolean }>(
      "/tokens"
    );
    return data.tokens;
  }

  async getTokenMetadata(symbol: string): Promise<TokenMetadata> {
    return this.get<TokenMetadata>(`/token/${symbol}/metadata`);
  }

  async getTokenHolders(
    symbol: string
  ): Promise<TokenHolder[]> {
    const data = await this.get<{ holders: TokenHolder[] }>(
      `/token/${symbol}/holders`
    );
    return data.holders;
  }

  async getTokenTransactions(
    symbol: string
  ): Promise<unknown> {
    return this.get(`/token/${symbol}/transactions`);
  }

  // ===== Validators =====

  async getValidators(): Promise<Validator[]> {
    const data = await this.get<{ validators: Validator[] }>("/validators");
    return data.validators;
  }

  async getValidatorStats(): Promise<unknown> {
    return this.get("/validators/stats");
  }

  async getFinality(): Promise<{
    finalized_height: number;
    tip_height: number;
    total_stake: number;
    finalized_stake: number;
  }> {
    return this.get("/finality");
  }

  // ===== EIP-1559 Fee Info =====

  /** Get current EIP-1559 fee information including base fee and suggestions. */
  async getFeeInfo(): Promise<FeeInfo> {
    return this.get<FeeInfo>("/fee");
  }

  // ===== BFT Finality Proofs =====

  /**
   * Get a BFT finality proof for a specific block height.
   * Returns the aggregated precommit votes that prove ≥2/3 validator stake agreed.
   */
  async getFinalityProof(height: number): Promise<{
    success: boolean;
    proof?: FinalityProof;
    error?: string;
  }> {
    return this.get(`/finality/${height}`);
  }

  // ===== Peers =====

  async getPeers(): Promise<string[]> {
    const data = await this.get<{ peers: string[] }>("/peers");
    return data.peers;
  }

  // ===== Burned =====

  async getBurnedTokens(): Promise<{
    burned: Record<string, number>;
    total_xrge_burned: number;
  }> {
    return this.get("/burned");
  }

  // ===== Address Resolution =====

  /**
   * Resolve a rouge1… address to its public key, or a public key to its rouge1 address.
   * Uses the persistent on-chain address index for O(1) lookups.
   */
  async resolveAddress(input: string): Promise<{
    success: boolean;
    address?: string;
    publicKey?: string;
    balance?: number;
    error?: string;
  }> {
    return this.get(`/resolve/${encodeURIComponent(input)}`);
  }

  // ===== Nonce =====

  /** Get the current sequential nonce for an account. */
  async getNonce(publicKey: string): Promise<{
    nonce: number;
    next_nonce: number;
  }> {
    return this.get(`/account/${encodeURIComponent(publicKey)}/nonce`);
  }

  // ===== Push Notifications (PQC-signed) =====

  /** Register an Expo push token — signed by wallet to prove ownership. */
  async registerPushToken(wallet: WalletKeys, pushToken: string, platform = "expo"): Promise<ApiResponse> {
    const tx = createSignedPushRegister(wallet, pushToken, platform);
    return this.submitTx("/push/register", tx);
  }

  /** Unregister push notifications — signed by wallet to prove ownership. */
  async unregisterPushToken(wallet: WalletKeys): Promise<ApiResponse> {
    const tx = createSignedPushUnregister(wallet);
    return this.submitTx("/push/unregister", tx);
  }

  // ===== Write operations =====

  async transfer(
    wallet: WalletKeys,
    params: TransferParams
  ): Promise<ApiResponse> {
    const tx = createSignedTransfer(
      wallet,
      params.to,
      params.amount,
      params.fee,
      params.token
    );
    return this.submitTx("/v2/transfer", tx);
  }

  async createToken(
    wallet: WalletKeys,
    params: CreateTokenParams
  ): Promise<ApiResponse> {
    const tx = createSignedTokenCreation(
      wallet,
      params.name,
      params.symbol,
      params.totalSupply,
      params.fee,
      params.image
    );
    return this.submitTx("/v2/token/create", tx);
  }

  async stake(
    wallet: WalletKeys,
    params: StakeParams
  ): Promise<ApiResponse> {
    const tx = createSignedStake(wallet, params.amount, params.fee);
    return this.submitTx("/v2/stake", tx);
  }

  async unstake(
    wallet: WalletKeys,
    params: StakeParams
  ): Promise<ApiResponse> {
    const tx = createSignedUnstake(wallet, params.amount, params.fee);
    return this.submitTx("/v2/unstake", tx);
  }

  async faucet(wallet: WalletKeys): Promise<ApiResponse> {
    const tx = createSignedFaucetRequest(wallet);
    return this.submitTx("/v2/faucet", tx);
  }

  async burn(
    wallet: WalletKeys,
    amount: number,
    fee = 1,
    token = "XRGE"
  ): Promise<ApiResponse> {
    const tx = createSignedBurn(wallet, amount, fee, token);
    return this.submitTx("/v2/transfer", tx);
  }

  async updateTokenMetadata(
    wallet: WalletKeys,
    params: TokenMetadataUpdateParams
  ): Promise<ApiResponse> {
    const tx = createSignedTokenMetadataUpdate(wallet, params.symbol, {
      image: params.image,
      description: params.description,
      website: params.website,
      twitter: params.twitter,
      discord: params.discord,
    });
    return this.submitTx("/v2/token/metadata/update", tx);
  }

  async claimTokenMetadata(
    wallet: WalletKeys,
    tokenSymbol: string
  ): Promise<ApiResponse> {
    const tx = createSignedTokenMetadataClaim(wallet, tokenSymbol);
    return this.submitTx("/v2/token/metadata/claim", tx);
  }

  /**
   * Mint additional tokens for a mintable token (creator only).
   * The token must have been created with `mintable: true`.
   */
  async mintTokens(
    wallet: WalletKeys,
    params: MintTokenParams
  ): Promise<ApiResponse> {
    return this.post("/v2/token/mint", {
      public_key: wallet.publicKey,
      symbol: params.symbol,
      amount: params.amount,
      fee: params.fee ?? 1,
      signature: "", // Will be signed server-side via PQC verification
    });
  }

  // ===== WebSocket =====

  /**
   * Connect to the node's WebSocket and optionally subscribe to specific topics.
   * Topics: "blocks", "transactions", "stats", "account:<pubkey>", "token:<symbol>"
   *
   * @example
   * const ws = client.connectWebSocket(["blocks", "account:abc123"]);
   * ws.onmessage = (e) => console.log(JSON.parse(e.data));
   */
  connectWebSocket(topics?: string[]): WebSocket {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    if (topics && topics.length > 0) {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ subscribe: topics }));
      });
    }
    return ws;
  }

  // ===== Rollup =====

  /** Get the current rollup accumulator status. */
  async getRollupStatus(): Promise<RollupStatus> {
    const data = await this.get<{ rollup: RollupStatus }>("/v2/rollup/status");
    return data.rollup;
  }

  /** Submit a transfer into the rollup batch accumulator. */
  async submitRollupTransfer(
    params: RollupSubmitParams
  ): Promise<RollupSubmitResult> {
    return this.post<RollupSubmitResult>("/v2/rollup/submit", params);
  }

  /** Get the result of a completed rollup batch by ID. */
  async getRollupBatch(batchId: number): Promise<RollupBatchResult> {
    const data = await this.get<{ batch: RollupBatchResult }>(
      `/v2/rollup/batch/${batchId}`
    );
    return data.batch;
  }
}

// ===== NFT Sub-client =====

class NftClient {
  constructor(private readonly rc: RougeChain) {}

  // Queries

  async getCollections(): Promise<NftCollection[]> {
    const data = await this.rc.get<{ collections: NftCollection[] }>(
      "/nft/collections"
    );
    return data.collections;
  }

  async getCollection(collectionId: string): Promise<NftCollection> {
    return this.rc.get<NftCollection>(
      `/nft/collection/${encodeURIComponent(collectionId)}`
    );
  }

  /**
   * Poll until a collection exists on-chain (i.e. the create tx has been mined).
   * Useful after `createCollection` since the tx goes to the mempool first.
   * @returns the collection once found, or throws after the timeout.
   */
  async waitForCollection(
    collectionId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<NftCollection> {
    const timeout = opts.timeoutMs ?? 30_000;
    const poll = opts.pollMs ?? 1_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        return await this.getCollection(collectionId);
      } catch {
        await new Promise((r) => setTimeout(r, poll));
      }
    }
    throw new Error(
      `Collection "${collectionId}" not found after ${timeout}ms — the create transaction may not have been mined yet`
    );
  }

  async getTokens(
    collectionId: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<{ tokens: NftToken[]; total: number }> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const q = params.toString();
    return this.rc.get(
      `/nft/collection/${encodeURIComponent(collectionId)}/tokens${q ? `?${q}` : ""}`
    );
  }

  async getToken(
    collectionId: string,
    tokenId: number
  ): Promise<NftToken> {
    return this.rc.get<NftToken>(
      `/nft/token/${encodeURIComponent(collectionId)}/${tokenId}`
    );
  }

  async getByOwner(pubkey: string): Promise<NftToken[]> {
    const data = await this.rc.get<{ nfts: NftToken[] }>(
      `/nft/owner/${encodeURIComponent(pubkey)}`
    );
    return data.nfts;
  }

  // Write operations

  async createCollection(
    wallet: WalletKeys,
    params: CreateNftCollectionParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftCreateCollection(wallet, params.symbol, params.name, {
      maxSupply: params.maxSupply,
      royaltyBps: params.royaltyBps,
      image: params.image,
      description: params.description,
    });
    return this.rc.submitTx("/v2/nft/collection/create", tx);
  }

  async mint(
    wallet: WalletKeys,
    params: MintNftParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftMint(wallet, params.collectionId, params.name, {
      metadataUri: params.metadataUri,
      attributes: params.attributes,
    });
    return this.rc.submitTx("/v2/nft/mint", tx);
  }

  async batchMint(
    wallet: WalletKeys,
    params: BatchMintNftParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftBatchMint(
      wallet,
      params.collectionId,
      params.names,
      { uris: params.uris, batchAttributes: params.batchAttributes }
    );
    return this.rc.submitTx("/v2/nft/batch-mint", tx);
  }

  async transfer(
    wallet: WalletKeys,
    params: TransferNftParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftTransfer(
      wallet,
      params.collectionId,
      params.tokenId,
      params.to,
      params.salePrice
    );
    return this.rc.submitTx("/v2/nft/transfer", tx);
  }

  async burn(
    wallet: WalletKeys,
    params: BurnNftParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftBurn(wallet, params.collectionId, params.tokenId);
    return this.rc.submitTx("/v2/nft/burn", tx);
  }

  async lock(
    wallet: WalletKeys,
    params: LockNftParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftLock(
      wallet,
      params.collectionId,
      params.tokenId,
      params.locked
    );
    return this.rc.submitTx("/v2/nft/lock", tx);
  }

  async freezeCollection(
    wallet: WalletKeys,
    params: FreezeCollectionParams
  ): Promise<ApiResponse> {
    const tx = createSignedNftFreezeCollection(
      wallet,
      params.collectionId,
      params.frozen
    );
    return this.rc.submitTx("/v2/nft/freeze-collection", tx);
  }
}

// ===== DEX Sub-client =====

class DexClient {
  constructor(private readonly rc: RougeChain) {}

  // Queries

  async getPools(): Promise<LiquidityPool[]> {
    const data = await this.rc.get<{ pools: LiquidityPool[] }>("/pools");
    return data.pools;
  }

  async getPool(poolId: string): Promise<LiquidityPool> {
    return this.rc.get<LiquidityPool>(`/pool/${poolId}`);
  }

  async getPoolEvents(poolId: string): Promise<PoolEvent[]> {
    const data = await this.rc.get<{ events: PoolEvent[] }>(
      `/pool/${poolId}/events`
    );
    return data.events;
  }

  async getPriceHistory(poolId: string): Promise<PriceSnapshot[]> {
    const data = await this.rc.get<{ prices: PriceSnapshot[] }>(
      `/pool/${poolId}/prices`
    );
    return data.prices;
  }

  async getPoolStats(poolId: string): Promise<PoolStats> {
    return this.rc.get<PoolStats>(`/pool/${poolId}/stats`);
  }

  async quote(params: SwapQuoteParams): Promise<SwapQuote> {
    return this.rc.post<SwapQuote>("/swap/quote", {
      pool_id: params.poolId,
      token_in: params.tokenIn,
      token_out: params.tokenOut,
      amount_in: params.amountIn,
    });
  }

  // Write operations

  async swap(
    wallet: WalletKeys,
    params: SwapParams
  ): Promise<ApiResponse> {
    const tx = createSignedSwap(
      wallet,
      params.tokenIn,
      params.tokenOut,
      params.amountIn,
      params.minAmountOut
    );
    return this.rc.submitTx("/v2/swap/execute", tx);
  }

  async createPool(
    wallet: WalletKeys,
    params: CreatePoolParams
  ): Promise<ApiResponse> {
    const tx = createSignedPoolCreation(
      wallet,
      params.tokenA,
      params.tokenB,
      params.amountA,
      params.amountB
    );
    return this.rc.submitTx("/v2/pool/create", tx);
  }

  async addLiquidity(
    wallet: WalletKeys,
    params: AddLiquidityParams
  ): Promise<ApiResponse> {
    const tx = createSignedAddLiquidity(
      wallet,
      params.poolId,
      params.amountA,
      params.amountB
    );
    return this.rc.submitTx("/v2/pool/add-liquidity", tx);
  }

  async removeLiquidity(
    wallet: WalletKeys,
    params: RemoveLiquidityParams
  ): Promise<ApiResponse> {
    const tx = createSignedRemoveLiquidity(wallet, params.poolId, params.lpAmount);
    return this.rc.submitTx("/v2/pool/remove-liquidity", tx);
  }
}

// ===== Bridge Sub-client =====

class BridgeClient {
  constructor(private readonly rc: RougeChain) {}

  async getConfig(): Promise<BridgeConfig> {
    try {
      const data = await this.rc.get<Record<string, unknown>>("/bridge/config");
      return {
        enabled: data.enabled === true,
        custodyAddress: data.custodyAddress as string | undefined,
        chainId: (data.chainId as number) ?? 84532,
        supportedTokens: data.supportedTokens as string[] | undefined,
      };
    } catch {
      return { enabled: false, chainId: 84532 };
    }
  }

  async getWithdrawals(): Promise<BridgeWithdrawal[]> {
    const data = await this.rc.get<{ withdrawals: BridgeWithdrawal[] }>(
      "/bridge/withdrawals"
    );
    return data.withdrawals;
  }

  /** Withdraw qETH/qUSDC — signed client-side, private key never sent to server */
  async withdraw(
    wallet: WalletKeys,
    params: BridgeWithdrawParams
  ): Promise<ApiResponse> {
    try {
      const tokenSymbol = params.tokenSymbol ?? "qETH";
      const signed = createSignedBridgeWithdraw(
        wallet,
        params.amount,
        params.evmAddress,
        tokenSymbol,
        params.fee
      );
      const data = await this.rc.post<Record<string, unknown>>(
        "/bridge/withdraw",
        {
          fromPublicKey: wallet.publicKey,
          amountUnits: params.amount,
          evmAddress: signed.payload.evmAddress,
          signature: signed.signature,
          payload: signed.payload,
        }
      );
      return {
        success: data.success === true,
        error: data.error as string | undefined,
        data,
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Claim qETH or qUSDC after depositing on Base Sepolia */
  async claim(params: BridgeClaimParams): Promise<ApiResponse> {
    try {
      const data = await this.rc.post<Record<string, unknown>>(
        "/bridge/claim",
        {
          evmTxHash: params.evmTxHash.startsWith("0x")
            ? params.evmTxHash
            : `0x${params.evmTxHash}`,
          evmAddress: params.evmAddress.startsWith("0x")
            ? params.evmAddress
            : `0x${params.evmAddress}`,
          evmSignature: params.evmSignature,
          recipientRougechainPubkey: params.recipientPubkey,
          token: params.token ?? "ETH",
        }
      );
      return {
        success: data.success === true,
        error: data.error as string | undefined,
        data,
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ── XRGE Bridge ──

  async getXrgeConfig(): Promise<XrgeBridgeConfig> {
    try {
      const data = await this.rc.get<Record<string, unknown>>("/bridge/xrge/config");
      return {
        enabled: data.enabled === true,
        vaultAddress: data.vaultAddress as string | undefined,
        tokenAddress: data.tokenAddress as string | undefined,
        chainId: (data.chainId as number) ?? 84532,
      };
    } catch {
      return { enabled: false, chainId: 84532 };
    }
  }

  async claimXrge(params: XrgeBridgeClaimParams): Promise<ApiResponse> {
    try {
      const data = await this.rc.post<Record<string, unknown>>(
        "/bridge/xrge/claim",
        {
          evmTxHash: params.evmTxHash.startsWith("0x")
            ? params.evmTxHash
            : `0x${params.evmTxHash}`,
          evmAddress: params.evmAddress.startsWith("0x")
            ? params.evmAddress
            : `0x${params.evmAddress}`,
          amount: params.amount,
          recipientRougechainPubkey: params.recipientPubkey,
        }
      );
      return {
        success: data.success === true,
        error: data.error as string | undefined,
        data,
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async withdrawXrge(
    wallet: WalletKeys,
    params: XrgeBridgeWithdrawParams
  ): Promise<ApiResponse> {
    try {
      const signed = createSignedBridgeWithdraw(
        wallet,
        params.amount,
        params.evmAddress,
        "XRGE",
        0.1
      );
      const data = await this.rc.post<Record<string, unknown>>(
        "/bridge/xrge/withdraw",
        {
          fromPublicKey: wallet.publicKey,
          amount: params.amount,
          evmAddress: signed.payload.evmAddress,
          signature: signed.signature,
          payload: signed.payload,
        }
      );
      return {
        success: data.success === true,
        error: data.error as string | undefined,
        data,
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getXrgeWithdrawals(): Promise<BridgeWithdrawal[]> {
    try {
      const data = await this.rc.get<{ withdrawals: BridgeWithdrawal[] }>(
        "/bridge/xrge/withdrawals"
      );
      return data.withdrawals;
    } catch {
      return [];
    }
  }
}

// ===== Mail Sub-client =====

class MailClient {
  constructor(private readonly rc: RougeChain) {}

  // --- Name Registry (signed) ---

  async registerName(wallet: WalletKeys, name: string, walletId: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { name, walletId });
    return this.rc.submitTx("/v2/names/register", signed);
  }

  async resolveName(name: string): Promise<ResolvedName | null> {
    try {
      const data = await this.rc.get<{ success: boolean; entry?: NameEntry; wallet?: ResolvedName["wallet"] }>(
        `/names/resolve/${encodeURIComponent(name.toLowerCase())}`
      );
      if (!data.success) return null;
      return { entry: data.entry, wallet: data.wallet };
    } catch {
      return null;
    }
  }

  async reverseLookup(walletId: string): Promise<string | null> {
    try {
      const data = await this.rc.get<{ name?: string }>(
        `/names/reverse/${encodeURIComponent(walletId)}`
      );
      return data.name || null;
    } catch {
      return null;
    }
  }

  async releaseName(wallet: WalletKeys, name: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { name });
    return this.rc.submitTx("/v2/names/release", signed);
  }

  // --- Mail (signed) ---

  async send(wallet: WalletKeys, params: SendMailParams): Promise<ApiResponse> {
    const signed = signRequest(wallet, {
      fromWalletId: params.from,
      toWalletIds: [params.to],
      subjectEncrypted: params.encrypted_subject,
      bodyEncrypted: params.encrypted_body,
      contentSignature: params.body,
      replyToId: params.reply_to_id,
      hasAttachment: false,
    });
    return this.rc.submitTx("/v2/mail/send", signed);
  }

  async getInbox(wallet: WalletKeys): Promise<MailMessage[]> {
    const signed = signRequest(wallet, { folder: "inbox" });
    try {
      const data = await this.rc.post<{ messages: MailMessage[] }>("/v2/mail/folder", signed);
      return data.messages ?? [];
    } catch { return []; }
  }

  async getSent(wallet: WalletKeys): Promise<MailMessage[]> {
    const signed = signRequest(wallet, { folder: "sent" });
    try {
      const data = await this.rc.post<{ messages: MailMessage[] }>("/v2/mail/folder", signed);
      return data.messages ?? [];
    } catch { return []; }
  }

  async getTrash(wallet: WalletKeys): Promise<MailMessage[]> {
    const signed = signRequest(wallet, { folder: "trash" });
    try {
      const data = await this.rc.post<{ messages: MailMessage[] }>("/v2/mail/folder", signed);
      return data.messages ?? [];
    } catch { return []; }
  }

  async getMessage(wallet: WalletKeys, messageId: string): Promise<MailMessage | null> {
    const signed = signRequest(wallet, { messageId });
    try {
      const data = await this.rc.post<{ success: boolean; message: MailMessage }>("/v2/mail/message", signed);
      return data.message ?? null;
    } catch { return null; }
  }

  async move(wallet: WalletKeys, messageId: string, folder: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { messageId, folder });
    return this.rc.submitTx("/v2/mail/move", signed);
  }

  async markRead(wallet: WalletKeys, messageId: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { messageId });
    return this.rc.submitTx("/v2/mail/read", signed);
  }

  async delete(wallet: WalletKeys, messageId: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { messageId });
    return this.rc.submitTx("/v2/mail/delete", signed);
  }
}

// ===== Messenger Sub-client =====

class MessengerClient {
  constructor(private readonly rc: RougeChain) {}

  async getWallets(): Promise<MessengerWallet[]> {
    const data = await this.rc.get<{ wallets: MessengerWallet[] }>("/messenger/wallets");
    return data.wallets ?? [];
  }

  async registerWallet(wallet: WalletKeys, opts: {
    id: string;
    displayName: string;
    signingPublicKey: string;
    encryptionPublicKey: string;
    discoverable?: boolean;
  }): Promise<ApiResponse> {
    const signed = signRequest(wallet, {
      id: opts.id,
      displayName: opts.displayName,
      signingPublicKey: opts.signingPublicKey,
      encryptionPublicKey: opts.encryptionPublicKey,
      discoverable: opts.discoverable ?? true,
    });
    return this.rc.submitTx("/v2/messenger/wallets/register", signed);
  }

  async getConversations(wallet: WalletKeys): Promise<MessengerConversation[]> {
    const signed = signRequest(wallet, {});
    try {
      const data = await this.rc.post<{ conversations: MessengerConversation[] }>(
        "/v2/messenger/conversations/list", signed
      );
      return data.conversations ?? [];
    } catch { return []; }
  }

  async createConversation(wallet: WalletKeys, participantIds: string[], opts: {
    name?: string;
    isGroup?: boolean;
  } = {}): Promise<ApiResponse> {
    const signed = signRequest(wallet, {
      participantIds,
      name: opts.name,
      isGroup: opts.isGroup ?? false,
    });
    return this.rc.submitTx("/v2/messenger/conversations", signed);
  }

  async getMessages(wallet: WalletKeys, conversationId: string): Promise<MessengerMessage[]> {
    const signed = signRequest(wallet, { conversationId });
    try {
      const data = await this.rc.post<{ messages: MessengerMessage[] }>(
        "/v2/messenger/messages/list", signed
      );
      return data.messages ?? [];
    } catch { return []; }
  }

  async sendMessage(
    wallet: WalletKeys,
    conversationId: string,
    encryptedContent: string,
    opts: {
      contentSignature?: string;
      messageType?: string;
      selfDestruct?: boolean;
      destructAfterSeconds?: number;
      spoiler?: boolean;
    } = {}
  ): Promise<ApiResponse> {
    const signed = signRequest(wallet, {
      conversationId,
      encryptedContent,
      contentSignature: opts.contentSignature ?? "",
      messageType: opts.messageType ?? "text",
      selfDestruct: opts.selfDestruct ?? false,
      destructAfterSeconds: opts.destructAfterSeconds,
      spoiler: opts.spoiler ?? false,
    });
    return this.rc.submitTx("/v2/messenger/messages", signed);
  }

  async deleteMessage(wallet: WalletKeys, messageId: string, conversationId: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { messageId, conversationId });
    return this.rc.submitTx("/v2/messenger/messages/delete", signed);
  }

  async deleteConversation(wallet: WalletKeys, conversationId: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { conversationId });
    return this.rc.submitTx("/v2/messenger/conversations/delete", signed);
  }

  async markRead(wallet: WalletKeys, messageId: string, conversationId: string): Promise<ApiResponse> {
    const signed = signRequest(wallet, { messageId, conversationId });
    return this.rc.submitTx("/v2/messenger/messages/read", signed);
  }
}

// ===== Shielded Sub-client =====

class ShieldedClient {
  constructor(private readonly rc: RougeChain) {}

  // Queries

  async getStats(): Promise<ShieldedStats> {
    return this.rc.get<ShieldedStats>("/shielded/stats");
  }

  async isNullifierSpent(
    nullifierHex: string
  ): Promise<{ spent: boolean }> {
    return this.rc.get<{ spent: boolean }>(
      `/shielded/nullifier/${encodeURIComponent(nullifierHex)}`
    );
  }

  // Write operations

  /**
   * Shield public XRGE into a private note.
   * Creates the commitment client-side, submits to the chain.
   *
   * @returns The ShieldedNote (keep this locally — it's the only way to spend the note)
   */
  async shield(
    wallet: WalletKeys,
    params: ShieldParams
  ): Promise<ApiResponse & { note?: ShieldedNote }> {
    const note = createShieldedNote(params.amount, wallet.publicKey);
    const tx = createSignedShield(wallet, params.amount, note.commitment);
    const result = await this.rc.submitTx("/v2/shielded/shield", tx);
    if (result.success) {
      return { ...result, note };
    }
    return result;
  }

  /**
   * Transfer between shielded notes (private → private).
   * Requires a pre-generated STARK proof.
   */
  async transfer(
    wallet: WalletKeys,
    params: ShieldedTransferParams
  ): Promise<ApiResponse> {
    const tx = createSignedShieldedTransfer(
      wallet,
      params.nullifiers,
      params.outputCommitments,
      params.proof,
      params.shieldedFee
    );
    return this.rc.submitTx("/v2/shielded/transfer", tx);
  }

  /**
   * Unshield a private note back to public XRGE.
   * Requires a STARK proof of note ownership.
   */
  async unshield(
    wallet: WalletKeys,
    params: UnshieldParams
  ): Promise<ApiResponse> {
    const tx = createSignedUnshield(
      wallet,
      params.nullifiers,
      params.amount,
      params.proof
    );
    return this.rc.submitTx("/v2/shielded/unshield", tx);
  }

  // ─── WASM Smart Contracts ──────────────────────────────────────────

  /** Deploy a WASM smart contract */
  async deployContract(params: {
    wasm: string;
    deployer: string;
    nonce?: number;
  }): Promise<ApiResponse> {
    return this.rc.post("/v2/contract/deploy", params);
  }

  /** Call a WASM smart contract method (mutating) */
  async callContract(params: {
    contractAddr: string;
    method: string;
    caller?: string;
    args?: unknown;
    gasLimit?: number;
  }): Promise<ApiResponse> {
    return this.rc.post("/v2/contract/call", params);
  }

  /** Get contract metadata */
  async getContract(addr: string): Promise<ApiResponse> {
    return this.rc.get(`/contract/${addr}`);
  }

  /** Read contract storage. Omit key for full state dump. */
  async getContractState(
    addr: string,
    key?: string
  ): Promise<ApiResponse> {
    const q = key ? `?key=${encodeURIComponent(key)}` : "";
    return this.rc.get(`/contract/${addr}/state${q}`);
  }

  /** Get contract events */
  async getContractEvents(
    addr: string,
    limit?: number
  ): Promise<ApiResponse> {
    const q = limit ? `?limit=${limit}` : "";
    return this.rc.get(`/contract/${addr}/events${q}`);
  }

  /** List all deployed contracts */
  async listContracts(): Promise<ApiResponse> {
    return this.rc.get("/contracts");
  }
}

