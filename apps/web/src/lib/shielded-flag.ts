// Shield / unshield / shielded send are paused (2026-10-04) until the node-side fix is live.
// Re-enable by building with VITE_SHIELDED_ENABLED=true.
export function shieldedEnabled(): boolean {
  return import.meta.env.VITE_SHIELDED_ENABLED === "true";
}

export const SHIELDED_PAUSED_NOTICE = "Shielded transactions are temporarily paused";
