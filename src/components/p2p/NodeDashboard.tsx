import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import GlobalNetworkGlobe from "@/components/blockchain/GlobalNetworkGlobe";
import { getCoreApiBaseUrl } from "@/lib/network";
import {
  Activity,
  CheckCircle2,
  Database,
  Server,
  ShieldCheck,
  Users,
  XCircle,
  Zap,
} from "lucide-react";

interface DaemonStats {
  connected_peers: number;
  network_height: number;
  is_mining: boolean;
  node_id: string;
  total_fees_collected: number;
  fees_in_last_block: number;
  chain_id: string;
  finalized_height: number;
}

interface DaemonHealth {
  status: string;
  chain_id: string;
  height: number;
}

interface DaemonInfo {
  port: number | null;
  baseUrl: string;
  stats: DaemonStats;
  health: DaemonHealth;
}

const normalizeStats = (data: Record<string, unknown>): DaemonStats => ({
  connected_peers: Number(data.connected_peers ?? data.connectedPeers ?? 0),
  network_height: Number(data.network_height ?? data.networkHeight ?? 0),
  is_mining: Boolean(data.is_mining ?? data.isMining ?? false),
  node_id: String(data.node_id ?? data.nodeId ?? ""),
  total_fees_collected: Number(data.total_fees_collected ?? data.totalFeesCollected ?? 0),
  fees_in_last_block: Number(data.fees_in_last_block ?? data.feesInLastBlock ?? 0),
  chain_id: String(data.chain_id ?? data.chainId ?? ""),
  finalized_height: Number(data.finalized_height ?? data.finalizedHeight ?? 0),
});

const normalizeHealth = (data: Record<string, unknown>): DaemonHealth => ({
  status: String(data.status ?? "unknown"),
  chain_id: String(data.chain_id ?? data.chainId ?? ""),
  height: Number(data.height ?? 0),
});

