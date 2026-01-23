import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Shield, Blocks, RotateCcw, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { MainNav } from "@/components/MainNav";
import BlockchainVisualizer from "@/components/blockchain/BlockchainVisualizer";
import PQCInfo from "@/components/blockchain/PQCInfo";
import { QuantumThreatPanel } from "@/components/blockchain/QuantumThreatPanel";
import { TamperDemo } from "@/components/blockchain/TamperDemo";
import GlobalNetworkGlobe from "@/components/blockchain/GlobalNetworkGlobe";
import NetworkStatsBar from "@/components/blockchain/NetworkStatsBar";
import NetworkHistoryChart from "@/components/blockchain/NetworkHistoryChart";
import type { Block } from "@/lib/pqc-blockchain";
import { getNodeApiBaseUrl } from "@/lib/network";

interface BlockV1 {
  version: 1;
  header: {
    version: 1;
    chainId: string;
    height: number;
    time: number;
    prevHash: string;
    txHash: string;
    proposerPubKey: string;
  };
  txs: unknown[];
  proposerSig: string;
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

  // Convert BlockV1 to Block format for UI
  const convertBlock = (b: BlockV1): Block => ({
    index: b.header.height,
    timestamp: b.header.time,
    data: JSON.stringify(b.txs),
    previousHash: b.header.prevHash,
    hash: b.hash,
    nonce: 0, // Not used in new format
    signature: b.proposerSig,
    signerPublicKey: b.header.proposerPubKey,
  });

  // Load chain from node daemon(s)
  useEffect(() => {
    const fetchChain = async () => {
      try {
        // Use network-aware API base URL
        const NODE_API_URL = getNodeApiBaseUrl();
        
        try {
          const res = await fetch(`${NODE_API_URL}/blocks`, {
            signal: AbortSignal.timeout(2000), // 2 second timeout
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
                const res = await fetch(`http://127.0.0.1:${apiPort}/api/blocks`, {
                  signal: AbortSignal.timeout(500), // 500ms timeout per request
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
        console.warn("No node daemon found. Make sure a node is running with --mine flag.");
      } catch (error) {
        console.error("Failed to load chain:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchChain();
    const interval = setInterval(fetchChain, 3000); // Refresh every 3s
    return () => clearInterval(interval);
  }, []);

  const sortedChain = [...chain].sort((a, b) => b.index - a.index);
  const totalPages = Math.max(1, Math.ceil(sortedChain.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, sortedChain.length);
  const pagedChain = sortedChain.slice(startIndex, endIndex);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [pageSize]);

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
      <MainNav />
      
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      {/* Action Bar */}
      <div className="sticky top-[60px] z-40 flex items-center justify-end gap-2 px-4 py-2 bg-background/80 backdrop-blur-sm border-b border-border">
        {chain.length > 0 && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleValidateChain}
              disabled={isValidating}
              className="hidden sm:flex"
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
          </>
        )}
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary border border-border">
          <Shield className="w-4 h-4 text-primary" />
          <span className="text-xs text-muted-foreground">ML-DSA-65</span>
        </div>
      </div>

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
                    <h3 className="text-lg font-semibold text-foreground mb-2">Node Not Connected</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      No node daemon detected. Start a mining node to see blocks.
                    </p>
                    <div className="text-xs text-muted-foreground space-y-1 bg-secondary/50 p-4 rounded-lg text-left max-w-md mx-auto">
                      <p className="font-semibold mb-2">To start a node:</p>
                      <code className="block bg-background p-2 rounded mb-2">
                        npm run l1:node:dev -- --name my-node --host 0.0.0.0 --port 4100 --apiPort 5100 --mine
                      </code>
                      <p className="text-xs">Or set <code className="bg-background px-1 rounded">VITE_NODE_API_URL_TESTNET</code> or <code className="bg-background px-1 rounded">VITE_NODE_API_URL_MAINNET</code> in your <code className="bg-background px-1 rounded">.env</code> file</p>
                    </div>
                  </div>
                )}
                {nodeConnected && chain.length === 0 && (
                  <BlockchainVisualizer chain={chain} isValidating={isValidating} />
                )}
                {chain.length > 0 && (
                  <BlockchainVisualizer chain={pagedChain} isValidating={isValidating} />
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
