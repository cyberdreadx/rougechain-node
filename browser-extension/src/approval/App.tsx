import { useState, useEffect } from "react";
import { Shield, Link2, FileSignature, Send, AlertTriangle } from "lucide-react";

/**
 * Approval popup — opened by the service worker when a dApp
 * requests connect / signTransaction / sendTransaction.
 *
 * URL params:
 *   id     — unique request ID stored in chrome.storage.session
 *   type   — "connect" | "sign" | "send"
 *   origin — requesting site origin
 */

interface PendingRequest {
    id: string;
    type: "connect" | "sign" | "send";
    origin: string;
    favicon?: string;
    payload?: Record<string, unknown>;
}

export default function ApprovalApp() {
    const [request, setRequest] = useState<PendingRequest | null>(null);
    const [closing, setClosing] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const id = params.get("id") || "";
        const type = (params.get("type") || "connect") as PendingRequest["type"];
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
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${request.type === "connect"
                        ? "bg-blue-500/10 text-blue-400"
                        : request.type === "sign"
                            ? "bg-amber-500/10 text-amber-400"
                            : "bg-red-500/10 text-red-400"
                        }`}>
                        {request.type === "connect" && <Link2 className="w-7 h-7" />}
                        {request.type === "sign" && <FileSignature className="w-7 h-7" />}
                        {request.type === "send" && <Send className="w-7 h-7" />}
                    </div>
                    <h2 className="text-lg font-semibold">
                        {request.type === "connect" && "Connection Request"}
                        {request.type === "sign" && "Signature Request"}
                        {request.type === "send" && "Transaction Request"}
                    </h2>
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

                {request.type === "sign" && (
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

                {request.type === "send" && (
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
                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 ${request.type === "send"
                        ? "bg-red-500 hover:bg-red-600"
                        : request.type === "sign"
                            ? "bg-amber-500 hover:bg-amber-600"
                            : "bg-blue-500 hover:bg-blue-600"
                        }`}
                >
                    {request.type === "connect" && "Connect"}
                    {request.type === "sign" && "Sign"}
                    {request.type === "send" && "Approve & Send"}
                </button>
            </div>
        </div>
    );
}
