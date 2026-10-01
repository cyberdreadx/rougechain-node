/**
 * TOKEN_MINTING (node consensus upgrade): mintable custom tokens, creator-only capped minting.
 *
 * The node refuses `mintable` / `max_supply` on create_token and every `mint_tokens` until the
 * upgrade is active (`/api/stats` → `upgrade_schedule.token_minting`, `null` = not scheduled).
 * Mirrors core/daemon/src/node.rs `token_minting_tx_rule` / `check_token_mint` and
 * v2_binding.rs `derive_mint_fields`. Framework-free.
 */

/** Largest integer the node accepts for a mint amount / mintable initial supply / cap (2^53 - 1). */
export const TOKEN_MINT_MAX_AMOUNT = 9_007_199_254_740_991;

/** XRGE fee the node charges for `mint_tokens` (v2_binding). */
export const TOKEN_MINT_FEE_XRGE = 1;

/** Options for a mintable create_token. */
export interface TokenMintOptions {
  mintable?: boolean;
  /** Cap on initial + minted supply (only with `mintable`). */
  maxSupply?: number | null;
}

/** Minimal `/api/stats` shape needed to tell whether TOKEN_MINTING is active. */
export interface TokenMintingStats {
  network_height?: number;
  upgrade_schedule?: { token_minting?: number | null } | null;
}

/** The token metadata fields the node exposes for minting (`/api/tokens`, `/api/token/:sym/metadata`). */
export interface TokenMintInfo {
  creator?: string;
  mintable?: boolean;
  max_supply?: number | null;
  total_minted?: number;
  initial_supply?: number | null;
}

function isWholeAmount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/** TOKEN_MINTING applies to the next block (the node checks `next_height >= activation`). */
export function tokenMintingActive(stats: TokenMintingStats | null | undefined): boolean {
  const at = stats?.upgrade_schedule?.token_minting;
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  const h = stats?.network_height;
  if (typeof h !== "number" || !Number.isFinite(h) || h < 0) return false;
  return h + 1 >= at;
}

/**
 * Validate mint options and return the exact fields to sign on a create_token:
 * `{}` (fixed supply — payload unchanged), `{ mintable: true }`, or `{ mintable: true, max_supply }`.
 * Throws a clear error on invalid input.
 */
export function tokenMintFields(
  initialSupply: number,
  opts: TokenMintOptions = {}
): { mintable?: true; max_supply?: number } {
  const { mintable, maxSupply } = opts;
  if (mintable !== undefined && typeof mintable !== "boolean") throw new Error("mintable must be a boolean");
  if (!mintable) {
    if (maxSupply !== undefined && maxSupply !== null) throw new Error("max supply requires mintable");
    return {};
  }
  if (!isWholeAmount(initialSupply) || initialSupply > TOKEN_MINT_MAX_AMOUNT) {
    throw new Error(`a mintable token's initial supply must be a positive integer at most ${TOKEN_MINT_MAX_AMOUNT}`);
  }
  if (maxSupply === undefined || maxSupply === null) return { mintable: true };
  if (!isWholeAmount(maxSupply) || maxSupply > TOKEN_MINT_MAX_AMOUNT) {
    throw new Error(`max supply must be a positive integer at most ${TOKEN_MINT_MAX_AMOUNT}`);
  }
  if (maxSupply < initialSupply) {
    throw new Error(`max supply ${maxSupply} is below the initial supply ${initialSupply}`);
  }
  return { mintable: true, max_supply: maxSupply };
}

/** Validate a mint amount (positive integer ≤ 2^53 - 1); throws otherwise. */
export function assertMintAmount(amount: number): void {
  if (!isWholeAmount(amount) || amount > TOKEN_MINT_MAX_AMOUNT) {
    throw new Error(`mint amount must be a positive integer at most ${TOKEN_MINT_MAX_AMOUNT}`);
  }
}

/** Supply issued so far for a mintable token: initial + minted, or `null` if the node did not report it. */
export function issuedSupply(meta: TokenMintInfo): number | null {
  if (typeof meta.initial_supply !== "number") return null;
  return meta.initial_supply + (meta.total_minted ?? 0);
}

/**
 * Room left under the cap: `max_supply - (initial + minted)`, `Infinity` when uncapped, `null` when
 * the cap is set but the issued supply is unknown.
 */
export function mintRoom(meta: TokenMintInfo): number | null {
  if (meta.max_supply === undefined || meta.max_supply === null) return Number.POSITIVE_INFINITY;
  const issued = issuedSupply(meta);
  if (issued === null) return null;
  return Math.max(0, meta.max_supply - issued);
}

/** Whether `publicKey` may mint this token: it is mintable under consensus and `publicKey` is its creator. */
export function canMintToken(meta: TokenMintInfo | null | undefined, publicKey: string | null | undefined): boolean {
  return !!meta && meta.mintable === true && !!publicKey && !!meta.creator && meta.creator === publicKey;
}
