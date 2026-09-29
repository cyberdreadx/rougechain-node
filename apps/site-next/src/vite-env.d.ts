/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "mainnet" | "testnet": pin this deploy to one network (same semantics as apps/web). */
  readonly VITE_NETWORK_LOCK?: string;
}
