import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getNetwork,
  demoSnapshot,
  deriveNetworkState,
} from "@rougechain/chain-readonly";
import { Status, Metric, Button } from "@rougechain/ui";
import { RefreshCw } from "lucide-react";
import { useChain } from "./explorer/chain";
function useNetworkData() {
  const chain = useChain();
  // The saved snapshot is a MAINNET capture: it is never offered for another network.
  const snapshotAllowed = chain.network === "mainnet";
  const [requestedMode, setMode] = useState<"LIVE" | "DEMO">("LIVE");
  const mode = snapshotAllowed ? requestedMode : "LIVE";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["network", chain.network],
    queryFn: () => getNetwork(chain.network),
    enabled: mode === "LIVE",
    retry: false,
    networkMode: "always",
    staleTime: 45000,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  const derived = deriveNetworkState({
    mode,
    loading: query.isPending,
    error: query.isError,
    hasData: !!query.data,
    expired: !!query.data && now - query.dataUpdatedAt > 90000,
  });
  const state: "demo" | "loading" | "stale" | "live" | "unavailable" =
    derived === "demo" && !snapshotAllowed ? "unavailable" : derived;
  const data =
    state === "demo"
      ? demoSnapshot
      : state === "unavailable"
        ? undefined
        : query.data;
  return {
    network: chain.config,
    snapshotAllowed,
    mode,
    setMode,
    data,
    state,
    isFetching: query.isFetching,
    error: query.isError,
    refresh: () => void query.refetch(),
  };
}
const NetworkContext = createContext<ReturnType<typeof useNetworkData> | null>(
  null,
);
export function NetworkProvider({ children }: { children: ReactNode }) {
  const value = useNetworkData();
  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}
export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) throw new Error("NetworkProvider is required");
  return context;
}
export function NetworkControls() {
  const n = useNetwork();
  return (
    <div className="network-controls">
      <div className="mode-switch" aria-label="Network data mode">
        <Button
          variant={n.mode === "LIVE" ? "secondary small" : "ghost small"}
          aria-pressed={n.mode === "LIVE"}
          onClick={() => n.setMode("LIVE")}
        >
          Live data
        </Button>
        {n.snapshotAllowed && (
          <Button
            variant={n.mode === "DEMO" ? "secondary small" : "ghost small"}
            aria-pressed={n.mode === "DEMO"}
            onClick={() => n.setMode("DEMO")}
          >
            Snapshot
          </Button>
        )}
      </div>
      <Button
        variant="ghost icon"
        aria-label="Refresh network data"
        disabled={n.mode === "DEMO" || n.isFetching}
        onClick={n.refresh}
      >
        <RefreshCw size={15} />
      </Button>
    </div>
  );
}
export function DataNote() {
  const n = useNetwork();
  return (
    <div className="data-note" role="status">
      <Status state={n.state}>
        {n.state === "live"
          ? "Live API data"
          : n.state === "demo"
            ? "Demo · saved snapshot"
            : n.state === "stale"
              ? "Stale · last successful read"
              : n.state === "unavailable"
                ? "Unavailable"
                : "Loading network data"}
      </Status>
      <span>
        {n.error && n.mode === "LIVE"
          ? `${n.network.label} data unavailable. `
          : ""}
        {n.data
          ? `${n.state === "demo" ? "Captured" : "Last read"} ${new Date(n.data.capturedAt).toLocaleString()}.`
          : ""}{" "}
        {n.state === "live"
          ? "API reachability does not establish chain liveness."
          : ""}
      </span>
    </div>
  );
}
export function NetworkMetrics() {
  const n = useNetwork();
  return (
    <div className="metrics">
      <Metric
        label="Block height"
        value={n.data?.height.toLocaleString() ?? "—"}
      />
      <Metric label="Validators reported" value={n.data?.validators ?? "—"} />
      <Metric label="Connected peers" value={n.data?.peers ?? "—"} />
      <Metric
        label="Data source"
        value={
          <Status state={n.state}>
            {n.state === "live"
              ? "Live API"
              : n.state === "demo"
                ? "Snapshot"
                : n.state === "unavailable"
                  ? "Unavailable"
                  : n.state}
          </Status>
        }
      />
    </div>
  );
}
