import { useState, useEffect, useCallback, useRef } from "react";
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
  Eye,
  PenLine,
  Radio,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { toast } from "sonner";
import { RougeAddressLink } from "@/components/RougeAddressLink";
import { useBlockchainWs, type WsContractEvent } from "@/hooks/use-blockchain-ws";
import {
  CONTRACT_MAX_GAS,
  contractCallFee,
  currentContractSigner,
  executeContract,
  fetchContractEvents,
  normAddr,
  queryContract,
  receiptError,
  suggestGasLimit,
  waitForTxReceipt,
  type ContractEvent,
  type ContractQueryResult,
} from "@/lib/contracts";

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

/** A signed call waiting for the user's confirmation. */
interface PendingCall {
  method: string;
  args: unknown;
  gasLimit: number;
  preview: ContractQueryResult;
}

interface Submission {
  txId: string;
  method: string;
  gasLimit: number;
  fee: number;
  preview?: { returnData?: unknown; gasUsed?: number };
  status: "pending" | "success" | "failed" | "timeout";
  error?: string | null;
  blockHeight?: number;
}

const MAX_EVENTS = 100;

function fmtData(v: unknown): string {
  if (v === undefined || v === null) return "null";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function fmtXrge(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} XRGE`;
}

function eventKey(e: ContractEvent, i?: number): string {
  return `${e.tx_hash}|${e.block_height}|${e.topic}|${e.data}${i === undefined ? "" : `|${i}`}`;
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
  const [gasLimit, setGasLimit] = useState("");
  const [busy, setBusy] = useState<"query" | "preview" | "sign" | null>(null);
  const [queryResult, setQueryResult] = useState<ContractQueryResult | null>(null);
  const [pending, setPending] = useState<PendingCall | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const receiptWait = useRef<{ cancelled: boolean } | null>(null);

  // Events
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  const signer = currentContractSigner();

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

  const refreshState = useCallback(async () => {
    const apiBase = getCoreApiBaseUrl();
    if (!apiBase || !addr) return;
    try {
      const stateRes = await fetch(`${apiBase}/contract/${encodeURIComponent(addr)}/state`, {
        signal: AbortSignal.timeout(8000),
        headers: getCoreApiHeaders(),
      });
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (stateData.success && stateData.state) setState(stateData.state);
      }
    } catch {
      // state is optional
    }
  }, [addr]);

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
        (c: ContractInfo) => normAddr(c.address) === normAddr(addr)
      );
      if (!found) {
        setNotFound(true);
        return;
      }
      setContract(found);
      await refreshState();
    } catch {
      setNotFound(true);
    } finally {
      setIsLoading(false);
    }
  }, [addr, refreshState]);

  useEffect(() => {
    if (addr) fetchContract();
  }, [addr, fetchContract]);

  // ── Events: stored page + live WS `contract:<addr>` frames, polling when WS is down ──

  const loadEvents = useCallback(async () => {
    if (!addr) return;
    try {
      const list = await fetchContractEvents(addr, { limit: 50 });
      setEvents(list.slice(0, MAX_EVENTS));
    } catch {
      // node may not serve events; keep what we have
    } finally {
      setEventsLoaded(true);
    }
  }, [addr]);

  useEffect(() => {
    setEvents([]);
    setEventsLoaded(false);
    loadEvents();
  }, [loadEvents]);

  const onContractEvent = useCallback(
    (e: WsContractEvent) => {
      if (!addr || normAddr(e.contract_addr) !== normAddr(addr)) return;
      const ev: ContractEvent = {
        contract_addr: e.contract_addr,
        topic: e.topic,
        data: e.data,
        block_height: e.block_height,
        tx_hash: e.tx_hash,
      };
      setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS));
    },
    [addr]
  );

  const { connectionType } = useBlockchainWs({
    topics: addr ? ["blocks", `contract:${normAddr(addr)}`] : ["blocks"],
    onContractEvent,
    fallbackPollInterval: 10000,
  });
  const liveEvents = connectionType === "websocket";

  // When the socket (re)connects, refetch once to fill any gap; while it's down, poll.
  useEffect(() => {
    if (liveEvents) {
      loadEvents();
      return;
    }
    const t = setInterval(loadEvents, 10000);
    return () => clearInterval(t);
  }, [liveEvents, loadEvents]);

  useEffect(() => () => {
    if (receiptWait.current) receiptWait.current.cancelled = true;
  }, []);

  // ── Calls ──

  const parseArgs = (): { ok: true; value: unknown } | { ok: false } => {
    const text = argsJson.trim();
    if (!text) return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      toast.error("Invalid JSON args");
      return { ok: false };
    }
  };

  const handleQuery = async () => {
    if (!addr || !method.trim()) {
      toast.error("Please enter a method name");
      return;
    }
    const args = parseArgs();
    if (!args.ok) return;
    setBusy("query");
    setQueryResult(null);
    try {
      const r = await queryContract(addr, method.trim(), args.value, caller.trim() || signer?.publicKey);
      setQueryResult(r);
      if (!r.success) toast.error(`Query failed: ${r.error || "unknown error"}`);
    } catch (err) {
      setQueryResult({ success: false, gasUsed: 0, events: [], error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  /** Dry-run as the connected wallet to size gas and show the preview before signing. */
  const handlePrepareExecute = async () => {
    if (!addr || !method.trim()) {
      toast.error("Please enter a method name");
      return;
    }
    if (!signer) {
      toast.error("Connect or unlock a wallet to send a signed call");
      return;
    }
    const args = parseArgs();
    if (!args.ok) return;
    let manualGas: number | undefined;
    if (gasLimit.trim()) {
      manualGas = Number(gasLimit);
      if (!Number.isInteger(manualGas) || manualGas < 1 || manualGas > CONTRACT_MAX_GAS) {
        toast.error(`Gas limit must be an integer between 1 and ${CONTRACT_MAX_GAS.toLocaleString()}`);
        return;
      }
    }
    setBusy("preview");
    setPending(null);
    setQueryResult(null);
    try {
      const preview = await queryContract(addr, method.trim(), args.value, signer.publicKey);
      if (!preview.success) {
        setQueryResult(preview);
        toast.error(`This call would fail: ${preview.error || "unknown error"}`);
        return;
      }
      const limit = manualGas ?? suggestGasLimit(preview.gasUsed);
      if (limit < preview.gasUsed) {
        toast.warning(`Gas limit ${limit.toLocaleString()} is below the ${preview.gasUsed.toLocaleString()} gas the call needs; the node will refuse it.`);
      }
      setPending({ method: method.trim(), args: args.value, gasLimit: limit, preview });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSignAndSubmit = async () => {
    if (!addr || !pending) return;
    setBusy("sign");
    try {
      const r = await executeContract(addr, pending.method, pending.args, pending.gasLimit);
      if (!r.success || !r.txId) {
        toast.error(`Call refused: ${r.error || "unknown error"}`);
        return;
      }
      const sub: Submission = {
        txId: r.txId,
        method: pending.method,
        gasLimit: pending.gasLimit,
        fee: r.fee ?? contractCallFee(pending.gasLimit),
        preview: r.preview ?? { returnData: pending.preview.returnData, gasUsed: pending.preview.gasUsed },
        status: "pending",
      };
      setSubmission(sub);
      setPending(null);
      toast.success("Call submitted — waiting for a block");

      if (receiptWait.current) receiptWait.current.cancelled = true;
      const token = { cancelled: false };
      receiptWait.current = token;
      const receipt = await waitForTxReceipt(r.txId, { signal: token });
      if (token.cancelled) return;
      if (!receipt) {
        setSubmission({ ...sub, status: "timeout" });
        return;
      }
      const err = receiptError(receipt.status);
      setSubmission({ ...sub, status: err ? "failed" : "success", error: err, blockHeight: receipt.block_height });
      if (err) toast.error(`Call reverted in block: ${err}`);
      else toast.success("Call included");
      refreshState();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
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
      <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !contract) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen relative overflow-x-hidden">
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
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen relative overflow-x-hidden">
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
              Call Contract
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              <strong>Query</strong> is a free read-only dry run. <strong>Execute</strong> is a transaction signed by
              your wallet: the contract sees your key as the caller and you pay{" "}
              <code>gas limit × {"0.000001"} XRGE</code>.
            </p>
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
                <label className="text-xs text-muted-foreground mb-1 block">Query caller (optional)</label>
                <input
                  type="text"
                  value={caller}
                  onChange={(e) => setCaller(e.target.value)}
                  placeholder={signer ? "Defaults to your wallet key" : "Public key the contract sees"}
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

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Gas limit (execute)</label>
                <input
                  type="number"
                  value={gasLimit}
                  onChange={(e) => setGasLimit(e.target.value)}
                  placeholder="auto"
                  min={1}
                  max={CONTRACT_MAX_GAS}
                  className="w-36 px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
              <Button variant="outline" onClick={handleQuery} disabled={busy !== null || !method.trim()}>
                {busy === "query" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
                Query (free)
              </Button>
              <Button onClick={handlePrepareExecute} disabled={busy !== null || !method.trim() || !signer}>
                {busy === "preview" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <PenLine className="w-4 h-4 mr-2" />}
                Execute…
              </Button>
            </div>
            {!signer && (
              <p className="text-xs text-muted-foreground">Connect or unlock a wallet to send signed calls.</p>
            )}

            {/* Query result */}
            {queryResult && (
              <div className={`rounded-lg border p-3 ${
                queryResult.success ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={queryResult.success ? "outline" : "destructive"}>
                    {queryResult.success ? "Query OK" : "Query failed"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">Gas used: {queryResult.gasUsed.toLocaleString()}</span>
                </div>
                {queryResult.success && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Return data</p>
                    <code className="text-xs font-mono break-all">{fmtData(queryResult.returnData)}</code>
                  </div>
                )}
                {queryResult.events.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Would emit: {queryResult.events.map((e) => e.topic).join(", ")}
                  </p>
                )}
                {queryResult.error && (
                  <div>
                    <p className="text-xs text-red-500 uppercase tracking-wider mb-1">Error</p>
                    <code className="text-xs font-mono text-red-400 break-all">{queryResult.error}</code>
                  </div>
                )}
              </div>
            )}

            {/* Preview awaiting signature */}
            {pending && (
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Review signed call</p>
                  <button onClick={() => setPending(null)} className="p-1 rounded hover:bg-secondary" title="Cancel">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Method</p><code className="font-mono">{pending.method}</code></div>
                  <div><p className="text-muted-foreground">Gas used (preview)</p><span className="font-mono">{pending.preview.gasUsed.toLocaleString()}</span></div>
                  <div><p className="text-muted-foreground">Gas limit (signed)</p><span className="font-mono">{pending.gasLimit.toLocaleString()}</span></div>
                  <div><p className="text-muted-foreground">Fee (charged)</p><span className="font-mono">{fmtXrge(contractCallFee(pending.gasLimit))}</span></div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Preview result</p>
                  <code className="text-xs font-mono break-all">{fmtData(pending.preview.returnData)}</code>
                </div>
                {pending.preview.events.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Emits: {pending.preview.events.map((e) => e.topic).join(", ")}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  The fee is charged on the signed gas limit. The block run is authoritative: if state changes first,
                  the call can still revert there (fee charged, receipt shows Failed).
                  {signer?.viaExtension ? " Your wallet extension will ask you to approve." : ""}
                </p>
                <Button onClick={handleSignAndSubmit} disabled={busy !== null}>
                  {busy === "sign" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <PenLine className="w-4 h-4 mr-2" />}
                  Sign &amp; submit
                </Button>
              </div>
            )}

            {/* Submitted tx + receipt */}
            {submission && (
              <div className={`rounded-lg border p-3 space-y-2 ${
                submission.status === "success"
                  ? "border-green-500/30 bg-green-500/5"
                  : submission.status === "failed"
                    ? "border-red-500/30 bg-red-500/5"
                    : "border-border"
              }`}>
                <div className="flex flex-wrap items-center gap-2">
                  {submission.status === "pending" && (
                    <Badge variant="outline"><Loader2 className="w-3 h-3 animate-spin mr-1" />Pending</Badge>
                  )}
                  {submission.status === "success" && <Badge variant="outline">Success</Badge>}
                  {submission.status === "failed" && <Badge variant="destructive">Failed</Badge>}
                  {submission.status === "timeout" && <Badge variant="secondary">Not included yet</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {submission.method} · gas limit {submission.gasLimit.toLocaleString()} · fee {fmtXrge(submission.fee)}
                    {submission.blockHeight != null && <> · block #{submission.blockHeight.toLocaleString()}</>}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Tx</span>
                  <Link to={`/tx/${submission.txId}`} className="text-xs font-mono text-primary hover:underline break-all">
                    {submission.txId}
                  </Link>
                  <CopyButton value={submission.txId} />
                </div>
                {submission.preview?.returnData !== undefined && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Preview result</p>
                    <code className="text-xs font-mono break-all">{fmtData(submission.preview.returnData)}</code>
                  </div>
                )}
                {submission.error && (
                  <div>
                    <p className="text-xs text-red-500 uppercase tracking-wider mb-1">Reverted in block</p>
                    <code className="text-xs font-mono text-red-400 break-all">{submission.error}</code>
                  </div>
                )}
                {submission.status === "timeout" && (
                  <p className="text-xs text-muted-foreground">No receipt within 90 s. Check the transaction page later.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Events */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Events
              <Badge variant="outline" className="font-normal text-[10px]">
                <Radio className={`w-3 h-3 mr-1 ${liveEvents ? "text-green-500" : "text-muted-foreground"}`} />
                {liveEvents ? "Live" : "Polling"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!eventsLoaded ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : events.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No events yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left py-2 px-2 font-medium">Topic</th>
                      <th className="text-left py-2 px-2 font-medium">Data</th>
                      <th className="text-left py-2 px-2 font-medium">Block</th>
                      <th className="text-left py-2 px-2 font-medium">Tx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {events.map((e, i) => (
                      <tr key={eventKey(e, i)} className="hover:bg-secondary/40 transition-colors">
                        <td className="py-2 px-2"><Badge variant="secondary" className="font-mono text-[10px]">{e.topic}</Badge></td>
                        <td className="py-2 px-2 font-mono text-xs break-all max-w-[24rem]">{e.data}</td>
                        <td className="py-2 px-2">
                          <Link to={`/block/${e.block_height}`} className="text-xs font-mono text-primary hover:underline">
                            #{e.block_height.toLocaleString()}
                          </Link>
                        </td>
                        <td className="py-2 px-2">
                          {e.tx_hash ? (
                            <Link to={`/tx/${e.tx_hash}`} className="text-xs font-mono text-primary hover:underline">
                              {e.tx_hash.slice(0, 10)}…
                            </Link>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default ContractDetail;
