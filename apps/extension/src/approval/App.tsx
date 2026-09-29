import { useState, useEffect, type ReactNode } from "react";
import { Shield, Link2, FileSignature, Send, AlertTriangle, Code2, Upload } from "lucide-react";
import type { ContractTxDetails } from "../lib/contract-tx";

/**
 * Approval popup — opened by the service worker when a dApp
 * requests connect / signTransaction / sendTransaction.
 *
 * URL params:
 *   id     — unique request ID stored in chrome.storage.session
 *   type   — "connect" | "sign" | "send"
 *   origin — requesting site origin
 */

type ApprovalType = "connect" | "sign" | "send" | "evm-connect" | "evm-personal-sign" | "evm-send";

interface PendingRequest {
    id: string;
    type: ApprovalType;
    origin: string;
    favicon?: string;
    payload?: Record<string, unknown>;
    details?: ContractTxDetails;
}

const isEvm = (t: ApprovalType) => t.startsWith("evm-");

function shortAddr(a: string): string {
    return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

function formatXrge(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
    return (
        <div className="flex justify-between gap-3 text-sm" title={title}>
            <span className="text-muted-foreground shrink-0">{label}</span>
            <span className="text-right min-w-0 break-all">{children}</span>
        </div>
    );
}

/** Contract call / deployment summary (details are derived by the service worker). */
function ContractTxView({ details, sending }: { details: ContractTxDetails; sending: boolean }) {
    if (details.kind === "contract_call") {
        return (
            <div className="space-y-3">
                <div className="flex items-center gap-2 text-amber-400 text-sm justify-center">
                    <Code2 className="w-4 h-4" />
                    <span>{sending ? "Call a smart contract" : "Sign a smart contract call"}</span>
                </div>
                {details.attach && (
                    <div className="rounded-xl border-2 border-amber-500/60 bg-amber-500/10 p-4 text-center space-y-1">
                        <p className="text-base font-bold text-amber-300 break-all">
                            Pays {details.attach.display} {details.attach.symbol} to the contract
                        </p>
                        <p className="text-xs text-amber-200/80">(only if the call succeeds)</p>
                        {details.attach.symbol !== "XRGE" && (
                            <p className="text-[10px] text-muted-foreground">Raw token units, as signed.</p>
                        )}
                    </div>
                )}
                <div className="rounded-xl border border-border bg-card/30 p-4 space-y-2.5">
                    <Row label="Contract" title={details.contractAddr}>
                        <span className="font-mono text-xs">{shortAddr(details.contractAddr)}</span>
                    </Row>
                    <Row label="Method"><span className="font-mono text-xs font-semibold">{details.method}</span></Row>
                    <Row label="Gas limit">
                        <span className="font-mono text-xs">{details.gasLimit.toLocaleString()}</span>
                        {details.gasLimitDefaulted && <span className="block text-[10px] text-amber-400">not set: node default</span>}
                    </Row>
                    <Row label="Max fee"><span className="font-semibold">{formatXrge(details.maxFeeXrge)} XRGE</span></Row>
                    {details.attach && (
                        <Row label="Payment">
                            <span className="font-semibold">{details.attach.display} {details.attach.symbol}</span>
                        </Row>
                    )}
                    {details.attach?.symbol === "XRGE" && (
                        <Row label="Max total cost">
                            <span className="font-semibold">{details.maxTotalXrge} XRGE</span>
                            <span className="block text-[10px] text-muted-foreground">gas fee + payment</span>
                        </Row>
                    )}
                </div>
                <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                        Arguments ({details.argsBytes.toLocaleString()} bytes)
                    </p>
                    <div className="rounded-xl border border-border bg-card/30 p-3 max-h-[160px] overflow-auto">
                        <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">{details.argsPretty}</pre>
                        {details.argsTruncated && (
                            <p className="mt-1 text-[10px] text-amber-400">Truncated for display. The full arguments are signed.</p>
                        )}
                    </div>
                </div>
                <p className="text-[11px] text-muted-foreground text-center">
                    The fee is gas limit × 0.000001 XRGE, charged up front. The contract sees this wallet as the caller.
                    {details.attach && " If the call fails, the payment stays with you but the fee is still charged."}
                </p>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-red-400 text-sm justify-center">
                <Upload className="w-4 h-4" />
                <span>{sending ? "Deploy a smart contract" : "Sign a smart contract deployment"}</span>
            </div>
            <div className="rounded-xl border border-border bg-card/30 p-4 space-y-2.5">
                <Row label="WASM size"><span className="font-mono text-xs">{details.wasmSize.toLocaleString()} bytes</span></Row>
                <Row label="Address" title={details.predictedAddress}>
                    <span className="font-mono text-xs">{details.predictedAddress}</span>
                </Row>
                <Row label="Code hash" title={details.codeHash}>
                    <span className="font-mono text-xs">{shortAddr(details.codeHash)}</span>
                </Row>
                <Row label="Fee"><span className="font-semibold">{formatXrge(details.feeXrge)} XRGE</span></Row>
            </div>
            <p className="text-[11px] text-muted-foreground text-center">
                The contract is installed at this address once the transaction is mined. You are its deployer.
            </p>
        </div>
    );
}

export default function ApprovalApp() {
    const [request, setRequest] = useState<PendingRequest | null>(null);
    const [closing, setClosing] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const id = params.get("id") || "";
        const type = (params.get("type") || "connect") as ApprovalType;
        const origin = params.get("origin") || "Unknown";
        const favicon = params.get("favicon") || "";

        // Load full request data from storage
        chrome.storage.session.get(`approval-${id}`, (data) => {
            const stored = data[`approval-${id}`];
            setRequest({
                id,
                type,
                origin,
                favicon,
                payload: stored?.payload,
                details: stored?.details,
            });
        });
    }, []);

    const respond = async (approved: boolean) => {
        if (!request || closing) return;
        setClosing(true);

        // Write response to session storage — service worker is listening
        await chrome.storage.session.set({
            [`approval-response-${request.id}`]: {
                approved,
                timestamp: Date.now(),
            },
        });

        // Small delay so the service worker picks it up before window closes
        setTimeout(() => window.close(), 150);
    };

    if (!request) {
        return (
            <div className="flex items-center justify-center h-screen bg-background">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    const domain = (() => {
        try { return new URL(request.origin).hostname; }
        catch { return request.origin; }
    })();

    const kind = request.type;
    const isConnect = kind === "connect" || kind === "evm-connect";
    const isSign = kind === "sign" || kind === "evm-personal-sign";
    const isSend = kind === "send" || kind === "evm-send";
    const evm = isEvm(kind);
    const p = request.payload || {};

    return (
        <div className="flex flex-col h-screen bg-background text-foreground">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-card/60">
                <div className="logo-ring w-7 h-7">
                    <img src="/xrge-logo.webp" alt="XRGE" />
                </div>
                <span className="text-sm font-bold text-gradient-quantum tracking-tight">RougeChain</span>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto px-5 py-5 space-y-5">
                {/* Icon + Type */}
                <div className="flex flex-col items-center text-center space-y-3">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${isConnect
                        ? "bg-blue-500/10 text-blue-400"
                        : isSign
                            ? "bg-amber-500/10 text-amber-400"
                            : "bg-red-500/10 text-red-400"
                        }`}>
                        {isConnect && <Link2 className="w-7 h-7" />}
                        {isSign && <FileSignature className="w-7 h-7" />}
                        {isSend && <Send className="w-7 h-7" />}
                    </div>
                    <h2 className="text-lg font-semibold">
                        {isConnect && "Connection Request"}
                        {isSign && (request.details ? "Contract Signature" : "Signature Request")}
                        {isSend && (request.details ? "Contract Transaction" : "Transaction Request")}
                    </h2>
                    {evm && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20">
                            {String(p.chain || "Base")} · EVM
                        </span>
                    )}
                </div>

                {/* Origin */}
                <div className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-4 py-3">
                    {request.favicon ? (
                        <img src={request.favicon} alt="" className="w-8 h-8 rounded-lg" />
                    ) : (
                        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                            {domain.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <div>
                        <p className="text-sm font-medium">{domain}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[240px]">{request.origin}</p>
                    </div>
                </div>

                {/* Type-specific content */}
                {request.type === "connect" && (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground text-center">
                            This site wants to connect to your RougeChain wallet.
                        </p>
                        <div className="rounded-xl border border-border bg-card/30 p-4 space-y-2">
                            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">This will allow the site to:</p>
                            <div className="flex items-center gap-2 text-sm">
                                <Shield className="w-4 h-4 text-green-400 shrink-0" />
                                <span>View your public key</span>
                            </div>
                            <div className="flex items-center gap-2 text-sm">
                                <Shield className="w-4 h-4 text-green-400 shrink-0" />
                                <span>Check your balance</span>
                            </div>
                        </div>
                    </div>
                )}

                {(request.type === "sign" || request.type === "send") && request.details && (
                    <ContractTxView details={request.details} sending={request.type === "send"} />
                )}

                {request.type === "sign" && !request.details && (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground text-center">
                            This site is requesting your signature on the following data:
                        </p>
                        <div className="rounded-xl border border-border bg-card/30 p-3 max-h-[180px] overflow-auto">
                            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                                {request.payload ? JSON.stringify(request.payload, null, 2) : "No data"}
                            </pre>
                        </div>
                    </div>
                )}

                {request.type === "send" && !request.details && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-amber-400 text-sm justify-center">
                            <AlertTriangle className="w-4 h-4" />
                            <span>This will submit a transaction to RougeChain</span>
                        </div>
                        {request.payload && (
                            <div className="rounded-xl border border-border bg-card/30 p-4 space-y-2.5">
                                {!!request.payload.to && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">To</span>
                                        <span className="font-mono text-xs truncate max-w-[180px]">{String(request.payload.to).slice(0, 20)}...</span>
                                    </div>
                                )}
                                {request.payload.amount !== undefined && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Amount</span>
                                        <span className="font-semibold">{String(request.payload.amount)} {String(request.payload.token || "XRGE")}</span>
                                    </div>
                                )}
                                {!!request.payload.type && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Type</span>
                                        <span className="capitalize">{String(request.payload.type)}</span>
                                    </div>
                                )}
                            </div>
                        )}
                        {request.payload && (
                            <details className="text-xs">
                                <summary className="text-muted-foreground cursor-pointer hover:text-foreground">View raw data</summary>
                                <pre className="mt-2 rounded-lg border border-border bg-card/30 p-2 font-mono text-muted-foreground whitespace-pre-wrap break-all max-h-[120px] overflow-auto">
                                    {JSON.stringify(request.payload, null, 2)}
                                </pre>
                            </details>
                        )}
                    </div>
                )}
                {/* EVM: connect */}
                {kind === "evm-connect" && (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground text-center">
                            This site wants to connect to your <span className="text-foreground font-medium">Base</span> account.
                        </p>
                        <div className="rounded-xl border border-border bg-card/30 p-4 space-y-1">
                            <p className="text-xs text-muted-foreground uppercase tracking-wider">Base address</p>
                            <p className="font-mono text-xs break-all">{String(p.address || "")}</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground text-center">
                            It will be able to request transactions and signatures, which you approve here each time.
                        </p>
                    </div>
                )}

                {/* EVM: personal_sign */}
                {kind === "evm-personal-sign" && (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground text-center">This site is requesting a signature from your Base account:</p>
                        <div className="rounded-xl border border-border bg-card/30 p-3 max-h-[180px] overflow-auto">
                            <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">{String(p.message ?? "")}</pre>
                        </div>
                        <p className="text-[11px] text-muted-foreground font-mono break-all">Signer: {String(p.address || "")}</p>
                    </div>
                )}

                {/* EVM: send transaction */}
                {kind === "evm-send" && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-red-400 text-sm justify-center">
                            <AlertTriangle className="w-4 h-4" />
                            <span>This submits a transaction on {String(p.chain || "Base")}</span>
                        </div>
                        <div className="rounded-xl border border-border bg-card/30 p-4 space-y-2.5">
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">To</span>
                                <span className="font-mono text-xs truncate max-w-[190px]">{String(p.to || "")}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Value</span>
                                <span className="font-semibold">{String(p.valueEth ?? "0")} ETH</span>
                            </div>
                            {!!p.hasData && (
                                <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Contract call</span>
                                    <span className="text-amber-400">Yes (has data)</span>
                                </div>
                            )}
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">From</span>
                                <span className="font-mono text-xs truncate max-w-[190px]">{String(p.address || "")}</span>
                            </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground text-center">Gas &amp; fees are filled automatically from the Base network.</p>
                    </div>
                )}
            </div>

            {/* Action Buttons */}
            <div className="px-5 py-4 border-t border-border bg-card/40 flex gap-3">
                <button
                    onClick={() => respond(false)}
                    disabled={closing}
                    className="flex-1 py-2.5 rounded-xl border border-border bg-card/60 text-sm font-medium text-muted-foreground hover:bg-card hover:text-foreground transition-all disabled:opacity-50"
                >
                    Deny
                </button>
                <button
                    onClick={() => respond(true)}
                    disabled={closing}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 ${isSend
                        ? "bg-red-500 hover:bg-red-600"
                        : isSign
                            ? "bg-amber-500 hover:bg-amber-600"
                            : "bg-blue-500 hover:bg-blue-600"
                        }`}
                >
                    {isConnect && "Connect"}
                    {isSign && "Sign"}
                    {isSend && "Approve & Send"}
                </button>
            </div>
        </div>
    );
}
