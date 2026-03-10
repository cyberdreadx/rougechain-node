import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Check,
  CheckCircle2,
  Loader2,
  FileQuestion,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { toast } from "sonner";
import { formatTokenAmount } from "@/hooks/use-eth-price";

interface TxPayload {
  to_pub_key_hex?: string;
  toPubKeyHex?: string;
  amount?: number;
  faucet?: boolean;
  token_symbol?: string;
  tokenSymbol?: string;
  target_pub_key?: string;
  token_a?: string;
  token_b?: string;
  amount_a?: number;
  amount_b?: number;
  token_name?: string;
  tokenName?: string;
  pool_id?: string;
  lp_amount?: number;
  min_amount_a?: number;
  min_amount_b?: number;
  amount_in?: number;
  min_amount_out?: number;
  token_in?: string;
  token_out?: string;
  nft_id?: string;
  metadata_uri?: string;
}

interface TxData {
  txId: string;
  blockHeight: number;
  blockHash: string;
  blockTime: number;
  tx: {
    tx_type?: string;
    type?: string;
    from_pub_key?: string;
    fromPubKey?: string;
    payload?: TxPayload;
    fee?: number;
  };
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

const badgeVariantForType = (type: string): "default" | "secondary" | "outline" | "destructive" => {
  switch (type) {
    case "transfer":
    case "faucet":
      return "secondary";
    case "stake":
    case "unstake":
      return "outline";
    case "swap":
    case "create_pool":
    case "add_liquidity":
    case "remove_liquidity":
      return "default";
    default:
      return "secondary";
  }
};

const TransactionDetail = () => {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const [txData, setTxData] = useState<TxData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

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
    const fetchTx = async () => {
      setIsLoading(true);
      setNotFound(false);
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) {
          setNotFound(true);
          return;
        }
        const res = await fetch(`${apiBase}/tx/${hash}`, {
          signal: AbortSignal.timeout(8000),
          headers: getCoreApiHeaders(),
        });
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = await res.json();
        if (!data.success) {
          setNotFound(true);
          return;
        }
        setTxData({
          txId: data.txId ?? hash ?? "",
          blockHeight: data.blockHeight ?? 0,
          blockHash: data.blockHash ?? "",
          blockTime: data.blockTime ?? Date.now(),
          tx: data.tx ?? {},
        });
      } catch {
        setNotFound(true);
      } finally {
        setIsLoading(false);
      }
    };

    if (hash) fetchTx();
  }, [hash]);

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

  if (notFound || !txData) {
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
            <h2 className="text-2xl font-bold mb-2">Transaction Not Found</h2>
            <p className="text-muted-foreground mb-4">
              This transaction does not exist or could not be loaded.
            </p>
            <Button variant="outline" onClick={() => navigate("/transactions")}>
              View All Transactions
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const tx = txData.tx;
  const payload = tx.payload ?? {};
  const rawType = (tx.type ?? tx.tx_type ?? "transfer").toLowerCase();
  const isFaucet = payload.faucet === true;
  const txType = isFaucet ? "faucet" : rawType;
  const from = isFaucet ? "FAUCET" : tx.fromPubKey ?? tx.from_pub_key ?? "";
  const to = payload.toPubKeyHex ?? payload.to_pub_key_hex ?? payload.target_pub_key ?? "";
  const tokenSymbol = payload.token_symbol ?? payload.tokenSymbol ?? "XRGE";
  const isSwapOrAmm = ["swap", "create_pool", "add_liquidity", "remove_liquidity"].includes(txType);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-full max-w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <h1 className="text-2xl font-bold text-foreground">Transaction Details</h1>
          <Badge variant={badgeVariantForType(txType)}>{labelForType(txType)}</Badge>
        </div>

        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 flex items-center gap-3 mb-6">
          <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-green-500">Confirmed</p>
            <p className="text-xs text-muted-foreground">
              This transaction has been included in block #{txData.blockHeight.toLocaleString()}
            </p>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">TX Hash</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <code className="text-xs font-mono flex-1 break-all">{txData.txId}</code>
                <CopyButton value={txData.txId} />
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Status</p>
              <Badge variant="outline" className="border-green-500/50 text-green-500">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Confirmed
              </Badge>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Block</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <Link
                  to={`/block/${txData.blockHeight}`}
                  className="text-sm font-mono text-primary hover:underline"
                >
                  #{txData.blockHeight.toLocaleString()}
                </Link>
                {txData.blockHash && (
                  <span className="text-xs font-mono text-muted-foreground ml-2 truncate hidden sm:inline">
                    {txData.blockHash}
                  </span>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Timestamp</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <span className="text-sm">
                  {new Date(txData.blockTime).toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">({formatAge(txData.blockTime)})</span>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">From</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                {from && from !== "FAUCET" ? (
                  <Link
                    to={`/address/${from}`}
                    className="text-xs font-mono flex-1 break-all text-primary hover:underline"
                  >
                    {from}
                  </Link>
                ) : (
                  <code className="text-xs font-mono flex-1 break-all">{from || "\u2014"}</code>
                )}
                {from && from !== "FAUCET" && <CopyButton value={from} />}
              </div>
            </div>

            {to && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">To</p>
                <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                  <Link
                    to={`/address/${to}`}
                    className="text-xs font-mono flex-1 break-all text-primary hover:underline"
                  >
                    {to}
                  </Link>
                  <CopyButton value={to} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Amount</p>
                <div className="bg-background rounded border border-border p-2">
                  <span className="text-sm font-mono font-semibold">
                    {payload.amount != null ? formatTokenAmount(payload.amount, tokenSymbol) : "\u2014"}
                  </span>
                  {" "}
                  <Link to={`/token/${tokenSymbol}`} className="text-primary text-sm hover:underline">
                    {tokenSymbol}
                  </Link>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Fee</p>
                <div className="bg-background rounded border border-border p-2">
                  <span className="text-sm font-mono font-semibold">
                    {tx.fee?.toFixed(4) ?? "0.0000"}
                  </span>
                  {" "}
                  <span className="text-primary text-sm">XRGE</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Type</p>
                <div className="bg-background rounded border border-border p-2">
                  <Badge variant={badgeVariantForType(txType)}>{labelForType(txType)}</Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {isSwapOrAmm && (payload.token_a || payload.token_b || payload.token_in || payload.token_out) && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="w-4 h-4" />
                {txType === "swap" ? "Swap Details" : "AMM Details"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {txType === "swap" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {payload.token_in && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Token In</p>
                      <div className="bg-background rounded border border-border p-2 flex items-center gap-2">
                        <Link to={`/token/${payload.token_in}`} className="text-sm font-mono text-primary hover:underline">
                          {payload.token_in}
                        </Link>
                        {payload.amount_in != null && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatTokenAmount(payload.amount_in, payload.token_in)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {payload.token_out && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Token Out</p>
                      <div className="bg-background rounded border border-border p-2 flex items-center gap-2">
                        <Link to={`/token/${payload.token_out}`} className="text-sm font-mono text-primary hover:underline">
                          {payload.token_out}
                        </Link>
                        {payload.min_amount_out != null && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            min: {formatTokenAmount(payload.min_amount_out, payload.token_out)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {txType !== "swap" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {payload.token_a && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Token A</p>
                      <div className="bg-background rounded border border-border p-2 flex items-center gap-2">
                        <Link to={`/token/${payload.token_a}`} className="text-sm font-mono text-primary hover:underline">
                          {payload.token_a}
                        </Link>
                        {payload.amount_a != null && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatTokenAmount(payload.amount_a, payload.token_a)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {payload.token_b && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Token B</p>
                      <div className="bg-background rounded border border-border p-2 flex items-center gap-2">
                        <Link to={`/token/${payload.token_b}`} className="text-sm font-mono text-primary hover:underline">
                          {payload.token_b}
                        </Link>
                        {payload.amount_b != null && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatTokenAmount(payload.amount_b, payload.token_b)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {payload.pool_id && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Pool ID</p>
                  <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                    <Link to={`/pool/${payload.pool_id}`} className="text-xs font-mono flex-1 break-all text-primary hover:underline">
                      {payload.pool_id}
                    </Link>
                    <CopyButton value={payload.pool_id} />
                  </div>
                </div>
              )}

              {payload.lp_amount != null && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">LP Tokens</p>
                  <div className="bg-background rounded border border-border p-2">
                    <span className="text-sm font-mono">{payload.lp_amount.toLocaleString()}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
};

export default TransactionDetail;
