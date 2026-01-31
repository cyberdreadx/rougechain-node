import { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MainNav } from "@/components/MainNav";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";

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
        parsed.push({
          id: txId || `${blockHash}:${blockHeight}`,
          type: isFaucet ? "faucet" : type,
          from,
          to,
          amount: payload.amount ?? 0,
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
    const interval = setInterval(fetchTxs, 3000);
    return () => clearInterval(interval);
  }, []);

  const filteredTxs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return txs;
    return txs.filter((tx) =>
      [tx.from, tx.to, tx.blockHash, String(tx.blockHeight)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(q))
    );
  }, [query, txs]);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <MainNav />

      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
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
              {filteredTxs.length === 0 && !isLoading && (
                <div className="py-6 text-center text-muted-foreground">
                  No transactions yet.
                </div>
              )}
              {filteredTxs.map((tx) => (
                <div key={tx.id} className="rounded-lg border border-border bg-background/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Badge variant="secondary">{labelForType(tx.type)}</Badge>
                    <span className="text-xs text-muted-foreground">{formatAge(tx.time)}</span>
                  </div>
                  <div className="text-sm font-mono break-all">
                    <div className="text-xs text-muted-foreground">From</div>
                    <div>{tx.from || "—"}</div>
                  </div>
                  <div className="text-sm font-mono break-all">
                    <div className="text-xs text-muted-foreground">To</div>
                    <div>{tx.to || "—"}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Amount</div>
                      <div className="font-mono">{tx.amount ? tx.amount.toLocaleString() : "—"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Fee</div>
                      <div className="font-mono">{tx.fee ? tx.fee.toFixed(2) : "0.00"}</div>
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
                    <th className="text-left py-2 px-2 font-medium">Age</th>
                    <th className="text-left py-2 px-2 font-medium">Type</th>
                    <th className="text-left py-2 px-2 font-medium">From</th>
                    <th className="text-left py-2 px-2 font-medium">To</th>
                    <th className="text-right py-2 px-2 font-medium">Amount</th>
                    <th className="text-right py-2 px-2 font-medium">Fee</th>
                    <th className="text-left py-2 px-2 font-medium">Block</th>
                    <th className="text-left py-2 px-2 font-medium">Block Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredTxs.length === 0 && !isLoading && (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-muted-foreground">
                        No transactions yet.
                      </td>
                    </tr>
                  )}
                  {filteredTxs.map((tx) => (
                    <tr key={tx.id} className="hover:bg-secondary/40 transition-colors">
                      <td className="py-2 px-2 text-muted-foreground">{formatAge(tx.time)}</td>
                      <td className="py-2 px-2">
                        <Badge variant="secondary">{labelForType(tx.type)}</Badge>
                      </td>
                      <td className="py-2 px-2 font-mono" title={tx.from || "—"}>
                        {truncateHash(tx.from || "—")}
                      </td>
                      <td className="py-2 px-2 font-mono" title={tx.to || "—"}>
                        {truncateHash(tx.to || "—")}
                      </td>
                      <td className="py-2 px-2 text-right font-mono">
                        {tx.amount ? tx.amount.toLocaleString() : "—"}
                      </td>
                      <td className="py-2 px-2 text-right font-mono">
                        {tx.fee ? tx.fee.toFixed(2) : "0.00"}
                      </td>
                      <td className="py-2 px-2 font-mono">#{tx.blockHeight}</td>
                      <td className="py-2 px-2 font-mono" title={tx.blockHash}>
                        {truncateHash(tx.blockHash, 10, 8)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Transactions;
