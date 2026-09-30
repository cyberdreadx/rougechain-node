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
import { useTranslation } from "react-i18next";
import { useChain } from "./explorer/chain";
import { fmtDateTime, fmtInt } from "./i18n/format";
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
/** Header status pill: data state + network name ("Live API · Mainnet"). */
export function NetworkStatus() {
  const n = useNetwork();
  const { t } = useTranslation("common");
  return (
    <Status state={n.state}>
      {t(`network.state.${n.state}`)} · {t(`network.names.${n.network.id}`)}
    </Status>
  );
}
export function NetworkControls() {
  const n = useNetwork();
  const { t } = useTranslation("common");
  return (
    <div className="network-controls">
      <div className="mode-switch" aria-label={t("network.controls.mode")}>
        <Button
          variant={n.mode === "LIVE" ? "secondary small" : "ghost small"}
          aria-pressed={n.mode === "LIVE"}
          onClick={() => n.setMode("LIVE")}
        >
          {t("network.controls.live")}
        </Button>
        {n.snapshotAllowed && (
          <Button
            variant={n.mode === "DEMO" ? "secondary small" : "ghost small"}
            aria-pressed={n.mode === "DEMO"}
            onClick={() => n.setMode("DEMO")}
          >
            {t("network.controls.snapshot")}
          </Button>
        )}
      </div>
      <Button
        variant="ghost icon"
        aria-label={t("network.controls.refresh")}
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
  const { t } = useTranslation("common");
  const sentences = [
    n.error && n.mode === "LIVE"
      ? t("network.note.unavailable", {
          network: t(`network.names.${n.network.id}`),
        })
      : "",
    n.data
      ? t(n.state === "demo" ? "network.note.captured" : "network.note.lastRead", {
          date: fmtDateTime(n.data.capturedAt),
        })
      : "",
    n.state === "live" ? t("network.note.liveness") : "",
  ].filter(Boolean);
  return (
    <div className="data-note" role="status">
      <Status state={n.state}>{t(`network.dataState.${n.state}`)}</Status>
      <span>{sentences.join(" ")}</span>
    </div>
  );
}
export function NetworkMetrics() {
  const n = useNetwork();
  const { t } = useTranslation("common");
  return (
    <div className="metrics">
      <Metric
        label={t("network.metrics.height")}
        value={n.data ? fmtInt(n.data.height) : "—"}
      />
      <Metric
        label={t("network.metrics.validators")}
        value={n.data ? fmtInt(n.data.validators) : "—"}
      />
      <Metric
        label={t("network.metrics.peers")}
        value={n.data ? fmtInt(n.data.peers) : "—"}
      />
      <Metric
        label={t("network.metrics.source")}
        value={
          <Status state={n.state}>{t(`network.source.${n.state}`)}</Status>
        }
      />
    </div>
  );
}
