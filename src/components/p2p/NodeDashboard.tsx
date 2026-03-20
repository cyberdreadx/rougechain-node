import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import GlobalNetworkGlobe from "@/components/blockchain/GlobalNetworkGlobe";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
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

    const fetchNodeStats = async (baseUrl: string): Promise<DaemonInfo | null> => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const statsRes = await fetch(`${baseUrl}/api/stats`, {
          signal: controller.signal,
          headers: getCoreApiHeaders(),
        });
        const healthRes = await fetch(`${baseUrl}/api/health`, {
          signal: controller.signal,
          headers: getCoreApiHeaders(),
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
        // Node not reachable
      }
      return null;
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

      // Phase 1: Query known endpoints
      const initialResults = await Promise.all(apiBases.map(fetchNodeStats));
      const initialStats = initialResults.filter((r): r is DaemonInfo => r !== null);

      // Phase 2: Discover peer nodes from any reachable node
      const peerUrls = new Set<string>();
      for (const node of initialStats) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const peersRes = await fetch(`${node.baseUrl}/api/peers`, {
            signal: controller.signal,
            headers: getCoreApiHeaders(),
          });
          clearTimeout(timeoutId);
          if (peersRes.ok) {
            const peersData = await peersRes.json() as { peers?: string[] };
            if (peersData.peers) {
              for (const peerUrl of peersData.peers) {
                const normalized = peerUrl.replace(/\/+$/, "").replace(/\/api$/, "");
                // Only add if not already in our initial bases
                if (!apiBases.some((b) => b === normalized)) {
                  peerUrls.add(normalized);
                }
              }
            }
          }
        } catch {
          // Could not fetch peers from this node
        }
      }

      // Phase 3: Query discovered peer nodes
      const peerResults = await Promise.all(
        Array.from(peerUrls).map(fetchNodeStats)
      );
      const peerStats = peerResults.filter((r): r is DaemonInfo => r !== null);

      // Merge and deduplicate by node_id
      const allNodes = [...initialStats, ...peerStats];
      const seen = new Set<string>();
      const deduped: DaemonInfo[] = [];
      for (const node of allNodes) {
        const id = node.stats.node_id || node.baseUrl;
        if (!seen.has(id)) {
          seen.add(id);
          deduped.push(node);
        }
      }

      setDaemonStats(deduped);
      setIsChecking(false);

      if (deduped.length > 0) {
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

      {/* ─── How to Run a Node ─── */}
      <Card className="bg-primary/5 border-primary/20 overflow-hidden">
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
              <Server className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-bold">Run a RougeChain Node</h3>
              <p className="text-xs text-muted-foreground">Help power the network — it's easier than you think!</p>
            </div>
          </div>

          {/* Requirements */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">What you need</p>
            <div className="flex flex-wrap gap-2">
              {[
                { label: "A computer or VPS", icon: "💻" },
                { label: "Rust installed", icon: "🦀" },
                { label: "Internet connection", icon: "🌐" },
              ].map(({ label, icon }) => (
                <span key={label} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background border border-border text-xs font-medium">
                  <span>{icon}</span> {label}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {/* Docker option */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">⚡</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Option A: Docker (Fastest)</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  No Rust needed — one command and you're running.
                </p>
                <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all whitespace-pre-wrap">
                  docker run -d --name rougechain-node -p 5100:5100 -v qv-data:/data rougechain/node --mine --peers https://testnet.rougechain.io/api
                </code>
                <p className="text-xs text-muted-foreground mt-2">Skip to step 3 once it's running!</p>
              </div>
            </div>

            {/* Step 1 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">1</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Option B: Install Rust</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  If you don't have Rust yet, run this in your terminal. It takes about 2 minutes.
                </p>
                <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all">
                  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
                </code>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">2</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Download & Build</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Clone the code from GitHub and build it. This takes a few minutes the first time.
                </p>
                <div className="space-y-1.5">
                  <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all">
                    git clone https://github.com/cyberdreadx/rougechain-node.git
                  </code>
                  <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all">
                    cd rougechain-node/core && cargo build --release -p quantum-vault-daemon
                  </code>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">3</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Start Your Node 🚀</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  That's it! Run this one command. Your node will connect to the testnet, sync the blockchain, and start running.
                </p>
                <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all">
                  ./target/release/quantum-vault-daemon --api-port 5100 --peers "https://testnet.rougechain.io/api"
                </code>
                <p className="text-xs text-muted-foreground mt-2">
                  🎉 <strong>You're done!</strong> Your node is now part of the RougeChain network.
                </p>
              </div>
            </div>

            {/* Step 4 - Optional */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-sm font-bold shrink-0">✨</div>
              </div>
              <div>
                <h4 className="font-semibold text-sm mb-1">Optional: Name Your Node</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Want your node to show up with a name on the{" "}
                  <a href="/blockchain" className="text-primary underline">network globe</a>? Add <code className="text-xs bg-background px-1 rounded">--node-name</code>:
                </p>
                <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all">
                  ./target/release/quantum-vault-daemon --api-port 5100 --node-name "MyAwesomeNode" --peers "https://testnet.rougechain.io/api"
                </code>
              </div>
            </div>
          </div>

          {/* Extra options */}
          <div className="mt-6 pt-4 border-t border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">More Options</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="flex items-start gap-2 p-2 rounded-lg bg-background/50">
                <Zap className="h-3.5 w-3.5 text-orange-400 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Mine blocks</span>
                  <span className="text-muted-foreground"> — add <code className="bg-background px-1 rounded">--mine</code> to earn XRGE</span>
                </div>
              </div>
              <div className="flex items-start gap-2 p-2 rounded-lg bg-background/50">
                <Database className="h-3.5 w-3.5 text-purple-400 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Custom data dir</span>
                  <span className="text-muted-foreground"> — <code className="bg-background px-1 rounded">--data-dir ./my-data</code></span>
                </div>
              </div>
              <div className="flex items-start gap-2 p-2 rounded-lg bg-background/50">
                <ShieldCheck className="h-3.5 w-3.5 text-cyan-400 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">API key auth</span>
                  <span className="text-muted-foreground"> — <code className="bg-background px-1 rounded">--api-keys "key1,key2"</code></span>
                </div>
              </div>
              <div className="flex items-start gap-2 p-2 rounded-lg bg-background/50">
                <Users className="h-3.5 w-3.5 text-green-400 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Public URL</span>
                  <span className="text-muted-foreground"> — <code className="bg-background px-1 rounded">--public-url "https://yournode.com"</code></span>
                </div>
              </div>
            </div>
          </div>

          {uniqueChains.length > 1 && (
            <p className="text-xs text-muted-foreground mt-4">
              Detected chain IDs: {uniqueChains.join(", ")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ─── Become a Validator ─── */}
      <Card className="bg-orange-500/5 border-orange-500/20 overflow-hidden">
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-orange-500" />
            </div>
            <div>
              <h3 className="text-lg font-bold">Become a Validator</h3>
              <p className="text-xs text-muted-foreground">Earn XRGE rewards by securing the network</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground mb-4">
            Validators are nodes that create new blocks and earn fees. You need some XRGE tokens staked to become one.
            Here's how — it only takes a few minutes after your node is running!
          </p>

          <div className="space-y-4">
            {/* Step 1 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center text-sm font-bold shrink-0">1</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Create a Wallet</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Go to{" "}
                  <a href="/wallet" className="text-primary underline">rougechain.io/wallet</a>
                  {" "}and create a new wallet. <strong>Save your keys somewhere safe!</strong> You'll get a public key (your address) and a private key (your secret).
                </p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center text-sm font-bold shrink-0">2</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Get Some XRGE</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  On the testnet, you can get free XRGE from the faucet — just paste your public key on the{" "}
                  <a href="/wallet" className="text-primary underline">wallet page</a> and click "Request Faucet." You need at least <strong>1,000 XRGE</strong> to stake.
                </p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center text-sm font-bold shrink-0">3</div>
                <div className="w-px flex-1 bg-border mt-2" />
              </div>
              <div className="pb-4">
                <h4 className="font-semibold text-sm mb-1">Stake Your XRGE</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Go to the{" "}
                  <a href="/validators" className="text-primary underline">Validators page</a>
                  {" "}and stake your XRGE. Once staked, your wallet address becomes a <strong>validator</strong> — it can propose new blocks!
                </p>
              </div>
            </div>

            {/* Step 4 */}
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center text-sm font-bold shrink-0">4</div>
              </div>
              <div>
                <h4 className="font-semibold text-sm mb-1">Enable Mining ⛏️</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Add <code className="text-xs bg-background px-1 rounded">--mine</code> to your node command. Your node will now create blocks and earn fees!
                </p>
                <code className="text-xs bg-background border border-border px-3 py-2 rounded-lg block font-mono select-all">
                  ./target/release/quantum-vault-daemon --api-port 5100 --mine --node-name "MyValidator" --peers "https://testnet.rougechain.io/api"
                </code>
                <p className="text-xs text-muted-foreground mt-2">
                  💰 <strong>You're earning!</strong> Check your balance on the wallet page or visit <code className="bg-background px-1 rounded text-xs">http://localhost:5100</code> to see your node dashboard.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
