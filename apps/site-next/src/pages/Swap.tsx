/**
 * Swap — Anders' exchange design, wired to the node: quotes from POST /swap/quote (multi-hop
 * routing and price impact by the daemon, as apps/web), review, then sign + submit through core's
 * `secureSwap` (POST /v2/swap/execute), locally or via the extension.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowRight, Info, ShieldCheck, SlidersHorizontal, Route as RouteIcon } from "lucide-react";
import { Button, Dialog } from "@rougechain/ui";
import { formatUsd } from "@rougechain/core/price-service";
import { NetworkBadge } from "../explorer/ui";
import { useWallet } from "../wallet/WalletProvider";
import { toast } from "../wallet/toast";
import { submitSwap, type SwapQuote } from "../swap/api";
import { DEFAULT_SLIPPAGE, PRICE_IMPACT_WARN, executionRate, fmtPrice, minReceived, sortPools } from "../swap/amm";
import { fmtAmount, parseTokenAmount, rawToInput } from "../swap/amounts";
import { balanceOf, useDexBalances, usePools, useRefreshAfterWrite, useSignState, useSwapQuote, useTokenImages, useUsdPrices } from "../swap/hooks";
import { DetailRows, ErrorLine, SignGate, SignNote, SlippageControl, TokenPicker } from "../swap/parts";
import { S } from "../swap/strings";
import "../swap/swap.css";

interface Review {
  tokenIn: string;
  tokenOut: string;
  rawIn: number;
  quote: SwapQuote;
  slippage: number;
}

const upper = (s: string | null) => (s ? s.trim() : "");

export default function Swap() {
  const [params] = useSearchParams();
  const { network } = useWallet();
  const pools = usePools();
  const balances = useDexBalances();
  const image = useTokenImages();
  const usd = useUsdPrices(pools.data);
  const sign = useSignState();
  const refresh = useRefreshAfterWrite();

  const networkLabel = network === "testnet" ? "Testnet" : "Mainnet";
  const [tokenIn, setTokenIn] = useState(() => upper(params.get("tokenIn")) || "XRGE");
  const [tokenOut, setTokenOut] = useState(() => {
    const out = upper(params.get("tokenOut"));
    if (out) return out;
    const t = upper(params.get("token"));
    return t && t.toUpperCase() !== "XRGE" ? t : "";
  });
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE);
  const [settings, setSettings] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");

  // ?pool=ID picks that pool's pair; otherwise default the receive side to the deepest XRGE pair.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !pools.data) return;
    applied.current = true;
    // URL symbols are matched case-insensitively (apps/web links use ?token=QETH style too).
    const known = [...new Set(pools.data.flatMap((p) => [p.token_a, p.token_b]))];
    const norm = (s: string) => known.find((k) => k.toUpperCase() === s.toUpperCase()) ?? s;
    if (tokenIn) setTokenIn(norm(tokenIn));
    if (tokenOut) setTokenOut(norm(tokenOut));
    const poolId = params.get("pool");
    const match = poolId ? pools.data.find((p) => p.pool_id === poolId) : undefined;
    if (match) {
      setTokenIn(match.token_a);
      setTokenOut(match.token_b);
      return;
    }
    if (!tokenOut) {
      const tin = norm(tokenIn);
      const deepest = sortPools(pools.data).find((p) => p.token_a === tin || p.token_b === tin);
      if (deepest) setTokenOut(deepest.token_a === tin ? deepest.token_b : deepest.token_a);
    }
  }, [pools.data, params, tokenIn, tokenOut]);

  const heldMap = useMemo(() => {
    const b = balances.data;
    return b ? { XRGE: b.xrge, ...b.tokens } : {};
  }, [balances.data]);
  const poolTokens = useMemo(() => [...new Set((pools.data ?? []).flatMap((p) => [p.token_a, p.token_b]))], [pools.data]);

  const parsed = amount.trim() ? parseTokenAmount(amount, tokenIn) : null;
  const rawIn = parsed?.ok ? parsed.raw : null;
  const balIn = balanceOf(balances.data, tokenIn);
  const balOut = balanceOf(balances.data, tokenOut);
  const insufficient = rawIn !== null && !!balances.data && rawIn > balIn;
  const quote = useSwapQuote(tokenIn, tokenOut, rawIn);
  const q = quote.result?.ok ? quote.result.quote : null;
  const noRoute = quote.result && !quote.result.ok ? quote.result.error : null;
  const impactHigh = !!q && q.price_impact > PRICE_IMPACT_WARN;

  const pick = (side: "in" | "out", s: string) => {
    if (side === "in") {
      if (s === tokenOut) setTokenOut(tokenIn);
      setTokenIn(s);
    } else {
      if (s === tokenIn) setTokenIn(tokenOut);
      setTokenOut(s);
    }
  };
  const flip = () => {
    setTokenIn(tokenOut || tokenIn);
    setTokenOut(tokenIn);
    setAmount("");
  };

  const usdOf = (raw: number | null, symbol: string) => {
    const p = usd[symbol];
    return raw && p ? S.swap.usd(formatUsd(raw * p)) : "";
  };

  let action: string;
  if (!tokenOut) action = S.swap.button.selectToken;
  else if (!amount.trim()) action = S.swap.button.enterAmount;
  else if (parsed && !parsed.ok) action = parsed.error;
  else if (insufficient) action = S.swap.button.insufficient(tokenIn);
  else if (quote.loading) action = S.swap.button.quoting;
  else if (!q) action = S.swap.button.noRoute;
  else action = S.swap.button.review;
  const canReview = action === S.swap.button.review && sign.state === "ready";

  const openReview = () => {
    if (!q || rawIn === null) return;
    setSignError("");
    setReview({ tokenIn, tokenOut, rawIn, quote: q, slippage });
  };

  const confirm = async () => {
    if (!review || sign.state !== "ready") return;
    setSigning(true);
    setSignError("");
    try {
      await submitSwap(sign.wallet, review.tokenIn, review.tokenOut, review.rawIn, minReceived(review.quote.amount_out, review.slippage));
      toast.success(
        S.toasts.swapped(fmtAmount(review.rawIn, review.tokenIn), review.tokenIn, fmtAmount(review.quote.amount_out, review.tokenOut), review.tokenOut),
        { description: S.common.submittedNextBlock },
      );
      setReview(null);
      setAmount("");
      refresh();
    } catch (e) {
      setSignError(e instanceof Error ? e.message : S.toasts.swapFailed);
    } finally {
      setSigning(false);
    }
  };

  const rateText = (r: { rawIn: number; tokenIn: string; amountOut: number; tokenOut: string }) =>
    `1 ${r.tokenIn} ≈ ${fmtPrice(executionRate(r.rawIn, r.tokenIn, r.amountOut, r.tokenOut))} ${r.tokenOut}`;

  return (
    <main id="main" className="swap-main">
      <div className="container">
        <div className="swap-layout">
          <div className="swap-editorial">
            <div className="eyebrow">{S.swap.eyebrow}</div>
            <h1>
              {S.swap.heading[0]}
              <br />
              {S.swap.heading[1]}
            </h1>
            <p>{S.swap.intro}</p>
            <div className="swap-principles">
              {[ShieldCheck, SlidersHorizontal, Info].map((Icon, i) => (
                <div key={S.swap.principles[i]}>
                  <Icon size={17} />
                  <span>{S.swap.principles[i]}</span>
                </div>
              ))}
            </div>
            <div className="swap-safety dex-safety">
              <NetworkBadge />
              <p>
                {S.swap.ammInfo}
                <br />
                {S.swap.multiHop}
              </p>
              <div className="dex-links">
                <Link className="text-link" to="/pools">
                  {S.swap.poolsLink} <ArrowRight size={14} />
                </Link>
                <Link className="text-link" to="/buy">
                  {S.swap.buyLink} <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </div>
          <div>
            <section className="swap-card" aria-labelledby="swap-heading">
              <div className="swap-card-heading">
                <h2 id="swap-heading">{S.swap.title}</h2>
                <Button variant="ghost icon" aria-label={S.swap.settings} aria-expanded={settings} onClick={() => setSettings(!settings)}>
                  <SlidersHorizontal size={19} />
                </Button>
              </div>
              {settings && <SlippageControl value={slippage} onChange={setSlippage} />}
              <div className="token-input">
                <div className="token-label">
                  <label htmlFor="pay-amount">{S.swap.youPay}</label>
                  {balances.data && (
                    <button type="button" className="inline-link" onClick={() => setAmount(rawToInput(balIn, tokenIn))}>
                      {S.swap.balance(fmtAmount(balIn, tokenIn))} · {S.swap.max}
                    </button>
                  )}
                </div>
                <div className="amount-row">
                  <input
                    id="pay-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={amount}
                    aria-invalid={!!parsed && !parsed.ok}
                    aria-describedby="amount-feedback"
                    onChange={(e) => setAmount(e.target.value.replace(",", "."))}
                  />
                  <TokenPicker label={S.swap.payToken} selected={tokenIn} balances={heldMap} poolTokens={poolTokens} image={image} onSelect={(s) => pick("in", s)} />
                </div>
                <div className="fiat-hint">{usdOf(rawIn, tokenIn) || " "}</div>
              </div>
              <div className="switch-row">
                <Button variant="secondary icon" aria-label={S.swap.reverse} onClick={flip}>
                  <ArrowDown size={18} />
                </Button>
              </div>
              <div className="token-input">
                <div className="token-label">
                  <label htmlFor="receive-amount">{S.swap.youReceive}</label>
                  <span>
                    {balances.data && tokenOut ? `${S.swap.balance(fmtAmount(balOut, tokenOut))} · ` : ""}
                    {S.swap.estimated}
                  </span>
                </div>
                <div className="amount-row">
                  <output id="receive-amount" aria-live="polite">
                    {quote.loading ? "…" : q ? fmtAmount(q.amount_out, tokenOut) : "—"}
                  </output>
                  <TokenPicker label={S.swap.receiveToken} selected={tokenOut} balances={heldMap} poolTokens={poolTokens} image={image} onSelect={(s) => pick("out", s)} />
                </div>
                <div className="fiat-hint">{(q && usdOf(q.amount_out, tokenOut)) || " "}</div>
              </div>
              <div id="amount-feedback" role="status">
                {parsed && !parsed.ok && <p className="quote-alert">{parsed.error}</p>}
                {insufficient && <p className="quote-alert">{S.swap.button.insufficient(tokenIn)}</p>}
                {quote.loading && <p className="quote-alert neutral">{S.swap.gettingQuote}</p>}
                {!quote.loading && noRoute && <p className="quote-alert">{noRoute}</p>}
                {!quote.loading && quote.error && (
                  <p className="quote-alert">
                    {S.swap.quoteUnavailable}{" "}
                    <button type="button" className="inline-link" onClick={quote.refetch}>
                      {S.common.retry}
                    </button>
                  </p>
                )}
                {impactHigh && q && <p className="quote-alert">{S.swap.highImpact(`${q.price_impact.toFixed(2)}%`)}</p>}
              </div>
              {q && rawIn !== null && (
                <DetailRows
                  rows={[
                    [S.swap.rate, rateText({ rawIn, tokenIn, amountOut: q.amount_out, tokenOut })],
                    [S.swap.priceImpact, <span className={impactHigh ? "dex-bad" : undefined}>{q.price_impact.toFixed(2)}%</span>],
                    [S.swap.minReceived, `${fmtAmount(minReceived(q.amount_out, slippage), tokenOut)} ${tokenOut}`],
                    [S.swap.slippage, `${slippage}%`],
                    [S.swap.route, <span className="dex-route"><RouteIcon size={12} aria-hidden="true" /> {q.path.join(" → ")}</span>],
                  ]}
                />
              )}
              {sign.state === "ready" ? (
                <Button className="review-button" disabled={!canReview} onClick={openReview}>
                  {action} {canReview && <ArrowRight size={16} />}
                </Button>
              ) : (
                <SignGate sign={sign} compact />
              )}
              <p className="swap-card-note">{networkLabel} · {S.swap.ammInfo}</p>
            </section>
          </div>
        </div>
      </div>
      <Dialog open={!!review} onClose={() => !signing && setReview(null)} title={S.swap.review}>
        {review && (
          <>
            <div className="review-amounts">
              <div>
                <span>{S.swap.youPay}</span>
                <strong>
                  {fmtAmount(review.rawIn, review.tokenIn)} {review.tokenIn}
                </strong>
              </div>
              <ArrowDown size={20} />
              <div>
                <span>
                  {S.swap.youReceive} · {S.swap.estimated.toLowerCase()}
                </span>
                <strong>
                  {fmtAmount(review.quote.amount_out, review.tokenOut)} {review.tokenOut}
                </strong>
              </div>
            </div>
            {review.quote.price_impact > PRICE_IMPACT_WARN && (
              <p className="quote-alert">{S.swap.highImpact(`${review.quote.price_impact.toFixed(2)}%`)}</p>
            )}
            <DetailRows
              rows={[
                [S.swap.rate, rateText({ rawIn: review.rawIn, tokenIn: review.tokenIn, amountOut: review.quote.amount_out, tokenOut: review.tokenOut })],
                [S.swap.priceImpact, `${review.quote.price_impact.toFixed(2)}%`],
                [S.swap.minReceived, `${fmtAmount(minReceived(review.quote.amount_out, review.slippage), review.tokenOut)} ${review.tokenOut}`],
                [S.swap.slippage, `${review.slippage}%`],
                [S.swap.route, review.quote.path.join(" → ")],
                [S.swap.networkLabel, networkLabel],
              ]}
            />
            <p className="form-hint">{S.swap.reviewNote}</p>
            {sign.state === "ready" && <SignNote kind={sign.kind} />}
            <ErrorLine>{signError}</ErrorLine>
            <div className="actions dex-actions">
              <Button variant="outline" disabled={signing} onClick={() => setReview(null)}>
                {S.common.back}
              </Button>
              <Button disabled={signing || sign.state !== "ready"} onClick={confirm}>
                {signing ? S.swap.button.signing : S.swap.button.sign}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </main>
  );
}
