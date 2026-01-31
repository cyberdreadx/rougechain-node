import { useState, useEffect, useCallback } from "react";
import { getAllTokenMetadata, TokenMetadata } from "@/lib/secure-api";

/**
 * Hook to fetch and cache token metadata from the blockchain
 */
export function useTokenMetadata(pollInterval: number = 60_000) {
  const [metadata, setMetadata] = useState<Record<string, TokenMetadata>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await getAllTokenMetadata();
      if (result.success && result.data) {
        const metadataMap: Record<string, TokenMetadata> = {};
        for (const token of result.data) {
          metadataMap[token.symbol] = token;
        }
        setMetadata(metadataMap);
        setError(null);
      }
    } catch (e) {
      console.error("Failed to fetch token metadata:", e);
      setError("Failed to load token metadata");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  /**
   * Get metadata for a specific token
   */
  const getMetadata = useCallback(
    (symbol: string): TokenMetadata | null => {
      return metadata[symbol] || null;
    },
    [metadata]
  );

  /**
   * Get image URL for a token
   */
  const getTokenImage = useCallback(
    (symbol: string): string | null => {
      return metadata[symbol]?.image || null;
    },
    [metadata]
  );

  /**
   * Check if a public key is the creator of a token
   */
  const isCreator = useCallback(
    (symbol: string, publicKey: string): boolean => {
      const tokenMeta = metadata[symbol];
      return tokenMeta?.creator === publicKey;
    },
    [metadata]
  );

  return {
    metadata,
    getMetadata,
    getTokenImage,
    isCreator,
    loading,
    error,
    refresh,
  };
}
