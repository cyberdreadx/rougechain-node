import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Check,
  FileCode,
  Activity,
  Loader2,
  FileQuestion,
  Play,
  Database,
  Hash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { toast } from "sonner";
import { RougeAddressLink } from "@/components/RougeAddressLink";

interface ContractInfo {
  address: string;
  deployer?: string;
  deploy_tx?: string;
  wasm_size?: number;
  block_height?: number;
  created_at?: number;
}

interface ContractState {
  [key: string]: string;
}

interface CallResult {
  success: boolean;
  output?: string;
  error?: string;
  gasUsed?: number;
}

const ContractDetail = () => {
  const { addr } = useParams<{ addr: string }>();
  const navigate = useNavigate();
  const [contract, setContract] = useState<ContractInfo | null>(null);
  const [state, setState] = useState<ContractState>({});
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  // Call form
  const [method, setMethod] = useState("");
  const [argsJson, setArgsJson] = useState("{}");
  const [caller, setCaller] = useState("");
  const [gasLimit, setGasLimit] = useState("100000");
  const [isCalling, setIsCalling] = useState(false);
  const [callResult, setCallResult] = useState<CallResult | null>(null);

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

  const fetchContract = useCallback(async () => {
    setIsLoading(true);
    setNotFound(false);
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase || !addr) {
        setNotFound(true);
        return;
      }
      const headers = getCoreApiHeaders();

      // Fetch contract info from the contracts list
      const res = await fetch(`${apiBase}/contracts`, {
        signal: AbortSignal.timeout(8000),
        headers,
      });
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const data = await res.json();
      if (!data.success || !Array.isArray(data.contracts)) {
        setNotFound(true);
        return;
      }

      const found = data.contracts.find(
        (c: ContractInfo) => c.address === addr
      );
      if (!found) {
        setNotFound(true);
        return;
      }
      setContract(found);

      // Fetch contract state
      try {
        const stateRes = await fetch(`${apiBase}/contract/${addr}/state`, {
          signal: AbortSignal.timeout(8000),
          headers,
        });
        if (stateRes.ok) {
          const stateData = await stateRes.json();
          if (stateData.success && stateData.state) {
            setState(stateData.state);
          }
        }
      } catch {
        // State endpoint might not exist yet — that's OK
      }
    } catch {
      setNotFound(true);
    } finally {
      setIsLoading(false);
    }
  }, [addr]);

  useEffect(() => {
    if (addr) fetchContract();
  }, [addr, fetchContract]);

  const handleCall = async () => {
    if (!method.trim()) {
      toast.error("Please enter a method name");
      return;
    }
    setIsCalling(true);
    setCallResult(null);
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) throw new Error("No API");

      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(argsJson);
      } catch {
        toast.error("Invalid JSON args");
        setIsCalling(false);
        return;
      }

      const res = await fetch(`${apiBase}/v2/contract/call`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          contractAddr: addr,
          method: method.trim(),
          args: parsedArgs,
          caller: caller.trim() || "anonymous",
          gasLimit: parseInt(gasLimit) || 100000,
        }),
      });

      const result = await res.json();
      setCallResult({
        success: result.success,
        output: result.output ?? result.result ?? null,
        error: result.error ?? null,
        gasUsed: result.gasUsed ?? null,
      });

      if (result.success) {
        toast.success("Contract call successful");
        // Refresh state after successful call
        fetchContract();
      } else {
        toast.error(`Call failed: ${result.error || "unknown error"}`);
      }
    } catch (err) {
      setCallResult({ success: false, error: String(err) });
      toast.error("Failed to call contract");
    } finally {
      setIsCalling(false);
    }
  };

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

  if (notFound || !contract) {
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
            <h2 className="text-2xl font-bold mb-2">Contract Not Found</h2>
            <p className="text-muted-foreground mb-4">
              Contract {addr ? `${addr.slice(0, 12)}...` : ""} does not exist or could not be loaded.
            </p>
            <Button variant="outline" onClick={() => navigate("/contracts")}>
              View All Contracts
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const stateEntries = Object.entries(state);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-6">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Back
          </Button>
          <FileCode className="w-6 h-6 text-primary" />
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">Smart Contract</h1>
          <Badge variant="outline">{getNetworkLabel()}</Badge>
        </div>

        {/* Contract Overview */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Hash className="w-4 h-4" />
              Contract Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Contract Address</p>
              <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                <code className="text-xs font-mono flex-1 break-all text-primary">{contract.address}</code>
                <CopyButton value={contract.address} />
              </div>
            </div>

            {contract.deployer && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Deployer</p>
                <div className="flex items-center gap-2 bg-background rounded border border-border p-2">
                  <RougeAddressLink pubkey={contract.deployer} className="text-xs flex-1 break-all" />
                  <CopyButton value={contract.deployer} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {contract.block_height != null && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Deploy Block</p>
                  <div className="bg-background rounded border border-border p-2">
                    <Link to={`/block/${contract.block_height}`} className="text-sm font-mono text-primary hover:underline">
                      #{contract.block_height.toLocaleString()}
                    </Link>
                  </div>
                </div>
              )}
              {contract.wasm_size != null && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">WASM Size</p>
                  <div className="bg-background rounded border border-border p-2">
                    <span className="text-sm font-mono font-semibold">{contract.wasm_size.toLocaleString()} bytes</span>
                  </div>
                </div>
              )}
              {contract.deploy_tx && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Deploy TX</p>
                  <div className="bg-background rounded border border-border p-2">
                    <Link to={`/tx/${contract.deploy_tx}`} className="text-xs font-mono text-primary hover:underline">
                      {contract.deploy_tx.slice(0, 12)}...{contract.deploy_tx.slice(-6)}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Contract State */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Database className="w-4 h-4" />
              Contract State
              {stateEntries.length > 0 && (
                <span className="text-xs text-muted-foreground font-normal">({stateEntries.length} keys)</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stateEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No state data available.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left py-2 px-2 font-medium">Key</th>
                      <th className="text-left py-2 px-2 font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stateEntries.map(([key, value]) => (
                      <tr key={key} className="hover:bg-secondary/40 transition-colors">
                        <td className="py-2 px-2 font-mono text-xs text-primary">{key}</td>
                        <td className="py-2 px-2 font-mono text-xs break-all">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Call Contract */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Play className="w-4 h-4" />
              Execute Contract
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Method</label>
                <input
                  type="text"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="e.g. get_count, increment, transfer"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Caller</label>
                <input
                  type="text"
                  value={caller}
                  onChange={(e) => setCaller(e.target.value)}
                  placeholder="Caller identity (optional)"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Arguments (JSON)</label>
              <textarea
                value={argsJson}
                onChange={(e) => setArgsJson(e.target.value)}
                rows={3}
                placeholder='{"key": "value"}'
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
              />
            </div>

            <div className="flex items-center gap-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Gas Limit</label>
                <input
                  type="number"
                  value={gasLimit}
                  onChange={(e) => setGasLimit(e.target.value)}
                  className="w-32 px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
              <Button
                className="mt-5"
                onClick={handleCall}
                disabled={isCalling || !method.trim()}
              >
                {isCalling ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Play className="w-4 h-4 mr-2" />
                )}
                Execute
              </Button>
            </div>

            {/* Call Result */}
            {callResult && (
              <div className={`rounded-lg border p-3 ${
                callResult.success
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-red-500/30 bg-red-500/5"
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={callResult.success ? "outline" : "destructive"}>
                    {callResult.success ? "Success" : "Failed"}
                  </Badge>
                  {callResult.gasUsed != null && (
                    <span className="text-xs text-muted-foreground">Gas: {callResult.gasUsed.toLocaleString()}</span>
                  )}
                </div>
                {callResult.output != null && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Output</p>
                    <code className="text-xs font-mono break-all">
                      {typeof callResult.output === "string" ? callResult.output : JSON.stringify(callResult.output)}
                    </code>
                  </div>
                )}
                {callResult.error && (
                  <div>
                    <p className="text-[10px] text-red-500 uppercase tracking-wider mb-1">Error</p>
                    <code className="text-xs font-mono text-red-400 break-all">{callResult.error}</code>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default ContractDetail;
