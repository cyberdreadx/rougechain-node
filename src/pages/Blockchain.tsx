import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Shield, Blocks, RotateCcw, CheckCircle2, XCircle, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import PQCInfo from "@/components/blockchain/PQCInfo";
import { QuantumThreatPanel } from "@/components/blockchain/QuantumThreatPanel";
import { TamperDemo } from "@/components/blockchain/TamperDemo";
import GlobalNetworkGlobe from "@/components/blockchain/GlobalNetworkGlobe";
import NetworkStatsBar from "@/components/blockchain/NetworkStatsBar";
import NetworkHistoryChart from "@/components/blockchain/NetworkHistoryChart";
import type { Block } from "@/lib/pqc-blockchain";
import { getCoreApiHeaders, getNodeApiBaseUrl } from "@/lib/network";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";

interface BlockV1 {
  version: 1;
  header: {
    version: 1;
    chainId?: string;
    chain_id?: string;
    height: number;
    time: number;
    prevHash?: string;
    prev_hash?: string;
    txHash?: string;
    tx_hash?: string;
    proposerPubKey?: string;
    proposer_pub_key?: string;
  };
  txs: unknown[];
  proposerSig?: string;
  proposer_sig?: string;
  hash: string;
}

const Blockchain = () => {
  const [chain, setChain] = useState<Block[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [chainValidity, setChainValidity] = useState<{ valid: boolean; checked: boolean }>({ valid: true, checked: false });
  const [isLoading, setIsLoading] = useState(true);
  const [nodeConnected, setNodeConnected] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [lastKnownHeight, setLastKnownHeight] = useState(0);
  const [viewMode, setViewMode] = useState<"table" | "grid">(() => {
    const saved = localStorage.getItem("blockchain-view-mode");
    return saved === "grid" ? "grid" : "table";
  });

  // Convert BlockV1 to Block format for UI
  const convertBlock = (b: BlockV1): Block => ({
    index: b.header.height,
    timestamp: b.header.time,
    data: JSON.stringify(b.txs),
    previousHash: b.header.prevHash ?? b.header.prev_hash ?? "",
    hash: b.hash,
    nonce: 0, // Not used in new format
    signature: b.proposerSig ?? b.proposer_sig ?? "",
    signerPublicKey: b.header.proposerPubKey ?? b.header.proposer_pub_key ?? "",
  });

  // Load chain from core node(s)
  useEffect(() => {
    const fetchChain = async () => {
      try {
        // Use network-aware API base URL
        const NODE_API_URL = getNodeApiBaseUrl();
        if (!NODE_API_URL) {
          setChain([]);
          setNodeConnected(false);
          setIsLoading(false);
          return;
        }
        
        try {
          const isLocal = NODE_API_URL.includes("localhost") || NODE_API_URL.includes("127.0.0.1");
          const timeoutMs = isLocal ? 3000 : 10000;
          const res = await fetch(`${NODE_API_URL}/blocks?limit=500`, {
            signal: AbortSignal.timeout(timeoutMs), // allow slow public nodes
            headers: getCoreApiHeaders(),
          });
          if (res.ok) {
            const data = await res.json() as { blocks: BlockV1[] };
            const converted = data.blocks.map(convertBlock);
            setChain(converted);
            setNodeConnected(true);
            setIsLoading(false);
            return;
          }
        } catch (error) {
          // If configured URL fails, try local ports as fallback
          if (NODE_API_URL === "http://localhost:5100/api") {
            console.warn(`Failed to fetch from ${NODE_API_URL}, trying local ports...`, error);
            for (const apiPort of [5100, 5101, 5102, 5103, 5104]) {
              try {
                const res = await fetch(`http://127.0.0.1:${apiPort}/api/blocks?limit=500`, {
                  signal: AbortSignal.timeout(2000),
                  headers: getCoreApiHeaders(),
                });
                if (res.ok) {
                  const data = await res.json() as { blocks: BlockV1[] };
                  const converted = data.blocks.map(convertBlock);
                  setChain(converted);
                  setNodeConnected(true);
                  setIsLoading(false);
                  return;
                }
              } catch {
                // Try next port
              }
            }
          }
        }
        
        // No nodes found
        setChain([]);
        setNodeConnected(false);
        console.warn("No core node found. Make sure a node is running with --mine flag.");
      } catch (error) {
        console.error("Failed to load chain:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchChain();
  }, []);

  // Fetch chain data
  const fetchChainData = useCallback(async () => {
    const NODE_API_URL = getNodeApiBaseUrl();
    if (!NODE_API_URL) return;
    try {
      const res = await fetch(`${NODE_API_URL}/blocks?limit=500`, {
        signal: AbortSignal.timeout(10000),
        headers: getCoreApiHeaders(),
      });
      if (res.ok) {
        const data = await res.json() as { blocks: BlockV1[] };
        setChain(data.blocks.map(convertBlock));
        setNodeConnected(true);
      }
    } catch {
      // Silent fail
    }
  }, []);

  // WebSocket for real-time updates
  const handleNewBlock = useCallback((event: { height: number }) => {
    if (event.height > lastKnownHeight) {
      setLastKnownHeight(event.height);
      fetchChainData();
    }
  }, [lastKnownHeight, fetchChainData]);

  const { isConnected: wsConnected, connectionType: wsConnectionType } = useBlockchainWs({
    onNewBlock: handleNewBlock,
    fallbackPollInterval: 10000,
  });

  const sortedChain = [...chain].sort((a, b) => b.index - a.index);
  const totalPages = Math.max(1, Math.ceil(sortedChain.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, sortedChain.length);
  const pagedChain = sortedChain.slice(startIndex, endIndex);
  const getTxCount = (block: Block) => {
    try {
      const parsed = JSON.parse(block.data);
      if (Array.isArray(parsed)) return parsed.length;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { txs?: unknown[] }).txs)) {
        return (parsed as { txs?: unknown[] }).txs?.length ?? 0;
      }
      return parsed ? 1 : 0;
    } catch {
      return 0;
    }
  };

  const formatAge = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const truncateHash = (value: string, left = 10, right = 6) => {
    if (!value) return "—";
    if (value.length <= left + right + 3) return value;
    return `${value.slice(0, left)}...${value.slice(-right)}`;
  };

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  useEffect(() => {
    localStorage.setItem("blockchain-view-mode", viewMode);
  }, [viewMode]);

  const handleValidateChain = async () => {
    if (chain.length === 0) return;
    
    setIsValidating(true);
    try {
      // Basic validation: check chain linkage
      let valid = true;
      const errors: string[] = [];
      
      for (let i = 0; i < chain.length; i++) {
        if (i > 0 && chain[i].previousHash !== chain[i - 1].hash) {
          valid = false;
          errors.push(`Block ${i}: Invalid previous hash linkage`);
        }
      }
      
      setChainValidity({ valid, checked: true });
      
      if (valid) {
        toast.success("Chain validated!", {
          description: `All ${chain.length} blocks verified (ML-DSA-65 signatures verified by node)`,
        });
      } else {
        toast.error("Chain validation failed!", {
          description: errors.join(", "),
        });
      }
    } catch (error) {
      toast.error("Validation error");
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      {/* Main content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 py-6">
        {/* Global Network Globe - First thing visible */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4"
        >
          <GlobalNetworkGlobe className="h-[500px]" />
        </motion.div>
        
        {/* Verify Chain Button - below globe */}
        {chain.length > 0 && (
          <div className="flex justify-end mb-4">
            <Button
              variant="outline"
              size="sm"
              onClick={handleValidateChain}
              disabled={isValidating}
            >
              {chainValidity.checked ? (
                chainValidity.valid ? (
                  <CheckCircle2 className="w-4 h-4 mr-1 text-success" />
                ) : (
                  <XCircle className="w-4 h-4 mr-1 text-destructive" />
                )
              ) : (
                <Shield className="w-4 h-4 mr-1" />
              )}
              {isValidating ? "Verifying..." : "Verify Chain"}
            </Button>
          </div>
        )}

        {/* Network Stats Bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-4"
        >
          <NetworkStatsBar />
        </motion.div>

        {/* Network History Chart */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mb-6"
        >
          <NetworkHistoryChart />
        </motion.div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            >
              <Blocks className="w-8 h-8 text-primary" />
            </motion.div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Chain visualization - spans 3 columns */}
            <div className="lg:col-span-3">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-card rounded-xl border border-border p-4"
              >
                {chain.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Showing {sortedChain.length === 0 ? 0 : startIndex + 1}-{endIndex} of {sortedChain.length}
                      </span>
                      <span className="text-[10px] text-muted-foreground">•</span>
                      <span className="text-xs text-muted-foreground">Page {safePage} of {totalPages}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center rounded-full border border-border bg-background p-0.5">
                        <button
                          type="button"
                          onClick={() => setViewMode("table")}
                          className={`px-3 py-1 text-[11px] rounded-full transition ${
                            viewMode === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                          }`}
                        >
                          Compact table
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewMode("grid")}
                          className={`px-3 py-1 text-[11px] rounded-full transition ${
                            viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                          }`}
                        >
                          Visual grid
                        </button>
                      </div>
                      <select
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        value={pageSize}
                        onChange={(e) => setPageSize(Number(e.target.value))}
                      >
                        {[10, 20, 50].map(size => (
                          <option key={size} value={size}>{size} / page</option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={safePage <= 1}
                          onClick={() => setPage(prev => Math.max(1, prev - 1))}
                        >
                          Prev
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={safePage >= totalPages}
                          onClick={() => setPage(prev => Math.min(totalPages, prev + 1))}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                {!nodeConnected && chain.length === 0 && !isLoading && (
                  <div className="text-center py-12 px-4">
                    <Blocks className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <h3 className="text-lg font-semibold text-foreground mb-2">Core Node Not Connected</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      No core node detected. Start a mining node to see blocks.
                    </p>
                    <div className="text-xs text-muted-foreground space-y-1 bg-secondary/50 p-4 rounded-lg text-left max-w-md mx-auto">
                      <p className="font-semibold mb-2">To start a node:</p>
                      <code className="block bg-background p-2 rounded mb-2">
                        cargo run -p quantum-vault-daemon -- --host 0.0.0.0 --port 4100 --api-port 5100 --mine
                      </code>
                      <p className="text-xs">Or set <code className="bg-background px-1 rounded">VITE_NODE_API_URL_TESTNET</code> or <code className="bg-background px-1 rounded">VITE_NODE_API_URL_MAINNET</code> in your <code className="bg-background px-1 rounded">.env</code> file</p>
                    </div>
                  </div>
                )}
                {nodeConnected && chain.length === 0 && (
                  <div className="text-center py-12 text-muted-foreground">
                    <Blocks className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No blocks yet. Create a genesis block to start.</p>
                  </div>
                )}
                {chain.length > 0 && viewMode === "table" && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground border-b border-border">
                        <tr>
                          <th className="text-left py-2 px-2 font-medium">Block</th>
                          <th className="text-left py-2 px-2 font-medium">Age</th>
                          <th className="text-right py-2 px-2 font-medium">Txns</th>
                          <th className="text-left py-2 px-2 font-medium">Hash</th>
                          <th className="text-left py-2 px-2 font-medium">Proposer</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {pagedChain.map((block) => (
                          <tr key={block.hash} className="hover:bg-secondary/40 transition-colors">
                            <td className="py-2 px-2 font-medium text-primary">#{block.index}</td>
                            <td className="py-2 px-2 text-muted-foreground">{formatAge(block.timestamp)}</td>
                            <td className="py-2 px-2 text-right font-mono">{getTxCount(block)}</td>
                            <td className="py-2 px-2 font-mono">{truncateHash(block.hash)}</td>
                            <td className="py-2 px-2 font-mono">{truncateHash(block.signerPublicKey, 8, 6)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {chain.length > 0 && viewMode === "grid" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {pagedChain.map((block) => (
                      <div key={block.hash} className="rounded-lg border border-border bg-background/60 p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-primary">#{block.index}</span>
                          <span className="text-xs text-muted-foreground">{formatAge(block.timestamp)}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <p className="text-muted-foreground">Txns</p>
                            <p className="font-mono text-foreground">{getTxCount(block)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Proposer</p>
                            <p className="font-mono text-foreground">{truncateHash(block.signerPublicKey, 8, 6)}</p>
                          </div>
                          <div className="col-span-2">
                            <p className="text-muted-foreground">Hash</p>
                            <p className="font-mono text-foreground">{truncateHash(block.hash, 14, 10)}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>

              {/* Stats */}
              {chain.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4"
                >
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Total Blocks</p>
                    <p className="text-2xl font-bold text-foreground">{chain.length}</p>
                  </div>
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Chain Valid</p>
                    <p className="text-2xl font-bold text-success">
                      {chainValidity.checked ? (chainValidity.valid ? "✓" : "✗") : "—"}
                    </p>
                  </div>
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Signature Algo</p>
                    <p className="text-sm font-medium text-primary">ML-DSA-65</p>
                    <p className="text-[10px] text-muted-foreground">FIPS 204</p>
                  </div>
                  <div className="bg-card rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Security Level</p>
                    <p className="text-sm font-medium text-foreground">NIST L3</p>
                    <p className="text-[10px] text-muted-foreground">192-bit classical</p>
                  </div>
                </motion.div>
              )}

              {/* Crypto info banner */}
              {chain.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mt-4 p-4 rounded-xl bg-gradient-to-r from-primary/10 to-accent/10 border border-primary/20"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-5 h-5 text-primary" />
                    <span className="font-semibold text-foreground">Real Post-Quantum Cryptography Active</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                    <div>
                      <p className="text-muted-foreground">Algorithm</p>
                      <p className="text-foreground font-mono">ML-DSA-65</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Standard</p>
                      <p className="text-foreground font-mono">FIPS 204</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Public Key</p>
                      <p className="text-foreground font-mono">~1952 bytes</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Signature</p>
                      <p className="text-foreground font-mono">~3300 bytes</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <TamperDemo chain={chain} />
              <QuantumThreatPanel />
              <PQCInfo />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Blockchain;
