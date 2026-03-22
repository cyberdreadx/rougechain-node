import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Check,
  Wallet,
  Activity,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  ArrowDownLeft,
  Coins,
  Image,
  Droplets,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { toast } from "sonner";
import { formatTokenAmount } from "@/hooks/use-eth-price";
import { RougeAddressLink } from "@/components/RougeAddressLink";
import { useRougeAddress } from "@/hooks/useRougeAddress";

const ITEMS_PER_PAGE = 20;

interface BalanceData {
  balance: number;
  token_balances: Record<string, number>;
  lp_balances: Record<string, number>;
}

interface AddressTx {
  txId: string;
  blockHeight: number;
  blockHash: string;
  blockTime: number;
  direction: string;
  tx: {
    tx_type?: string;
    type?: string;
    from_pub_key?: string;
    fromPubKey?: string;
    fee?: number;
    payload?: {
      to_pub_key_hex?: string;
      toPubKeyHex?: string;
      amount?: number;
      faucet?: boolean;
      token_symbol?: string;
      tokenSymbol?: string;
    };
  };
}

interface NftItem {
  collection_id: string;
  token_id: string;
  name: string;
  metadata_uri?: string;
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
  if (!value) return "\u2014";
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
};

const extractSymbol = (key: string): string => {
  const commaIdx = key.indexOf(",");
  if (commaIdx === -1) return key;
  return key.slice(commaIdx + 1);
};

const extractPoolId = (key: string): string => {
  const commaIdx = key.indexOf(",");
  if (commaIdx === -1) return key;
  return key.slice(commaIdx + 1);
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
    case "swap":
      return "Swap";
    case "add_liquidity":
      return "Add Liquidity";
    case "remove_liquidity":
      return "Remove Liquidity";
    case "mint_nft":
      return "Mint NFT";
    default:
      return type;
  }
};

