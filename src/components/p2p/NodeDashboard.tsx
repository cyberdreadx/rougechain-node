import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Server, 
  Users, 
  Database,
  Activity,
  Zap,
  CheckCircle2,
  XCircle
} from "lucide-react";

interface DaemonStats {
  connectedPeers: number;
  networkHeight: number;
  isMining: boolean;
  nodeId: string;
}

export function NodeDashboard() {
  const [daemonStats, setDaemonStats] = useState<DaemonStats[]>([]);
  const [isChecking, setIsChecking] = useState(true);

  // Fetch stats from all running node daemons (parallel check for faster detection)
  useEffect(() => {
    const fetchAllDaemonStats = async () => {
      setIsChecking(true);
      const apiPorts = [5100, 5101, 5102, 5103, 5104];
      
      // Check all ports in parallel for faster detection
      const promises = apiPorts.map(async (apiPort) => {
        try {
          // Use AbortController with short timeout for faster failure
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 500); // 500ms timeout per port
          
          const res = await fetch(`http://127.0.0.1:${apiPort}/api/stats`, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          
          if (res.ok) {
            const data = await res.json() as DaemonStats;
            return { port: apiPort, data };
          }
        } catch {
          // Node not running on this port
        }
        return null;
      });

      const results = await Promise.all(promises);
      const stats = results
        .filter((r): r is { port: number; data: DaemonStats } => r !== null)
        .map(r => r.data);
      
      setDaemonStats(stats);
      setIsChecking(false);
    };

    // Check immediately on mount
    void fetchAllDaemonStats();
    
    // Then check every 2 seconds
    const interval = setInterval(fetchAllDaemonStats, 2000);
    return () => clearInterval(interval);
  }, []);

  const totalPeers = daemonStats.reduce((sum, s) => sum + s.connectedPeers, 0);
  const maxHeight = daemonStats.length > 0 ? Math.max(...daemonStats.map(s => s.networkHeight)) : -1;
  const miningNodes = daemonStats.filter(s => s.isMining).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Server className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">RougeChain L1 Nodes</h2>
          </div>
          <Badge variant={daemonStats.length > 0 ? "default" : "secondary"} className={daemonStats.length > 0 ? "bg-green-500" : ""}>
            {isChecking ? "Checking..." : daemonStats.length > 0 ? `${daemonStats.length} Node(s) Running` : "No Nodes Detected"}
          </Badge>
        </div>
      </div>

      {/* Summary Stats */}
      {daemonStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Server className="h-8 w-8 text-blue-500" />
                <div>
                  <p className="text-2xl font-bold">{daemonStats.length}</p>
                  <p className="text-xs text-muted-foreground">Active Nodes</p>
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
                  <p className="text-xs text-muted-foreground">Total TCP Peers</p>
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
                  <p className="text-xs text-muted-foreground">Network Height</p>
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
              <p className="text-lg font-semibold mb-2">No Node Daemons Detected</p>
              <p className="text-sm text-muted-foreground mb-4">
                Start a node daemon to see stats here
              </p>
              <div className="bg-muted/50 rounded-lg p-4 text-left max-w-2xl mx-auto">
                <p className="text-xs font-mono mb-2">Terminal command:</p>
                <code className="text-xs bg-background px-3 py-2 rounded block">
                  npm run l1:node:dev -- --name a --port 4100 --mine
                </code>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {daemonStats.map((stats, idx) => (
            <Card key={idx} className="border-primary/30">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Server className="h-5 w-5" />
                    Node {idx + 1}
                    {stats.isMining && (
                      <Badge variant="outline" className="border-orange-500 text-orange-500 text-xs">
                        MINING
                      </Badge>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {stats.connectedPeers > 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-xs text-muted-foreground font-mono">
                      {stats.nodeId.slice(0, 8)}...
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Users className="h-4 w-4 text-blue-500" />
                      <p className="text-2xl font-bold">{stats.connectedPeers}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">TCP Peers</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Database className="h-4 w-4 text-purple-500" />
                      <p className="text-2xl font-bold">{stats.networkHeight}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Chain Height</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Activity className="h-4 w-4 text-orange-500" />
                      <p className="text-2xl font-bold">{stats.isMining ? "YES" : "NO"}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Mining</p>
                  </div>
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
              <h3 className="font-semibold mb-2">RougeChain L1 Node Daemon</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Standalone TypeScript/Node.js daemon (not browser-based)</li>
                <li>• TCP P2P networking for block/tx propagation</li>
                <li>• ML-DSA-65 (FIPS 204) post-quantum signatures</li>
                <li>• Local disk storage (JSONL chain files)</li>
                <li>• HTTP API for stats at <code className="text-xs bg-background px-1 rounded">/api/stats</code></li>
                <li>• Devnet mode: simple block production (not production consensus yet)</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
