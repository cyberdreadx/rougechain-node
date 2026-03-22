import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Check,
  Box,
  Clock,
  Hash,
  Layers,
  ChevronLeft,
  ChevronRight,
  Loader2,
  FileQuestion,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { toast } from "sonner";
import { formatTokenAmount } from "@/hooks/use-eth-price";
import { RougeAddressLink } from "@/components/RougeAddressLink";

interface BlockTransaction {
  txId: string;
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
      token_symbol?: string;
      tokenSymbol?: string;
      target_pub_key?: string;
    };
    fee?: number;
  };
}

interface BlockData {
  height: number;
  hash: string;
  prevHash: string;
  time: number;
  proposer: string;
  txHash: string;
  txCount: number;
  totalFees: number;
  transactions: BlockTransaction[];
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
    case "create_pool":
      return "Create Pool";
    case "add_liquidity":
      return "Add Liquidity";
    case "remove_liquidity":
      return "Remove Liquidity";
    case "nft_mint":
      return "NFT Mint";
    default:
      return type;
  }
};

const BlockDetail = () => {
  const { height } = useParams<{ height: string }>();
  const navigate = useNavigate();
  const [block, setBlock] = useState<BlockData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const blockHeight = Number(height);

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

  useEffect(() => {
    const fetchBlock = async () => {
      setIsLoading(true);
      setNotFound(false);
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) {
          setNotFound(true);
          return;
        }
        const res = await fetch(`${apiBase}/block/${height}`, {
          signal: AbortSignal.timeout(8000),
          headers: getCoreApiHeaders(),
        });
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = await res.json();
        if (!data.success || !data.block) {
          setNotFound(true);
          return;
        }
        setBlock(data.block);
      } catch {
        setNotFound(true);
      } finally {
        setIsLoading(false);
      }
    };

    if (height) fetchBlock();
  }, [height]);

  const CopyButton = ({ value }: { value: string }) => (
    <button
      onClick={() => copyToClipboard(value)}
      className="p-1 hover:bg-secondary rounded transition-colors flex-shrink-0"
      title="Copy"
    >
      {copiedValue === value ? (
        <Check className="w-3.5 h-3.5 text-green-500" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-muted-foreground" />
      )}
    </button>
  );

  if (isLoading) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !block) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
        <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
        <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FileQuestion className="w-16 h-16 text-muted-foreground mb-4" />
            <h2 className="text-2xl font-bold mb-2">Block Not Found</h2>
            <p className="text-muted-foreground mb-4">
              Block #{height} does not exist or could not be loaded.
            </p>
            <Button variant="outline" onClick={() => navigate("/blockchain")}>
              View All Blocks
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const txs = block.transactions ?? [];

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-full max-w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <h1 className="text-2xl font-bold text-foreground">Block #{block.height.toLocaleString()}</h1>
            <Badge variant="outline">{getNetworkLabel()}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={blockHeight <= 0}
              onClick={() => navigate(`/block/${blockHeight - 1}`)}
            >
              <ChevronLeft className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">Previous</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/block/${blockHeight + 1}`)}
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight className="w-4 h-4 sm:ml-1" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Box className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Block Height</p>
              <p className="text-lg font-bold font-mono text-foreground">#{block.height.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Clock className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Timestamp</p>
              <p className="text-sm font-bold text-foreground">{new Date(block.time).toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Layers className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Transaction Count</p>
              <p className="text-lg font-bold font-mono text-foreground">{block.txCount}</p>
            </div>
          </div>
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
              <Hash className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Fees</p>
              <p className="text-lg font-bold font-mono text-foreground">
                {block.totalFees?.toFixed(4) ?? "0.0000"} <span className="text-primary text-sm">XRGE</span>
              </p>
            </div>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Box className="w-4 h-4" />
              Block Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Block Hash</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <code className="text-xs font-mono flex-1 break-all">{block.hash}</code>
                <CopyButton value={block.hash} />
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Previous Hash</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                {blockHeight > 0 ? (
                  <Link
                    to={`/block/${blockHeight - 1}`}
                    className="text-xs font-mono flex-1 break-all text-primary hover:underline"
                  >
                    {block.prevHash}
                  </Link>
                ) : (
                  <code className="text-xs font-mono flex-1 break-all">{block.prevHash || "Genesis"}</code>
                )}
                {block.prevHash && <CopyButton value={block.prevHash} />}
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Proposer</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <RougeAddressLink pubkey={block.proposer} className="text-xs flex-1 break-all" />
                <CopyButton value={block.proposer} />
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">TX Root Hash</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <code className="text-xs font-mono flex-1 break-all">{block.txHash || "\u2014"}</code>
                {block.txHash && <CopyButton value={block.txHash} />}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Transactions
              {txs.length > 0 && (
                <span className="text-xs text-muted-foreground font-normal">({txs.length})</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {txs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No transactions in this block.</p>
            ) : (
              <>
                <div className="md:hidden space-y-3">
                  {txs.map((entry) => {
                    const tx = entry.tx;
                    const payload = tx.payload ?? {};
                    const type = (tx.type ?? tx.tx_type ?? "transfer").toLowerCase();
                    const isFaucet = payload.faucet === true;
                    const from = isFaucet ? "FAUCET" : tx.fromPubKey ?? tx.from_pub_key ?? "";
                    const to = payload.toPubKeyHex ?? payload.to_pub_key_hex ?? payload.target_pub_key ?? "";
                    const tokenSymbol = payload.token_symbol ?? payload.tokenSymbol ?? "XRGE";

                    return (
                      <div key={entry.txId} className="rounded-lg border border-border bg-background/60 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary">{labelForType(isFaucet ? "faucet" : type)}</Badge>
                          <span className="text-xs text-muted-foreground">{tx.fee?.toFixed(2) ?? "0.00"} XRGE</span>
                        </div>
                        <div className="text-sm font-mono">
                          <div className="text-xs text-muted-foreground">TX Hash</div>
                          <Link to={`/tx/${entry.txId}`} className="text-primary hover:underline text-xs">
                            {truncateHash(entry.txId, 12, 8)}
                          </Link>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <div className="text-xs text-muted-foreground">From</div>
                            {from && from !== "FAUCET" ? (
                              <RougeAddressLink pubkey={from} className="text-xs" />
                            ) : (
                              <span className="font-mono text-xs">{from || "—"}</span>
                            )}
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">To</div>
                            {to ? (
                              <RougeAddressLink pubkey={to} className="text-xs" />
                            ) : (
                              <span className="font-mono text-xs">{"\u2014"}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-sm font-mono">
                          <span>{payload.amount ? formatTokenAmount(payload.amount, tokenSymbol) : "\u2014"}</span>
                          {" "}
                          <span className="text-primary">{tokenSymbol}</span>
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
                        <th className="text-left py-2 px-2 font-medium">Type</th>
                        <th className="text-left py-2 px-2 font-medium">From</th>
                        <th className="text-left py-2 px-2 font-medium">To</th>
                        <th className="text-right py-2 px-2 font-medium">Amount</th>
                        <th className="text-right py-2 px-2 font-medium">Fee</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {txs.map((entry) => {
                        const tx = entry.tx;
                        const payload = tx.payload ?? {};
                        const type = (tx.type ?? tx.tx_type ?? "transfer").toLowerCase();
                        const isFaucet = payload.faucet === true;
                        const from = isFaucet ? "FAUCET" : tx.fromPubKey ?? tx.from_pub_key ?? "";
                        const to = payload.toPubKeyHex ?? payload.to_pub_key_hex ?? payload.target_pub_key ?? "";
                        const tokenSymbol = payload.token_symbol ?? payload.tokenSymbol ?? "XRGE";

                        return (
                          <tr key={entry.txId} className="hover:bg-secondary/40 transition-colors">
                            <td className="py-2 px-2 font-mono">
                              <Link to={`/tx/${entry.txId}`} className="text-primary hover:underline">
                                {truncateHash(entry.txId, 8, 6)}
                              </Link>
                            </td>
                            <td className="py-2 px-2">
                              <Badge variant="secondary">{labelForType(isFaucet ? "faucet" : type)}</Badge>
                            </td>
                            <td className="py-2 px-2">
                              {from && from !== "FAUCET" ? (
                                <RougeAddressLink pubkey={from} />
                              ) : (
                                <span title={from}>{from || "\u2014"}</span>
                              )}
                            </td>
                            <td className="py-2 px-2">
                              {to ? (
                                <RougeAddressLink pubkey={to} />
                              ) : (
                                "\u2014"
                              )}
                            </td>
                            <td className="py-2 px-2 text-right font-mono">
                              {payload.amount ? formatTokenAmount(payload.amount, tokenSymbol) : "\u2014"}{" "}
                              <span className="text-primary">{tokenSymbol}</span>
                            </td>
                            <td className="py-2 px-2 text-right font-mono">
                              {tx.fee?.toFixed(2) ?? "0.00"} <span className="text-muted-foreground">XRGE</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between mt-6">
          <Button
            variant="outline"
            size="sm"
            disabled={blockHeight <= 0}
            onClick={() => navigate(`/block/${blockHeight - 1}`)}
          >
            <ChevronLeft className="w-4 h-4 sm:mr-1" />
            <span className="hidden sm:inline">Previous Block</span>
            <span className="sm:hidden">Prev</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/block/${blockHeight + 1}`)}
          >
            <span className="hidden sm:inline">Next Block</span>
            <span className="sm:hidden">Next</span>
            <ChevronRight className="w-4 h-4 sm:ml-1" />
          </Button>
        </div>
      </main>
    </div>
  );
};

export default BlockDetail;