export function NodeDashboard() {
  const [daemonStats, setDaemonStats] = useState<DaemonInfo[]>([]);
  const [isChecking, setIsChecking] = useState(true);
  const pollTimer = useRef<number | null>(null);

  // Fetch stats from all running core nodes (parallel check for faster detection)
  useEffect(() => {
    const backoffSteps = [2000, 5000, 10000, 30000, 60000];
    let backoffIndex = 0;
    let cancelled = false;

    const scheduleNext = (delay: number) => {
      if (cancelled) return;
      if (pollTimer.current) {
        window.clearTimeout(pollTimer.current);
      }
      pollTimer.current = window.setTimeout(() => {
        void fetchAllDaemonStats();
      }, delay);
    };

    const fetchAllDaemonStats = async () => {
      setIsChecking(true);
      const apiPorts = [5100, 5101, 5102, 5103, 5104];
      const configuredBase = getCoreApiBaseUrl();
      const configuredUrl = configuredBase ? configuredBase.replace(/\/api$/, "") : "";
      const apiBases = [
        configuredUrl,
        ...apiPorts.map((port) => `http://127.0.0.1:${port}`),
      ].filter(Boolean);
      
      // Check all ports in parallel for faster detection
      const promises = apiBases.map(async (baseUrl) => {
        try {
          // Use AbortController with short timeout for faster failure
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 500); // 500ms timeout per port
          
          const statsRes = await fetch(`${baseUrl}/api/stats`, {
            signal: controller.signal,
          });
          const healthRes = await fetch(`${baseUrl}/api/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          
          if (statsRes.ok && healthRes.ok) {
            const statsRaw = await statsRes.json() as Record<string, unknown>;
            const healthRaw = await healthRes.json() as Record<string, unknown>;
            const match = baseUrl.match(/:(\d+)\b/);
            const port = match ? Number(match[1]) : null;
            return {
              port,
              baseUrl,
              stats: normalizeStats(statsRaw),
              health: normalizeHealth(healthRaw),
            };
          }
        } catch {
          // Node not running on this port
        }
        return null;
      });

      const results = await Promise.all(promises);
      const stats = results
        .filter((r): r is DaemonInfo => r !== null);
      
      setDaemonStats(stats);
      setIsChecking(false);

      if (stats.length > 0) {
        backoffIndex = 0;
        scheduleNext(60000);
      } else {
        backoffIndex = Math.min(backoffIndex + 1, backoffSteps.length - 1);
        scheduleNext(backoffSteps[backoffIndex]);
      }
    };

    // Check immediately on mount
    void fetchAllDaemonStats();

    return () => {
      cancelled = true;
      if (pollTimer.current) {
        window.clearTimeout(pollTimer.current);
      }
    };
  }, []);

  const totalPeers = daemonStats.reduce((sum, s) => sum + s.stats.connected_peers, 0);
  const maxHeight = daemonStats.length > 0 ? Math.max(...daemonStats.map(s => s.stats.network_height)) : -1;
  const maxFinalized = daemonStats.length > 0 ? Math.max(...daemonStats.map(s => s.stats.finalized_height)) : -1;
  const miningNodes = daemonStats.filter(s => s.stats.is_mining).length;
  const totalFees = daemonStats.reduce((sum, s) => sum + s.stats.total_fees_collected, 0);
  const lastFees = daemonStats.reduce((sum, s) => sum + s.stats.fees_in_last_block, 0);
  const uniqueChains = useMemo(() => {
    const chains = new Set<string>();
    daemonStats.forEach((entry) => {
      if (entry.stats.chain_id) chains.add(entry.stats.chain_id);
    });
    return Array.from(chains);
  }, [daemonStats]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-card/40 p-3">
        <GlobalNetworkGlobe className="h-[420px]" />
      </div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Server className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">Quantum Vault Core Daemons</h2>
          </div>
          <Badge variant={daemonStats.length > 0 ? "default" : "secondary"} className={daemonStats.length > 0 ? "bg-green-500" : ""}>
            {isChecking ? "Checking..." : daemonStats.length > 0 ? `${daemonStats.length} Core Node(s) Online` : "No Daemons Detected"}
          </Badge>
        </div>
      </div>

      {/* Summary Stats */}
      {daemonStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Server className="h-8 w-8 text-blue-500" />
                <div>
                  <p className="text-2xl font-bold">{daemonStats.length}</p>
                  <p className="text-xs text-muted-foreground">Active Daemons</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Users className="h-8 w-8 text-green-500" />
                <div>
                  <p className="text-2xl font-bold">{totalPeers}</p>
                  <p className="text-xs text-muted-foreground">Total Peers</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Database className="h-8 w-8 text-purple-500" />
                <div>
                  <p className="text-2xl font-bold">{maxHeight >= 0 ? maxHeight : "—"}</p>
                  <p className="text-xs text-muted-foreground">Tip Height</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-8 w-8 text-cyan-500" />
                <div>
                  <p className="text-2xl font-bold">{maxFinalized >= 0 ? maxFinalized : "—"}</p>
                  <p className="text-xs text-muted-foreground">Finalized Height</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Zap className="h-8 w-8 text-orange-500" />
                <div>
                  <p className="text-2xl font-bold">{miningNodes}</p>
                  <p className="text-xs text-muted-foreground">Mining Nodes</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Individual Node Cards */}
      {isChecking && daemonStats.length === 0 ? (
        <Card className="border-blue-500/50">
          <CardContent className="pt-6">
            <div className="text-center py-8">
              <div className="flex items-center justify-center mb-4">
                <Server className="h-12 w-12 text-primary animate-pulse" />
              </div>
              <p className="text-lg font-semibold mb-2">Scanning for nodes...</p>
              <p className="text-sm text-muted-foreground">
                Checking ports 5100-5104
              </p>
            </div>
          </CardContent>
        </Card>
      ) : daemonStats.length === 0 ? (
        <Card className="border-yellow-500/50">
          <CardContent className="pt-6">
            <div className="text-center py-8">
              <Server className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <p className="text-lg font-semibold mb-2">No Core Daemons Detected</p>
              <p className="text-sm text-muted-foreground mb-4">
                Start the Rust core daemon to see stats here
              </p>
              <div className="bg-muted/50 rounded-lg p-4 text-left max-w-2xl mx-auto">
                <p className="text-xs font-mono mb-2">Terminal command:</p>
                <code className="text-xs bg-background px-3 py-2 rounded block">
                  cargo run -p quantum-vault-daemon -- --mine
                </code>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {daemonStats.map((entry, idx) => (
            <Card key={idx} className="border-primary/30">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Server className="h-5 w-5" />
                    Core {idx + 1}
                    {entry.stats.is_mining && (
                      <Badge variant="outline" className="border-orange-500 text-orange-500 text-xs">
                        MINING
                      </Badge>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {entry.stats.connected_peers > 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-xs text-muted-foreground font-mono">
                      {entry.stats.node_id.slice(0, 8)}...
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Users className="h-4 w-4 text-blue-500" />
                      <p className="text-2xl font-bold">{entry.stats.connected_peers}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Peers</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Database className="h-4 w-4 text-purple-500" />
                      <p className="text-2xl font-bold">{entry.stats.network_height}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Tip Height</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Activity className="h-4 w-4 text-orange-500" />
                      <p className="text-2xl font-bold">{entry.stats.is_mining ? "YES" : "NO"}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Mining</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <ShieldCheck className="h-4 w-4 text-cyan-500" />
                      <p className="text-2xl font-bold">{entry.stats.finalized_height}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Finalized</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="font-mono">Chain: {entry.stats.chain_id || entry.health.chain_id || "unknown"}</span>
                  {entry.port && <span>Port: {entry.port}</span>}
                  <span>Fees: {entry.stats.total_fees_collected.toFixed(2)} XRGE</span>
                  <span>Last block: {entry.stats.fees_in_last_block.toFixed(2)} XRGE</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Info Card */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <Server className="h-6 w-6 text-primary mt-1" />
            <div>
              <h3 className="font-semibold mb-2">Rust Core Daemon</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Rust-based daemon with gRPC + HTTP bridge</li>
                <li>• Post-quantum signatures (ML-DSA-65)</li>
                <li>• Local disk storage (JSONL chain files + sled state)</li>
                <li>• Health check at <code className="text-xs bg-background px-1 rounded">/api/health</code></li>
                <li>• Stats at <code className="text-xs bg-background px-1 rounded">/api/stats</code></li>
                <li>• Mining is optional (add <code className="text-xs bg-background px-1 rounded">--mine</code>)</li>
                <li>• Devnet defaults: local testing, not production consensus</li>
              </ul>
              {uniqueChains.length > 1 && (
                <p className="text-xs text-muted-foreground mt-3">
                  Detected chain IDs: {uniqueChains.join(", ")}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
