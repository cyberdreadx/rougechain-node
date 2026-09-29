/**
 * The site's read client. GET only, fixed per-network origin, allowlisted routes, no
 * credentials, no redirects, bounded time, strict normalizers. There is no write transport:
 * nothing here can POST, sign, or submit.
 */
import {
  buildReadPath,
  matchReadRoute,
  NotAllowlistedError,
  type ReadRouteId,
} from "./allowlist";
import { networkConfig, type NetworkId } from "./network";
import * as n from "./normalize";

export const READ_TIMEOUT_MS = 8000;

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Network data unavailable (${status})`);
    this.name = "HttpError";
  }
}

/**
 * Perform one allowlisted GET. `method` exists only so callers (and tests) can prove that any
 * other verb is refused before a request is made.
 */
export async function readOnlyGet(
  path: string,
  method: "GET" = "GET",
  network: NetworkId = "mainnet",
): Promise<unknown> {
  if (method !== "GET")
    throw new NotAllowlistedError("read-only client: GET only");
  matchReadRoute(path);
  const { apiBase } = networkConfig(network);
  const response = await fetch(`${apiBase}${path}`, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) throw new n.NotFoundError();
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

async function get<T>(
  network: NetworkId,
  id: ReadRouteId,
  params: Record<string, string | number>,
  query: Record<string, string | number | undefined>,
  normalize: (raw: unknown) => T,
): Promise<T> {
  return normalize(
    await readOnlyGet(buildReadPath(id, params, query), "GET", network),
  );
}

/** Typed reads for one network. Each method validates its input and normalises its output. */
export function createReadClient(network: NetworkId) {
  const { chainId } = networkConfig(network);
  return {
    network,
    chainId,
    stats: () =>
      get(network, "stats", {}, {}, (r) => n.normalizeStats(r, chainId)),
    validatorCount: () =>
      get(network, "validators", {}, {}, n.normalizeValidatorCount),
    blocksPage: (page: number, perPage: number) =>
      get(network, "blocks", {}, { page, per_page: perPage }, (r) =>
        n.normalizeBlocksPage(r, chainId),
      ),
    block: (height: number) =>
      get(network, "block", { height }, {}, n.normalizeBlockDetail),
    txs: (limit: number, offset = 0) =>
      get(network, "txs", {}, { limit, offset }, n.normalizeTxs),
    tx: (hash: string) => get(network, "tx", { hash }, {}, n.normalizeTxDetail),
    resolve: (address: string) =>
      get(network, "resolve", { address }, {}, n.normalizeResolve),
    balance: (address: string) =>
      get(network, "balance", { address }, {}, n.normalizeBalance),
    addressTxs: (address: string, limit: number, offset = 0) =>
      get(
        network,
        "addressTxs",
        { address },
        { limit, offset },
        n.normalizeAddressTxs,
      ),
    ownerNfts: (pubkey: string) =>
      get(network, "nftOwner", { pubkey }, {}, n.normalizeOwnerNfts),
    tokens: () => get(network, "tokens", {}, {}, n.normalizeTokens),
    tokenMetadata: (symbol: string) =>
      get(network, "tokenMetadata", { symbol }, {}, n.normalizeTokenMetadata),
    tokenHolders: (symbol: string) =>
      get(network, "tokenHolders", { symbol }, {}, n.normalizeTokenHolders),
    tokenTxs: (symbol: string, limit: number) =>
      get(network, "tokenTxs", { symbol }, { limit }, n.normalizeTokenTxs),
    pools: () => get(network, "pools", {}, {}, n.normalizePools),
    poolPrices: (poolId: string) =>
      get(network, "poolPrices", { poolId }, {}, n.normalizePoolPrices),
    collections: () =>
      get(network, "nftCollections", {}, {}, n.normalizeCollections),
    collection: (id: string) =>
      get(network, "nftCollection", { id }, {}, (r) =>
        n.normalizeCollection(r),
      ),
    collectionTokens: (id: string, limit: number, offset = 0) =>
      get(
        network,
        "nftCollectionTokens",
        { id },
        { limit, offset },
        n.normalizeCollectionTokens,
      ),
    contracts: () => get(network, "contracts", {}, {}, n.normalizeContracts),
    contract: (addr: string) =>
      get(network, "contract", { addr }, {}, n.normalizeContract),
    contractState: (addr: string) =>
      get(network, "contractState", { addr }, {}, n.normalizeContractState),
    contractEvents: (addr: string, limit: number, before?: number) =>
      get(
        network,
        "contractEvents",
        { addr },
        { limit, before },
        n.normalizeContractEvents,
      ),
  };
}

export type ReadClient = ReturnType<typeof createReadClient>;
