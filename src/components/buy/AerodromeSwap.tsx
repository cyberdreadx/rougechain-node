import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPublicClient, custom, http, parseAbi, parseEther, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { Loader2, Wallet, ArrowDown, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

// Aerodrome (Base mainnet) — verified on chain 2026-09-24: router.defaultFactory() and router.weth() return these,
// the XRGE/USDC volatile pool exists at 0x059e10d2…, there is no XRGE/WETH pool, so ETH routes WETH→USDC→XRGE.
export const AERODROME_ROUTER: Address = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
export const AERODROME_FACTORY: Address = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const USDC: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const XRGE: Address = "0x147120faEC9277ec02d957584CFCD92B56A24317";
export const XRGE_USDC_POOL: Address = "0x059e10d26c64a63d04e1814f46305210eddc447d";

const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, (address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const poolAbi = parseAbi(["function getReserves() view returns (uint256,uint256,uint256)"]);

const ROUTE_ETH = [{ from: WETH, to: USDC, stable: false, factory: AERODROME_FACTORY }, { from: USDC, to: XRGE, stable: false, factory: AERODROME_FACTORY }];
const ROUTE_USDC = [{ from: USDC, to: XRGE, stable: false, factory: AERODROME_FACTORY }];
const BASE_HEX = "0x2105";

interface EIP1193Provider { request(args: { method: string; params?: unknown[] | object }): Promise<unknown>; on?(event: string, cb: (...args: unknown[]) => void): void }
interface EIP6963Detail { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org", { retryCount: 3, retryDelay: 1200 }) });
// viem's contract-call generics require `strict: true`; this project compiles non-strict, so route calls through untyped shims.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = <T,>(params: any): Promise<T> => (publicClient as any).readContract(params);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const write = (client: any, params: any): Promise<Hex> => client.writeContract(params);
const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });

export default function AerodromeSwap() {
  const { t } = useTranslation();
  const [payWith, setPayWith] = useState<"ETH" | "USDC">("ETH");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [quote, setQuote] = useState<{ out: bigint; mid: bigint; impact: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [wallets, setWallets] = useState<EIP6963Detail[]>([]);
  const [rdns, setRdns] = useState<string | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [balances, setBalances] = useState<{ eth: bigint; usdc: bigint; xrge: bigint } | null>(null);
  const [busy, setBusy] = useState<"" | "approve" | "swap">("");
  const [txHash, setTxHash] = useState<Hex | null>(null);

  useEffect(() => {
    const onAnnounce = (e: Event) => { const d = (e as CustomEvent<EIP6963Detail>).detail; if (!d?.info?.rdns) return; setWallets((p) => (p.some((x) => x.info.rdns === d.info.rdns) ? p : [...p, d])); };
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener); window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  }, []);
  const legacy = (typeof window !== "undefined" ? (window as unknown as { ethereum?: EIP1193Provider }).ethereum : undefined);
  const provider: EIP1193Provider | undefined = (wallets.find((w) => w.info.rdns === rdns) ?? wallets[0])?.provider ?? legacy;

  // quote: router.getAmountsOut for the typed amount; price impact vs the pool's mid price (XRGE/USDC reserves)
  useEffect(() => {
    let alive = true; const v = Number(amount);
    if (!amount || !(v > 0)) { setQuote(null); return; }
    const id = setTimeout(async () => {
      setQuoting(true);
      try {
        const amountIn = payWith === "ETH" ? parseEther(amount) : parseUnits(amount, 6);
        const [amounts, reserves] = await Promise.all([
          read<readonly bigint[]>({ address: AERODROME_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, payWith === "ETH" ? ROUTE_ETH : ROUTE_USDC] }),
          read<readonly [bigint, bigint, bigint]>({ address: XRGE_USDC_POOL, abi: poolAbi, functionName: "getReserves" }),
        ]);
        const out = amounts[amounts.length - 1]; const usdcIn = payWith === "ETH" ? amounts[1] : amountIn; // token0 = XRGE, token1 = USDC
        const mid = (usdcIn * reserves[0]) / reserves[1]; const impact = mid > 0n ? 1 - Number(out) / Number(mid) : 0;
        if (alive) setQuote({ out, mid, impact });
      } catch (e) { if (alive) { setQuote(null); toast.error(t("buy.swap.quoteFailed")); } }
      finally { if (alive) setQuoting(false); }
    }, 350);
    return () => { alive = false; clearTimeout(id); };
  }, [amount, payWith, t]);

  const refreshBalances = async (addr: Address) => {
    const [eth, usdc, xrge] = await Promise.all([publicClient.getBalance({ address: addr }), read<bigint>({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] }), read<bigint>({ address: XRGE, abi: erc20Abi, functionName: "balanceOf", args: [addr] })]);
    setBalances({ eth, usdc, xrge });
  };
  const connect = async () => {
    if (!provider) { toast.error(t("buy.swap.noWallet")); return; }
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_HEX }] }).catch(async () => {
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: BASE_HEX, chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }] });
      });
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
      setAccount(accounts[0]); await refreshBalances(accounts[0]);
    } catch (e) { toast.error(e instanceof Error ? e.message : t("buy.swap.connectFailed")); }
  };

  const minOut = useMemo(() => { if (!quote) return 0n; const bps = BigInt(Math.round(Math.max(0.05, Math.min(50, Number(slippage) || 1)) * 100)); return (quote.out * (10000n - bps)) / 10000n; }, [quote, slippage]);
  const amountIn = useMemo(() => { try { return payWith === "ETH" ? parseEther(amount || "0") : parseUnits(amount || "0", 6); } catch { return 0n; } }, [amount, payWith]);
  const insufficient = balances ? (payWith === "ETH" ? amountIn > balances.eth : amountIn > balances.usdc) : false;

  const swap = async () => {
    if (!provider || !account || !quote || amountIn === 0n) return;
    const wallet = (await import("viem")).createWalletClient({ chain: base, transport: custom(provider), account });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    try {
      const chainId = (await provider.request({ method: "eth_chainId" })) as string; if (chainId.toLowerCase() !== BASE_HEX) { toast.error(t("buy.swap.wrongChain")); return; }
      if (payWith === "USDC") {
        const allowance = await read<bigint>({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account, AERODROME_ROUTER] });
        if (allowance < amountIn) { setBusy("approve"); const h = await write(wallet, { address: USDC, abi: erc20Abi, functionName: "approve", args: [AERODROME_ROUTER, amountIn] }); await publicClient.waitForTransactionReceipt({ hash: h }); }
      }
      setBusy("swap");
      const hash = payWith === "ETH"
        ? await write(wallet, { address: AERODROME_ROUTER, abi: routerAbi, functionName: "swapExactETHForTokens", args: [minOut, ROUTE_ETH, account, deadline], value: amountIn })
        : await write(wallet, { address: AERODROME_ROUTER, abi: routerAbi, functionName: "swapExactTokensForTokens", args: [amountIn, minOut, ROUTE_USDC, account, deadline] });
      setTxHash(hash); const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status === "success") { toast.success(t("buy.swap.done")); setAmount(""); setQuote(null); await refreshBalances(account); } else toast.error(t("buy.swap.reverted"));
    } catch (e) { toast.error(e instanceof Error ? (e.message.split("\n")[0].slice(0, 140)) : t("buy.swap.failed")); }
    finally { setBusy(""); }
  };

  const outXrge = quote ? Number(formatUnits(quote.out, 18)) : 0;
  return (
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{t("buy.swap.title")}</span><span>Aerodrome · Base</span></div>
      <div className="rounded-xl bg-background/60 border border-border p-3 space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{t("buy.swap.youPay")}</span>{balances && <span>{payWith === "ETH" ? `${Number(formatUnits(balances.eth, 18)).toFixed(5)} ETH` : `${fmt(Number(formatUnits(balances.usdc, 6)), 2)} USDC`}</span>}</div>
        <div className="flex items-center gap-2">
          <Input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} className="text-lg font-mono border-0 bg-transparent px-0 focus-visible:ring-0" />
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {(["ETH", "USDC"] as const).map((k) => <button key={k} onClick={() => { setPayWith(k); setQuote(null); }} className={`px-3 py-1.5 ${payWith === k ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{k}</button>)}
          </div>
        </div>
      </div>
      <div className="flex justify-center -my-1"><ArrowDown className="w-4 h-4 text-muted-foreground" /></div>
      <div className="rounded-xl bg-background/60 border border-border p-3 space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{t("buy.swap.youReceive")}</span>{balances && <span>{fmt(Number(formatUnits(balances.xrge, 18)))} XRGE</span>}</div>
        <div className="text-lg font-mono flex items-center gap-2">{quoting ? <Loader2 className="w-4 h-4 animate-spin" /> : quote ? fmt(outXrge) : "0"} <span className="text-sm text-muted-foreground">XRGE</span></div>
        {quote && (
          <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3">
            <span>{t("buy.swap.minReceived")}: {fmt(Number(formatUnits(minOut, 18)))}</span>
            <span className={quote.impact > 0.05 ? "text-amber-400" : ""}>{t("buy.swap.priceImpact")}: {(quote.impact * 100).toFixed(2)}%</span>
            <span>{t("buy.swap.route")}: {payWith === "ETH" ? "ETH → USDC → XRGE" : "USDC → XRGE"}</span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("buy.swap.slippage")}</span>
        <div className="flex items-center gap-1">{["0.5", "1", "3"].map((s) => <button key={s} onClick={() => setSlippage(s)} className={`px-2 py-0.5 rounded border ${slippage === s ? "border-primary text-primary" : "border-border"}`}>{s}%</button>)}<Input value={slippage} onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))} className="h-6 w-14 text-xs px-2" /></div>
      </div>
      {wallets.length > 1 && !account && (
        <div className="flex flex-wrap gap-1 text-xs">{wallets.map((w) => <button key={w.info.rdns} onClick={() => setRdns(w.info.rdns)} className={`flex items-center gap-1 px-2 py-1 rounded border ${(rdns ?? wallets[0].info.rdns) === w.info.rdns ? "border-primary" : "border-border"}`}><img src={w.info.icon} alt="" className="w-4 h-4 rounded" />{w.info.name}</button>)}</div>
      )}
      {!account ? (
        <Button className="w-full gap-2" onClick={connect}><Wallet className="w-4 h-4" /> {t("buy.swap.connect")}</Button>
      ) : (
        <Button className="w-full gap-2" disabled={!quote || busy !== "" || insufficient || (quote?.impact ?? 0) > 0.5} onClick={swap}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {busy === "approve" ? t("buy.swap.approving") : busy === "swap" ? t("buy.swap.swapping") : insufficient ? t("buy.swap.insufficient") : (quote?.impact ?? 0) > 0.5 ? t("buy.swap.impactTooHigh") : t("buy.swap.swap")}
        </Button>
      )}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-mono">{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : ""}</span>
        {account && <button onClick={() => refreshBalances(account)} className="flex items-center gap-1 hover:text-foreground"><RefreshCw className="w-3 h-3" /> {t("buy.swap.refresh")}</button>}
      </div>
      {txHash && <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">{t("buy.swap.viewTx")} <ExternalLink className="w-3 h-3" /></a>}
    </div>
  );
}
