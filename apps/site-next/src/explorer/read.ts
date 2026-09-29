import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  deriveReadState,
  NotFoundError,
  type ReadClient,
  type ReadState,
} from "@rougechain/chain-readonly";
import { useChain } from "./chain";

export interface Read<T> {
  data: T | undefined;
  state: ReadState;
  error: unknown;
  updatedAt: number;
  isFetching: boolean;
  refetch: () => void;
}

/**
 * One node read with truthful provenance. The query key always includes the network, so data
 * from one network can never be shown under another's label. `refetchMs` makes the read poll;
 * a read that is more than two intervals old (or whose refresh failed) is reported as stale.
 */
export function useRead<T>(
  key: readonly unknown[],
  read: (client: ReadClient) => Promise<T>,
  {
    refetchMs,
    enabled = true,
    keepPrevious = false,
  }: { refetchMs?: number; enabled?: boolean; keepPrevious?: boolean } = {},
): Read<T> {
  const { network, client } = useChain();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!refetchMs) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [refetchMs]);
  const query = useQuery({
    queryKey: ["explorer", network, ...key],
    queryFn: () => read(client),
    enabled,
    networkMode: "always",
    retry: (count, error) => !(error instanceof NotFoundError) && count < 1,
    staleTime: refetchMs ? refetchMs / 2 : 60_000,
    refetchInterval: refetchMs,
    refetchOnWindowFocus: !!refetchMs,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
  const state = deriveReadState({
    pending: query.isPending && enabled,
    error: query.isError,
    notFound: query.error instanceof NotFoundError,
    hasData: query.data !== undefined,
    updatedAt: query.dataUpdatedAt,
    now: Math.max(now, query.dataUpdatedAt),
    staleAfterMs: refetchMs ? refetchMs * 2 + 15_000 : Number.POSITIVE_INFINITY,
  });
  return {
    data: query.data,
    state: query.isPlaceholderData && query.isFetching ? "loading" : state,
    error: query.error,
    updatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

export function useStats() {
  return useRead(["stats"], (c) => c.stats(), { refetchMs: 30_000 });
}

/** Decimals per symbol from the node's token directory (built-in fallbacks apply until loaded). */
export function useTokenDecimals(): ReadonlyMap<string, number> {
  const tokens = useRead(["tokens"], (c) => c.tokens(), { refetchMs: 300_000 });
  return useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tokens.data ?? []) {
      map.set(t.symbol, t.decimals);
      map.set(t.symbol.toUpperCase(), t.decimals);
    }
    return map;
  }, [tokens.data]);
}
