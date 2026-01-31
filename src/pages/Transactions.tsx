import { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw, Copy, Check, Zap, Box, Users, Clock, ChevronLeft, ChevronRight, ExternalLink, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { toast } from "sonner";

const ITEMS_PER_PAGE = 20;

interface NetworkStats {
  blockHeight: number;
  connectedPeers: number;
  tps: number;
  avgBlockTime: number;
}

interface CoreTxResponse {
  txs: Array<{
    txId?: string;
    tx_id?: string;
    blockHeight?: number;
    block_height?: number;
    blockHash?: string;
    block_hash?: string;
    blockTime?: number;
    block_time?: number;
    tx: {
      tx_type?: string;
      type?: string;
      from_pub_key?: string;
      fromPubKey?: string;
      payload?: {
        to_pub_key_hex?: string;
        toPubKeyHex?: string;
        amount?: number;
        faucet?: boolean;
        target_pub_key?: string;
        token_symbol?: string;
        tokenSymbol?: string;
        token_name?: string;
        tokenName?: string;
      };
      fee?: number;
    };
  }>;
}

interface TxItem {
  id: string;
  type: string;
  from: string;
  to: string;
  amount: number;
  symbol: string;
  fee: number;
  blockHeight: number;
  blockHash: string;
  time: number;
}

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

const truncateHash = (value: string, left = 8, right = 6) => {
  if (!value) return "—";
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
};

const labelForType = (type: string) => {
  switch (type) {
    case "faucet":
      return "Faucet";
    case "transfer":
      return "Transfer";
    case "stake":
      return "Stake";
    case "unstake":
      return "Unstake";
    case "create_token":
      return "Token Created";
    default:
      return type;
  }
};

const Transactions = () => {
  const [txs, setTxs] = useState<TxItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [networkStats, setNetworkStats] = useState<NetworkStats>({
    blockHeight: 0,
    connectedPeers: 0,
    tps: 0,
    avgBlockTime: 0,
  });
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedTx, setSelectedTx] = useState<TxItem | null>(null);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAddress(text);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedAddress(null), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const fetchNetworkStats = async () => {
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) return;
      const res = await fetch(`${apiBase}/stats`, {
        signal: AbortSignal.timeout(5000),
        headers: getCoreApiHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setNetworkStats({
          blockHeight: data.network_height ?? data.networkHeight ?? 0,
          connectedPeers: data.connected_peers ?? data.connectedPeers ?? 0,
          tps: data.tps ?? 0,
          avgBlockTime: data.avg_block_time ?? data.avgBlockTime ?? 10,
        });
      }
    } catch {
      // Silently fail for stats
    }
  };

  const fetchTxs = async () => {
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) {
        setError("No core node API configured.");
        setTxs([]);
        return;
      }
      const res = await fetch(`${apiBase}/txs?limit=200`, {
        signal: AbortSignal.timeout(8000),
        headers: getCoreApiHeaders(),
      });
      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json() as CoreTxResponse;
      const parsed: TxItem[] = [];
      for (const entry of data.txs ?? []) {
        const tx = entry.tx;
        const payload = tx.payload ?? {};
        const isFaucet = payload.faucet === true;
        const type = (tx.type ?? tx.tx_type ?? "transfer").toLowerCase();
        const from = isFaucet ? "FAUCET" : tx.fromPubKey ?? tx.from_pub_key ?? "";
        const to = payload.toPubKeyHex ?? payload.to_pub_key_hex ?? payload.target_pub_key ?? "";
        const blockHeight = entry.blockHeight ?? entry.block_height ?? 0;
        const blockHash = entry.blockHash ?? entry.block_hash ?? "";
        const time = entry.blockTime ?? entry.block_time ?? Date.now();
        const txId = entry.txId ?? entry.tx_id ?? "";
        // Extract token symbol (defaults to XRGE for native transfers)
        const tokenSymbol = payload.token_symbol || payload.tokenSymbol || "XRGE";
        parsed.push({
          id: txId || `${blockHash}:${blockHeight}`,
          type: isFaucet ? "faucet" : type,
          from,
          to,
          amount: payload.amount ?? 0,
          symbol: tokenSymbol,
          fee: tx.fee ?? 0,
          blockHeight,
          blockHash,
          time,
        });
      }
      parsed.sort((a, b) => b.time - a.time || b.blockHeight - a.blockHeight);
      setTxs(parsed);
      setLastUpdated(Date.now());
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load transactions";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTxs();
    fetchNetworkStats();
    const txInterval = setInterval(fetchTxs, 5000); // 5 seconds
    const statsInterval = setInterval(fetchNetworkStats, 10000); // 10 seconds
    return () => {
      clearInterval(txInterval);
      clearInterval(statsInterval);
    };
  }, []);

  const filteredTxs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return txs;
    return txs.filter((tx) =>
      [tx.from, tx.to, tx.blockHash, String(tx.blockHeight), tx.id]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(q))
    );
  }, [query, txs]);

  // Reset to page 1 when search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [query]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredTxs.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedTxs = filteredTxs.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const formatFullDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">

      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        {/* Network Stats Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Box className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Block Height</p>
              <p className="text-lg font-bold font-mono text-foreground">#{networkStats.blockHeight.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Users className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Connected Peers</p>
              <p className="text-lg font-bold font-mono text-foreground">{networkStats.connectedPeers}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
              <Zap className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">TPS</p>
              <p className="text-lg font-bold font-mono text-foreground">{networkStats.tps.toFixed(2)}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Clock className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Avg Block Time</p>
              <p className="text-lg font-bold font-mono text-foreground">{networkStats.avgBlockTime.toFixed(1)}s</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">Transaction Feed</h1>
              <Badge variant="outline">{getNetworkLabel()}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Live stream of recent transactions from the core node.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchTxs} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4" />
              Recent Transactions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <Input
                placeholder="Search by address, block hash, or height..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="md:max-w-sm"
              />
              <div className="text-xs text-muted-foreground">
                {lastUpdated ? `Updated ${formatAge(lastUpdated)}` : "Not synced yet"}
              </div>
            </div>

            {error && (
              <div className="text-sm text-destructive">
                {error} Configure `VITE_CORE_API_URL_TESTNET` or start the core node.
              </div>
            )}

            <div className="md:hidden space-y-3">
              {paginatedTxs.length === 0 && !isLoading && (
                <div className="py-6 text-center text-muted-foreground">
                  No transactions yet.
                </div>
              )}
              {paginatedTxs.map((tx) => (
                <div 
                  key={tx.id} 
                  className="rounded-lg border border-border bg-background/60 p-3 space-y-2 cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setSelectedTx(tx)}
                >
                  <div className="flex items-center justify-between">
                    <Badge variant="secondary">{labelForType(tx.type)}</Badge>
                    <span className="text-xs text-muted-foreground">{formatAge(tx.time)}</span>
                  </div>
                  <div className="text-sm font-mono">
                    <div className="text-xs text-muted-foreground">TX Hash</div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedTx(tx); }}
                        className="text-primary hover:underline"
                        title="View transaction details"
                      >
                        {truncateHash(tx.id || tx.blockHash, 10, 8)}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(tx.id || tx.blockHash); }}
                        className="p-1 hover:bg-secondary rounded transition-colors"
                        title="Copy TX hash"
                      >
                        {copiedAddress === (tx.id || tx.blockHash) ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                      </button>
                    </div>
                  </div>
                  <div className="text-sm font-mono">
                    <div className="text-xs text-muted-foreground">From</div>
                    <div className="flex items-center gap-2">
                      <span title={tx.from}>{truncateHash(tx.from || "—", 10, 8)}</span>
                      {tx.from && (
                        <button
                          onClick={(e) => { e.stopPropagation(); copyToClipboard(tx.from); }}
                          className="p-1 hover:bg-secondary rounded transition-colors"
                          title="Copy address"
                        >
                          {copiedAddress === tx.from ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-sm font-mono">
                    <div className="text-xs text-muted-foreground">To</div>
                    <div className="flex items-center gap-2">
                      <span title={tx.to}>{truncateHash(tx.to || "—", 10, 8)}</span>
                      {tx.to && (
                        <button
                          onClick={(e) => { e.stopPropagation(); copyToClipboard(tx.to); }}
                          className="p-1 hover:bg-secondary rounded transition-colors"
                          title="Copy address"
                        >
                          {copiedAddress === tx.to ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Amount</div>
                      <div className="font-mono">{tx.amount ? tx.amount.toLocaleString() : "—"} <span className="text-primary">{tx.symbol}</span></div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Fee</div>
                      <div className="font-mono">{tx.fee ? tx.fee.toFixed(2) : "0.00"} <span className="text-muted-foreground">XRGE</span></div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Block</div>
                      <div className="font-mono">#{tx.blockHeight}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Block Hash</div>
                      <div className="font-mono">{truncateHash(tx.blockHash, 10, 8)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left py-2 px-2 font-medium">TX Hash</th>
                    <th className="text-left py-2 px-2 font-medium">Age</th>
                    <th className="text-left py-2 px-2 font-medium">Type</th>
                    <th className="text-left py-2 px-2 font-medium">From</th>
                    <th className="text-left py-2 px-2 font-medium">To</th>
                    <th className="text-right py-2 px-2 font-medium">Amount</th>
                    <th className="text-right py-2 px-2 font-medium">Fee</th>
                    <th className="text-left py-2 px-2 font-medium">Block</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paginatedTxs.length === 0 && !isLoading && (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-muted-foreground">
                        No transactions yet.
                      </td>
                    </tr>
                  )}
                  {paginatedTxs.map((tx) => (
                    <tr key={tx.id} className="hover:bg-secondary/40 transition-colors cursor-pointer" onClick={() => setSelectedTx(tx)}>
                      <td className="py-2 px-2 font-mono">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setSelectedTx(tx); }}
                            className="text-primary hover:underline"
                            title="View transaction details"
                          >
                            {truncateHash(tx.id || tx.blockHash, 8, 6)}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); copyToClipboard(tx.id || tx.blockHash); }}
                            className="p-1 hover:bg-secondary rounded transition-colors"
                            title="Copy TX hash"
                          >
                            {copiedAddress === (tx.id || tx.blockHash) ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                          </button>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">{formatAge(tx.time)}</td>
                      <td className="py-2 px-2">
                        <Badge variant="secondary">{labelForType(tx.type)}</Badge>
                      </td>
                      <td className="py-2 px-2 font-mono">
                        <div className="flex items-center gap-1">
                          <span title={tx.from || "—"}>{truncateHash(tx.from || "—")}</span>
                          {tx.from && (
                            <button
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(tx.from); }}
                              className="p-1 hover:bg-secondary rounded transition-colors"
                              title="Copy address"
                            >
                              {copiedAddress === tx.from ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-2 font-mono">
                        <div className="flex items-center gap-1">
                          <span title={tx.to || "—"}>{truncateHash(tx.to || "—")}</span>
                          {tx.to && (
                            <button
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(tx.to); }}
                              className="p-1 hover:bg-secondary rounded transition-colors"
                              title="Copy address"
                            >
                              {copiedAddress === tx.to ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right font-mono">
                        {tx.amount ? tx.amount.toLocaleString() : "—"} <span className="text-primary">{tx.symbol}</span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono">
                        {tx.fee ? tx.fee.toFixed(2) : "0.00"} <span className="text-muted-foreground">XRGE</span>
                      </td>
                      <td className="py-2 px-2 font-mono">#{tx.blockHeight}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-4 border-t border-border">
                <div className="text-sm text-muted-foreground">
                  Showing {startIndex + 1}-{Math.min(startIndex + ITEMS_PER_PAGE, filteredTxs.length)} of {filteredTxs.length} transactions
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? "default" : "outline"}
                          size="sm"
                          onClick={() => goToPage(pageNum)}
                          className="w-8 h-8 p-0"
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Transaction Detail Dialog */}
      <Dialog open={!!selectedTx} onOpenChange={(open) => !open && setSelectedTx(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              Transaction Details
            </DialogTitle>
            <DialogDescription>
              {selectedTx && labelForType(selectedTx.type)} • {selectedTx && formatAge(selectedTx.time)}
            </DialogDescription>
          </DialogHeader>
          
          {selectedTx && (
            <div className="space-y-4">
              {/* Amount */}
              <div className="bg-secondary/50 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Amount</p>
                    <p className="text-xl font-bold font-mono">
                      {selectedTx.amount ? selectedTx.amount.toLocaleString() : "0"} <span className="text-primary">{selectedTx.symbol}</span>
                    </p>
                  </div>
                  <Badge variant="secondary">{labelForType(selectedTx.type)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Fee: {selectedTx.fee?.toFixed(4) || "0.0000"} XRGE</p>
              </div>

              {/* Block & Time Info */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Block</p>
                  <p className="font-mono">#{selectedTx.blockHeight}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Time</p>
                  <p className="font-mono text-xs">{formatFullDate(selectedTx.time)}</p>
                </div>
              </div>

              {/* TX Hash */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">TX Hash</p>
                <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                  <code className="text-xs font-mono flex-1 break-all">{selectedTx.id || selectedTx.blockHash}</code>
                  <button onClick={() => copyToClipboard(selectedTx.id || selectedTx.blockHash)} className="p-1 hover:bg-secondary rounded">
                    {copiedAddress === (selectedTx.id || selectedTx.blockHash) ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>

              {/* From */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">From</p>
                <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                  <code className="text-xs font-mono flex-1 break-all">{selectedTx.from || "—"}</code>
                  {selectedTx.from && (
                    <button onClick={() => copyToClipboard(selectedTx.from)} className="p-1 hover:bg-secondary rounded">
                      {copiedAddress === selectedTx.from ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    </button>
                  )}
                </div>
              </div>

              {/* To */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">To</p>
                <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                  <code className="text-xs font-mono flex-1 break-all">{selectedTx.to || "—"}</code>
                  {selectedTx.to && (
                    <button onClick={() => copyToClipboard(selectedTx.to)} className="p-1 hover:bg-secondary rounded">
                      {copiedAddress === selectedTx.to ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    </button>
                  )}
                </div>
              </div>

              {/* Block Hash */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Block Hash</p>
                <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                  <code className="text-xs font-mono flex-1 break-all">{selectedTx.blockHash}</code>
                  <button onClick={() => copyToClipboard(selectedTx.blockHash)} className="p-1 hover:bg-secondary rounded">
                    {copiedAddress === selectedTx.blockHash ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Transactions;
