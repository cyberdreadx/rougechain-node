import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  createReadClient,
  networkConfig,
  parseNetworkLock,
  resolveNetwork,
  NETWORK_STORAGE_KEY,
  type NetworkId,
} from "@rougechain/chain-readonly";

/** VITE_NETWORK_LOCK pins a deploy to one network (same variable and semantics as apps/web). */
export function networkLock(): NetworkId | null {
  return parseNetworkLock(import.meta.env.VITE_NETWORK_LOCK);
}

function savedNetwork(): unknown {
  try {
    return window.localStorage.getItem(NETWORK_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function initialNetwork(): NetworkId {
  return resolveNetwork({ lock: networkLock(), saved: savedNetwork() });
}

function makeValue(network: NetworkId, setNetwork: (id: NetworkId) => void) {
  return {
    network,
    config: networkConfig(network),
    client: createReadClient(network),
    locked: networkLock() !== null,
    setNetwork,
  };
}
export type ChainContextValue = ReturnType<typeof makeValue>;

const fallback = makeValue(initialNetwork(), () => {});
const ChainContext = createContext<ChainContextValue>(fallback);

export function ChainProvider({ children, network: forced }: { children: ReactNode; network?: NetworkId }) {
  const [network, setState] = useState<NetworkId>(() => forced ?? initialNetwork());
  const value = useMemo(
    () =>
      makeValue(network, (next) => {
        if (networkLock()) return; // pinned deploys never switch in place
        try {
          window.localStorage.setItem(NETWORK_STORAGE_KEY, next);
        } catch {
          /* storage unavailable: switch for this session only */
        }
        setState(next);
      }),
    [network],
  );
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

export function useChain(): ChainContextValue {
  return useContext(ChainContext);
}
