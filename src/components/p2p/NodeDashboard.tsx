import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { useP2PNode } from "@/hooks/use-p2p-node";
import { NetworkTopology } from "./NetworkTopology";
import { 
  Globe, 
  Play, 
  Square, 
  RefreshCw, 
  Users, 
  Server, 
  Cpu, 
  Clock,
  Link2,
  Link2Off,
  Shield,
  Zap,
  Database,
  Send
} from "lucide-react";
import type { NodeRole } from "@/lib/p2p";

export function NodeDashboard() {
  const {
    identity,
    isRunning,
    isInitializing,
    peers,
    networkStats,
    syncState,
    consensusPhase,
    logs,
    initializeNode,
    startNode,
    stopNode,
    proposeBlock,
    resetNode,
  } = useP2PNode();

  const [selectedRole, setSelectedRole] = useState<NodeRole>("validator");
  const [blockData, setBlockData] = useState("");

  const handlePropose = () => {
    if (blockData.trim()) {
      proposeBlock(blockData);
      setBlockData("");
    }
  };

  return (
    <div className="space-y-6">
      {/* Node Status Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Server className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">P2P Node</h2>
          </div>
          <Badge 
            variant={isRunning ? "default" : "secondary"}
            className={isRunning ? "bg-green-500" : ""}
          >
            {isRunning ? "RUNNING" : identity ? "STOPPED" : "NOT INITIALIZED"}
          </Badge>
          {consensusPhase !== 'idle' && (
            <Badge variant="outline" className="border-yellow-500 text-yellow-500">
              {consensusPhase.toUpperCase()}
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          {!identity ? (
            <div className="flex gap-2">
              <select 
                className="bg-background border rounded px-3 py-2 text-sm"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as NodeRole)}
              >
                <option value="validator">Validator</option>
                <option value="full-node">Full Node</option>
                <option value="light-client">Light Client</option>
              </select>
              <Button 
                onClick={() => initializeNode(selectedRole)}
                disabled={isInitializing}
              >
                {isInitializing ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Initializing...
                  </>
                ) : (
                  <>
                    <Cpu className="h-4 w-4 mr-2" />
                    Initialize Node
                  </>
                )}
              </Button>
            </div>
          ) : !isRunning ? (
            <>
              <Button onClick={startNode} className="bg-green-600 hover:bg-green-700">
                <Play className="h-4 w-4 mr-2" />
                Start Node
              </Button>
              <Button variant="outline" onClick={resetNode}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            </>
          ) : (
            <Button variant="destructive" onClick={stopNode}>
              <Square className="h-4 w-4 mr-2" />
              Stop Node
            </Button>
          )}
        </div>
      </div>

      {/* Node Identity */}
      {identity && (
        <Card className="border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Node Identity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Peer ID:</span>
                <p className="font-mono text-xs mt-1 truncate">{identity.peerId}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Role:</span>
                <p className="font-medium mt-1 capitalize">{identity.nodeRole}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Version:</span>
                <p className="font-medium mt-1">{identity.version}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Public Key:</span>
                <p className="font-mono text-xs mt-1 truncate">{identity.publicKey.slice(0, 20)}...</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Network Stats Grid */}
      {isRunning && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Users className="h-8 w-8 text-blue-500" />
                <div>
                  <p className="text-2xl font-bold">{networkStats?.connectedPeers || 0}</p>
                  <p className="text-xs text-muted-foreground">Connected Peers</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Shield className="h-8 w-8 text-green-500" />
                <div>
                  <p className="text-2xl font-bold">{networkStats?.activeValidators || 0}</p>
                  <p className="text-xs text-muted-foreground">Active Validators</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Database className="h-8 w-8 text-purple-500" />
                <div>
                  <p className="text-2xl font-bold">{networkStats?.networkHeight ?? 0}</p>
                  <p className="text-xs text-muted-foreground">Network Height</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Clock className="h-8 w-8 text-orange-500" />
                <div>
                  <p className="text-2xl font-bold">{networkStats?.averageBlockTime || 0}ms</p>
                  <p className="text-xs text-muted-foreground">Avg Block Time</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Sync Status */}
      {syncState?.isSyncing && (
        <Card className="border-yellow-500/50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <RefreshCw className="h-5 w-5 animate-spin text-yellow-500" />
              <div className="flex-1">
                <div className="flex justify-between mb-2">
                  <span className="text-sm">Syncing blockchain...</span>
                  <span className="text-sm text-muted-foreground">
                    {syncState.localHeight} / {syncState.networkHeight}
                  </span>
                </div>
                <Progress value={syncState.syncProgress * 100} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Network Topology Visualization */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Network Topology
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NetworkTopology 
            identity={identity} 
            peers={peers} 
            isRunning={isRunning} 
          />
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Propose Block */}
        {isRunning && identity?.nodeRole === 'validator' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Propose Block
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Enter block data (e.g., transaction)"
                  value={blockData}
                  onChange={(e) => setBlockData(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handlePropose()}
                />
                <Button onClick={handlePropose} disabled={!blockData.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                As a validator, you can propose blocks that other nodes will vote on.
                Requires 2/3 majority to finalize.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Connected Peers */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Connected Peers ({peers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {peers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Link2Off className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No peers connected</p>
                <p className="text-xs mt-1">Waiting for peer discovery...</p>
              </div>
            ) : (
              <ScrollArea className="h-[200px]">
                <div className="space-y-2">
                  {peers.map((peer) => (
                    <div 
                      key={peer.peerId}
                      className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4 text-green-500" />
                        <div>
                          <p className="text-xs font-mono">{peer.peerId.slice(0, 16)}...</p>
                          <p className="text-xs text-muted-foreground capitalize">{peer.nodeRole}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xs">Height: {peer.chainHeight}</p>
                        <p className="text-xs text-muted-foreground">{peer.latency}ms</p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Node Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu className="h-4 w-4" />
            Node Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[200px] rounded-lg bg-black/90 p-4">
            {logs.length === 0 ? (
              <p className="text-muted-foreground text-sm">No logs yet...</p>
            ) : (
              <div className="space-y-1 font-mono text-xs">
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-muted-foreground">[{log.time}]</span>
                    <span className={
                      log.type === 'error' ? 'text-red-400' :
                      log.type === 'success' ? 'text-green-400' :
                      log.type === 'warning' ? 'text-yellow-400' :
                      'text-blue-300'
                    }>
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Architecture Info */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <Globe className="h-6 w-6 text-primary mt-1" />
            <div>
              <h3 className="font-semibold mb-2">True P2P Decentralization</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Each node maintains its own local blockchain copy (IndexedDB)</li>
                <li>• Nodes connect directly via WebRTC data channels</li>
                <li>• Signaling uses Supabase Realtime for peer discovery only</li>
                <li>• Byzantine Fault Tolerant consensus requires 2/3 majority</li>
                <li>• No central database - blocks synced via gossip protocol</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
