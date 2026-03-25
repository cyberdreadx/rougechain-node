import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FileCode,
  Upload,
  Loader2,
  Search,
  ArrowUpDown,
  ExternalLink,
  Box,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { toast } from "sonner";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";

interface ContractInfo {
  address: string;
  deployer?: string;
  deploy_tx?: string;
  wasm_size?: number;
  block_height?: number;
  created_at?: number;
  method_count?: number;
}

const truncateAddr = (value: string, left = 10, right = 6) => {
  if (!value) return "—";
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
};

const Contracts = () => {
  const [contracts, setContracts] = useState<ContractInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "size">("newest");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const navigate = useNavigate();

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedValue(text);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedValue(null), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const fetchContracts = useCallback(async () => {
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) {
        setIsLoading(false);
        return;
      }
      const res = await fetch(`${apiBase}/contracts`, {
        signal: AbortSignal.timeout(8000),
        headers: getCoreApiHeaders(),
      });
      if (!res.ok) {
        setIsLoading(false);
        return;
      }
      const data = await res.json();
      if (data.success && Array.isArray(data.contracts)) {
        setContracts(data.contracts);
      }
    } catch (err) {
      console.error("Failed to fetch contracts:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

  useBlockchainWs({
    onNewBlock: fetchContracts,
    fallbackPollInterval: 15000,
  });

  const filtered = contracts.filter((c) =>
    c.address.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (c.deployer ?? "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "newest") return (b.block_height ?? 0) - (a.block_height ?? 0);
    if (sortBy === "oldest") return (a.block_height ?? 0) - (b.block_height ?? 0);
    return (b.wasm_size ?? 0) - (a.wasm_size ?? 0);
  });

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
          <div className="flex items-center gap-3">
            <FileCode className="w-7 h-7 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">Smart Contracts</h1>
            <Badge variant="outline">{getNetworkLabel()}</Badge>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <FileCode className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Contracts</p>
              <p className="text-lg font-bold font-mono text-foreground">{contracts.length}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Box className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total WASM Size</p>
              <p className="text-lg font-bold font-mono text-foreground">
                {(contracts.reduce((s, c) => s + (c.wasm_size ?? 0), 0) / 1024).toFixed(1)} KB
              </p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3 col-span-2 md:col-span-1">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Upload className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">WASM Runtime</p>
              <p className="text-sm font-bold text-foreground">Wasmtime</p>
            </div>
          </div>
        </div>

        {/* Search & Sort */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by contract address or deployer..."
              className="w-full pl-9 pr-4 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={sortBy === "newest" ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy("newest")}
            >
              <ArrowUpDown className="w-3 h-3 mr-1" /> Newest
            </Button>
            <Button
              variant={sortBy === "size" ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy("size")}
            >
              Size
            </Button>
          </div>
        </div>

        {/* Contract List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : sorted.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <FileCode className="w-16 h-16 text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-lg font-semibold mb-2">No Contracts Found</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                {searchQuery
                  ? "No contracts match your search."
                  : "No smart contracts have been deployed yet. Deploy the first one via the API!"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {sorted.map((contract) => (
              <Card
                key={contract.address}
                className="hover:border-primary/50 transition-colors cursor-pointer"
                onClick={() => navigate(`/contract/${contract.address}`)}
              >
                <CardContent className="p-4">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <FileCode className="w-5 h-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/contract/${contract.address}`}
                            className="text-sm font-mono text-primary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {truncateAddr(contract.address, 12, 8)}
                          </Link>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyToClipboard(contract.address);
                            }}
                            className="p-0.5 hover:bg-secondary rounded transition-colors"
                          >
                            {copiedValue === contract.address ? (
                              <Check className="w-3 h-3 text-green-500" />
                            ) : (
                              <Copy className="w-3 h-3 text-muted-foreground" />
                            )}
                          </button>
                        </div>
                        {contract.deployer && (
                          <p className="text-xs text-muted-foreground truncate">
                            Deployer: {truncateAddr(contract.deployer, 8, 4)}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      {contract.wasm_size != null && (
                        <span className="font-mono">{contract.wasm_size.toLocaleString()} bytes</span>
                      )}
                      {contract.block_height != null && (
                        <Link
                          to={`/block/${contract.block_height}`}
                          className="text-primary hover:underline font-mono"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Block #{contract.block_height}
                        </Link>
                      )}
                      <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/50" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default Contracts;