const AddressDetail = () => {
  const { pubkey } = useParams<{ pubkey: string }>();
  const { display: rougeAddr, full: rougeAddrFull } = useRougeAddress(pubkey);
  const [balanceData, setBalanceData] = useState<BalanceData | null>(null);
  const [transactions, setTransactions] = useState<AddressTx[]>([]);
  const [totalTxs, setTotalTxs] = useState(0);
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

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

  const fetchData = useCallback(async () => {
    if (!pubkey) return;

    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) return;
      const headers = getCoreApiHeaders();

      const [balanceRes, txRes, nftRes] = await Promise.all([
        fetch(`${apiBase}/balance/${pubkey}`, {
          signal: AbortSignal.timeout(8000),
          headers,
        }),
        fetch(`${apiBase}/address/${pubkey}/transactions?limit=50`, {
          signal: AbortSignal.timeout(8000),
          headers,
        }),
        fetch(`${apiBase}/nft/owner/${pubkey}`, {
          signal: AbortSignal.timeout(8000),
          headers,
        }),
      ]);

      if (balanceRes.ok) {
        const data = await balanceRes.json();
        setBalanceData({
          balance: data.balance ?? 0,
          token_balances: data.token_balances ?? {},
          lp_balances: data.lp_balances ?? {},
        });
      }

      if (txRes.ok) {
        const data = await txRes.json();
        setTransactions(data.transactions ?? []);
        setTotalTxs(data.total ?? data.transactions?.length ?? 0);
      }

      if (nftRes.ok) {
        const data = await nftRes.json();
        setNfts(data.nfts ?? []);
      }
    } catch (e) {
      console.error("Failed to fetch address data:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [pubkey]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const getTxType = (tx: AddressTx): string => {
    const raw = tx.tx?.type ?? tx.tx?.tx_type ?? "transfer";
    if (tx.tx?.payload?.faucet) return "faucet";
    return raw.toLowerCase();
  };

  const getCounterparty = (tx: AddressTx): string => {
    const from = tx.tx?.fromPubKey ?? tx.tx?.from_pub_key ?? "";
    const to = tx.tx?.payload?.toPubKeyHex ?? tx.tx?.payload?.to_pub_key_hex ?? "";
    if (tx.direction === "in" || from.toLowerCase() !== pubkey?.toLowerCase()) {
      return from;
    }
    return to;
  };

  const getTxAmount = (tx: AddressTx): number => {
    return tx.tx?.payload?.amount ?? 0;
  };

  const getTxSymbol = (tx: AddressTx): string => {
    return tx.tx?.payload?.token_symbol || tx.tx?.payload?.tokenSymbol || "XRGE";
  };

  const tokenBalanceEntries = balanceData
    ? Object.entries(balanceData.token_balances).filter(([, v]) => v > 0)
    : [];

  const lpBalanceEntries = balanceData
    ? Object.entries(balanceData.lp_balances).filter(([, v]) => v > 0)
    : [];

  const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedTxs = transactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-full max-w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link to="/transactions">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-foreground">Address</h1>
                <Badge variant="outline">{getNetworkLabel()}</Badge>
              </div>
              {rougeAddr && (
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono text-primary break-all">
                    {rougeAddr}
                  </code>
                  {rougeAddrFull && (
                    <button
                      onClick={() => copyToClipboard(rougeAddrFull)}
                      className="p-1 hover:bg-secondary rounded transition-colors shrink-0"
                      title="Copy rouge1 address"
                    >
                      {copiedValue === rougeAddrFull ? (
                        <Check className="w-3.5 h-3.5 text-green-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono text-muted-foreground break-all">
                  {pubkey}
                </code>
                <button
                  onClick={() => copyToClipboard(pubkey ?? "")}
                  className="p-1 hover:bg-secondary rounded transition-colors shrink-0"
                  title="Copy public key"
                >
                  {copiedValue === pubkey ? (
                    <Check className="w-3.5 h-3.5 text-green-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </button>
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Wallet className="w-5 h-5 text-primary" />
                <CardTitle>Balance Overview</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <p className="text-sm text-muted-foreground mb-1">XRGE Balance</p>
                <p className="text-3xl font-bold text-primary font-mono">
                  {formatTokenAmount(balanceData?.balance ?? 0, "XRGE")}
                  <span className="text-lg ml-2">XRGE</span>
                </p>
              </div>

              {tokenBalanceEntries.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Coins className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium text-muted-foreground">Token Balances</p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {tokenBalanceEntries.map(([key, value]) => {
                      const symbol = extractSymbol(key);
                      return (
                        <Link
                          key={key}
                          to={`/token/${symbol}`}
                          className="bg-muted/30 hover:bg-muted/50 border border-border rounded-lg p-3 transition-colors"
                        >
                          <p className="text-xs text-muted-foreground">{symbol}</p>
                          <p className="text-lg font-bold font-mono text-primary">
                            {formatTokenAmount(value, symbol)}
                          </p>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}

              {lpBalanceEntries.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Droplets className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium text-muted-foreground">LP Positions</p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {lpBalanceEntries.map(([key, value]) => {
                      const poolId = extractPoolId(key);
                      return (
                        <div
                          key={key}
                          className="bg-muted/30 border border-border rounded-lg p-3"
                        >
                          <p className="text-xs text-muted-foreground font-mono">
                            {truncateHash(poolId, 6, 4)}
                          </p>
                          <p className="text-lg font-bold font-mono">
                            {formatTokenAmount(value, "LP")}
                            <span className="text-sm text-muted-foreground ml-1">LP</span>
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {!balanceData && (
                <div className="py-6 text-center text-muted-foreground">
                  Unable to load balance data.
                </div>
              )}
            </CardContent>
          </Card>

          {nfts.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Image className="w-5 h-5 text-primary" />
                  <CardTitle>NFTs</CardTitle>
                  <Badge variant="secondary">{nfts.length}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {nfts.map((nft) => (
                    <div
                      key={`${nft.collection_id}-${nft.token_id}`}
                      className="bg-muted/30 hover:bg-muted/50 border border-border rounded-lg p-4 transition-colors"
                    >
                      <div className="w-full aspect-square bg-secondary/50 rounded-md flex items-center justify-center mb-3">
                        <Image className="w-8 h-8 text-muted-foreground" />
                      </div>
                      <p className="font-medium text-sm truncate">
                        {nft.name || `#${nft.token_id}`}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono mt-1">
                        {truncateHash(nft.collection_id, 6, 4)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Token #{nft.token_id}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Activity className="w-5 h-5 text-primary" />
                  <CardTitle>Transaction History</CardTitle>
                </div>
                <span className="text-sm text-muted-foreground">
                  {totalTxs} total
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="md:hidden space-y-3">
                {paginatedTxs.length === 0 && (
                  <div className="py-6 text-center text-muted-foreground">
                    No transactions found for this address.
                  </div>
                )}
                {paginatedTxs.map((tx) => {
                  const dir = tx.direction === "in" ? "in" : "out";
                  const counterparty = getCounterparty(tx);
                  const amount = getTxAmount(tx);
                  const symbol = getTxSymbol(tx);
                  return (
                    <div
                      key={tx.txId}
                      className="rounded-lg border border-border bg-background/60 p-3 space-y-2 overflow-hidden"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {dir === "in" ? (
                            <ArrowDownLeft className="w-4 h-4 text-green-500" />
                          ) : (
                            <ArrowUpRight className="w-4 h-4 text-red-500" />
                          )}
                          <Badge variant="secondary">{labelForType(getTxType(tx))}</Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">{formatAge(tx.blockTime)}</span>
                      </div>
                      <div className="text-sm font-mono">
                        <div className="text-xs text-muted-foreground">TX Hash</div>
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/tx/${tx.txId}`}
                            className="text-primary hover:underline"
                          >
                            {truncateHash(tx.txId, 10, 8)}
                          </Link>
                          <button
                            onClick={() => copyToClipboard(tx.txId)}
                            className="p-1 hover:bg-secondary rounded transition-colors"
                          >
                            {copiedValue === tx.txId ? (
                              <Check className="w-3 h-3 text-green-500" />
                            ) : (
                              <Copy className="w-3 h-3 text-muted-foreground" />
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="text-sm font-mono">
                        <div className="text-xs text-muted-foreground">Counterparty</div>
                        {counterparty ? (
                          <RougeAddressLink pubkey={counterparty} />
                        ) : (
                          <span>{"\u2014"}</span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                        <div>
                          <div className="text-xs text-muted-foreground">Amount</div>
                          <div className="font-mono">
                            {amount ? formatTokenAmount(amount, symbol) : "\u2014"}{" "}
                            <span className="text-primary">{symbol}</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">Fee</div>
                          <div className="font-mono">
                            {tx.tx?.fee ? tx.tx.fee.toFixed(2) : "0.00"}{" "}
                            <span className="text-muted-foreground">XRGE</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">Block</div>
                          <Link to={`/block/${tx.blockHeight}`} className="font-mono text-primary hover:underline">
                            #{tx.blockHeight}
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left py-2 px-2 font-medium">TX Hash</th>
                      <th className="text-left py-2 px-2 font-medium">Age</th>
                      <th className="text-left py-2 px-2 font-medium">Type</th>
                      <th className="text-left py-2 px-2 font-medium">Direction</th>
                      <th className="text-left py-2 px-2 font-medium">Counterparty</th>
                      <th className="text-right py-2 px-2 font-medium">Amount</th>
                      <th className="text-right py-2 px-2 font-medium">Fee</th>
                      <th className="text-left py-2 px-2 font-medium">Block</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {paginatedTxs.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-6 text-center text-muted-foreground">
                          No transactions found for this address.
                        </td>
                      </tr>
                    )}
                    {paginatedTxs.map((tx) => {
                      const dir = tx.direction === "in" ? "in" : "out";
                      const counterparty = getCounterparty(tx);
                      const amount = getTxAmount(tx);
                      const symbol = getTxSymbol(tx);
                      return (
                        <tr key={tx.txId} className="hover:bg-secondary/40 transition-colors">
                          <td className="py-2 px-2 font-mono">
                            <div className="flex items-center gap-1">
                              <Link
                                to={`/tx/${tx.txId}`}
                                className="text-primary hover:underline"
                              >
                                {truncateHash(tx.txId, 8, 6)}
                              </Link>
                              <button
                                onClick={() => copyToClipboard(tx.txId)}
                                className="p-1 hover:bg-secondary rounded transition-colors"
                              >
                                {copiedValue === tx.txId ? (
                                  <Check className="w-3 h-3 text-green-500" />
                                ) : (
                                  <Copy className="w-3 h-3 text-muted-foreground" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-2 px-2 text-muted-foreground">
                            {formatAge(tx.blockTime)}
                          </td>
                          <td className="py-2 px-2">
                            <Badge variant="secondary">{labelForType(getTxType(tx))}</Badge>
                          </td>
                          <td className="py-2 px-2">
                            <div className="flex items-center gap-1.5">
                              {dir === "in" ? (
                                <ArrowDownLeft className="w-4 h-4 text-green-500" />
                              ) : (
                                <ArrowUpRight className="w-4 h-4 text-red-500" />
                              )}
                              <span className={dir === "in" ? "text-green-500" : "text-red-500"}>
                                {dir === "in" ? "IN" : "OUT"}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-2 font-mono">
                            {counterparty ? (
                              <RougeAddressLink pubkey={counterparty} />
                            ) : (
                              "\u2014"
                            )}
                          </td>
                          <td className="py-2 px-2 text-right font-mono">
                            {amount ? formatTokenAmount(amount, symbol) : "\u2014"}{" "}
                            <span className="text-primary">{symbol}</span>
                          </td>
                          <td className="py-2 px-2 text-right font-mono">
                            {tx.tx?.fee ? tx.tx.fee.toFixed(2) : "0.00"}{" "}
                            <span className="text-muted-foreground">XRGE</span>
                          </td>
                          <td className="py-2 px-2 font-mono">
                            <Link
                              to={`/block/${tx.blockHeight}`}
                              className="text-primary hover:underline"
                            >
                              #{tx.blockHeight}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-4 border-t border-border mt-4">
                  <div className="text-xs sm:text-sm text-muted-foreground">
                    Showing {startIndex + 1}-{Math.min(startIndex + ITEMS_PER_PAGE, transactions.length)} of {transactions.length}
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
        </div>
      </main>
    </div>
  );
};

export default AddressDetail;
