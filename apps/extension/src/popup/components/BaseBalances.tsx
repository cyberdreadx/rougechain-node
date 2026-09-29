import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { deriveEvmAccount } from "../../lib/evm-wallet";
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, getBalance, getChain, rpc } from "../../lib/evm-rpc";
import { getActiveNetwork } from "../../lib/network";

/** ERC-20s shown on Base mainnet: the official XRGE contract and Circle's USDC. */
const BASE_TOKENS: { symbol: string; address: string }[] = [
    { symbol: "XRGE", address: "0x147120faEC9277ec02d957584CFCD92B56A24317" },
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
];

type Row = { symbol: string; amount: string | null };

function formatUnits(value: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const frac = (value % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
    return `${whole.toLocaleString()}${frac ? `.${frac}` : ""}`;
}

async function erc20(chainId: number, token: string, owner: string): Promise<string> {
    const pad = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const [raw, dec] = await Promise.all([
        rpc<string>(chainId, "eth_call", [{ to: token, data: `0x70a08231${pad}` }, "latest"]),
        rpc<string>(chainId, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]),
    ]);
    return formatUnits(BigInt(raw || "0x0"), Number(BigInt(dec || "0x12")));
}

/**
 * Balances of this wallet's Base (Ethereum L2) account — the same recovery phrase, standard
 * Ethereum derivation. Where XRGE lands when bridged out of RougeChain.
 */
export default function BaseBalances({ mnemonic }: { mnemonic?: string }) {
    const account = useMemo(() => deriveEvmAccount(mnemonic), [mnemonic]);
    const chainId = getActiveNetwork() === "testnet" ? BASE_SEPOLIA_CHAIN_ID : BASE_MAINNET_CHAIN_ID;
    const chain = getChain(chainId);
    const [rows, setRows] = useState<Row[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        if (!account) return;
        setLoading(true);
        setError("");
        try {
            const eth = formatUnits(BigInt(await getBalance(chainId, account.address)), 18);
            const tokens = chainId === BASE_MAINNET_CHAIN_ID
                ? await Promise.all(BASE_TOKENS.map(async (t) => ({ symbol: t.symbol, amount: await erc20(chainId, t.address, account.address).catch(() => null) })))
                : [];
            setRows([{ symbol: "ETH", amount: eth }, ...tokens]);
        } catch {
            setError("Couldn't reach Base right now.");
        } finally {
            setLoading(false);
        }
    }, [account, chainId]);

    useEffect(() => { load(); }, [load]);

    if (!account) return null; // wallets without a recovery phrase have no Base account

    return (
        <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {chainId === BASE_MAINNET_CHAIN_ID ? "Base" : "Base Sepolia"} · {account.address.slice(0, 6)}…{account.address.slice(-4)}
                </p>
                <div className="flex items-center gap-2">
                    <button onClick={load} disabled={loading} title="Refresh" className="text-muted-foreground hover:text-foreground">
                        <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                    </button>
                    <a href={`${chain.explorer}/address/${account.address}`} target="_blank" rel="noreferrer" title="View on explorer" className="text-muted-foreground hover:text-foreground">
                        <ExternalLink className="w-3 h-3" />
                    </a>
                </div>
            </div>
            {error && <p className="text-[10px] text-destructive">{error}</p>}
            {rows.map((r) => (
                <div key={r.symbol} className="flex items-center justify-between py-1">
                    <span className="text-xs text-foreground">{r.symbol}</span>
                    <span className="text-xs text-foreground font-mono">{r.amount ?? "—"}</span>
                </div>
            ))}
        </div>
    );
}
