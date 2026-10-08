/**
 * Build-time environment for @rougechain/core, in one place so every consuming Vite app
 * (apps/web, apps/site-next) reads the same VITE_* variables.
 *
 * Each getter reads `import.meta.env.VITE_*` with STATIC property access at CALL time:
 * - static access lets Vite inline the value at build time;
 * - call-time reads keep `vi.stubEnv(...)` working in tests.
 * The consuming app's Vite config (envDir etc.) decides where the values come from.
 */

/** `VITE_NETWORK_LOCK` — "mainnet" | "testnet" pins a deploy to one network. */
export function envNetworkLock(): string | undefined {
  return import.meta.env.VITE_NETWORK_LOCK as string | undefined;
}

/** `VITE_MAINNET_SITE_URL` — public site of mainnet (pinned deploys link across). */
export function envMainnetSiteUrl(): string | undefined {
  return import.meta.env.VITE_MAINNET_SITE_URL as string | undefined;
}

/** `VITE_TESTNET_SITE_URL` — public site of testnet. */
export function envTestnetSiteUrl(): string | undefined {
  return import.meta.env.VITE_TESTNET_SITE_URL as string | undefined;
}

/** `VITE_CORE_API_URL` — default node API URL (both networks). */
export function envCoreApiUrl(): string | undefined {
  return import.meta.env.VITE_CORE_API_URL as string | undefined;
}

/** `VITE_NODE_API_URL` — legacy alias of VITE_CORE_API_URL. */
export function envNodeApiUrl(): string | undefined {
  return import.meta.env.VITE_NODE_API_URL as string | undefined;
}

/** `VITE_CORE_API_URL_MAINNET` — mainnet node API URL. */
export function envCoreApiUrlMainnet(): string | undefined {
  return import.meta.env.VITE_CORE_API_URL_MAINNET as string | undefined;
}

/** `VITE_NODE_API_URL_MAINNET` — legacy alias of VITE_CORE_API_URL_MAINNET. */
export function envNodeApiUrlMainnet(): string | undefined {
  return import.meta.env.VITE_NODE_API_URL_MAINNET as string | undefined;
}

/** `VITE_CORE_API_URL_TESTNET` — testnet node API URL. */
export function envCoreApiUrlTestnet(): string | undefined {
  return import.meta.env.VITE_CORE_API_URL_TESTNET as string | undefined;
}

/** `VITE_NODE_API_URL_TESTNET` — legacy alias of VITE_CORE_API_URL_TESTNET. */
export function envNodeApiUrlTestnet(): string | undefined {
  return import.meta.env.VITE_NODE_API_URL_TESTNET as string | undefined;
}

/** `VITE_CORE_API_KEY` — optional `x-api-key` header value. */
export function envCoreApiKey(): string | undefined {
  return import.meta.env.VITE_CORE_API_KEY as string | undefined;
}

/** `VITE_GIPHY_API_KEY` — GIF picker key (picker hidden when unset). Tolerates a missing env object. */
export function envGiphyApiKey(): string | undefined {
  return import.meta.env?.VITE_GIPHY_API_KEY as string | undefined;
}

/** Vite's `DEV` flag (dev server / development mode). */
export function envIsDev(): boolean {
  return Boolean(import.meta.env.DEV);
}

/** `VITE_CHAIN_ID_MAINNET` — override of mainnet's chain id (local devnets only). */
export function envChainIdMainnet(): string | undefined {
  return import.meta.env?.VITE_CHAIN_ID_MAINNET as string | undefined;
}

/** `VITE_CHAIN_ID_TESTNET` — override of testnet's chain id (local devnets only). */
export function envChainIdTestnet(): string | undefined {
  return import.meta.env?.VITE_CHAIN_ID_TESTNET as string | undefined;
}
