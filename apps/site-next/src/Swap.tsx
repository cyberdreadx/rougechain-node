import { appById } from "./ecosystem/apps";
import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ShieldCheck,
  SlidersHorizontal,
  Info,
} from "lucide-react";
import { Button, Dialog, DemoBadge, Status } from "@rougechain/ui";
export const tokens = ["XRGE", "qETH", "qUSDC"] as const;
type Token = (typeof tokens)[number];
const demoPrices: Record<Token, number> = { XRGE: 0.096, qETH: 3000, qUSDC: 1 };
// POC ONLY: illustrative quote; no live pricing or transaction service.
export function quote(amount: string, pay: Token, receive: Token) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > 1e12 || pay === receive)
    return null;
  return (value * demoPrices[pay]) / demoPrices[receive];
}
const scenarios = [
  "Default",
  "Loading quote",
  "High price impact",
  "Insufficient balance",
  "Network unavailable",
] as const;
export default function Swap() {
  const [amount, setAmount] = useState("100"),
    [pay, setPay] = useState<Token>("XRGE"),
    [receive, setReceive] = useState<Token>("qETH"),
    [scenario, setScenario] = useState<(typeof scenarios)[number]>("Default"),
    [review, setReview] = useState(false),
    [slippage, setSlippage] = useState(".5"),
    [settings, setSettings] = useState(false);
  const output = quote(amount, pay, receive),
    valid = output !== null;
  const blocked =
    !valid ||
    ["Loading quote", "Insufficient balance", "Network unavailable"].includes(
      scenario,
    );
  const formatted =
    output === null
      ? "—"
      : output.toLocaleString("en-US", { maximumFractionDigits: 8 });
  function switchToken(side: "pay" | "receive", token: Token) {
    if (side === "pay") {
      if (token === receive) setReceive(pay);
      setPay(token);
    } else {
      if (token === pay) setPay(receive);
      setReceive(token);
    }
  }
  return (
    <main id="main" className="swap-main">
      <div className="container">
        <div className="swap-layout">
          <div className="swap-editorial">
            <div className="eyebrow">Exchange / Design concept</div>
            <h1>
              A clear path
              <br />
              between assets.
            </h1>
            <p>
              A focused exchange experience.
              <br />
              Every detail, before the decision.
            </p>
            <div className="swap-principles">
              <div>
                <ShieldCheck size={17} />
                <span>Review every detail</span>
              </div>
              <div>
                <SlidersHorizontal size={17} />
                <span>Understand your settings</span>
              </div>
              <div>
                <Info size={17} />
                <span>Clear feedback at every step</span>
              </div>
            </div>
            <div className="swap-safety">
              <DemoBadge />
              <p>
                This is an interactive design prototype.
                <br />
                Quotes, prices, balances, and fees are illustrative.
                <br />
                No real wallet is connected and no funds can move.
              </p>
            </div>
          </div>
          <div>
            <section className="swap-card" aria-labelledby="swap-heading">
              <div className="swap-card-heading">
                <h2 id="swap-heading">Swap</h2>
                <Button
                  variant="ghost icon"
                  aria-label="Quote settings"
                  aria-expanded={settings}
                  onClick={() => setSettings(!settings)}
                >
                  <SlidersHorizontal size={19} />
                </Button>
              </div>
              {settings && (
                <div className="quote-settings">
                  <label className="field">
                    Slippage tolerance · illustrative
                    <select
                      value={slippage}
                      onChange={(e) => setSlippage(e.target.value)}
                    >
                      <option value=".1">0.1%</option>
                      <option value=".5">0.5%</option>
                      <option value="1">1.0%</option>
                    </select>
                  </label>
                </div>
              )}
              <div className="token-input">
                <div className="token-label">
                  <label htmlFor="pay-amount">You pay</label>
                  <span>Demo balance: 1,250 {pay}</span>
                </div>
                <div className="amount-row">
                  <input
                    id="pay-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    aria-invalid={!valid}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-describedby="amount-feedback"
                  />
                  <label className="token-selector">
                    <TokenIcon token={pay} />
                    <span className="sr-only">Pay token</span>
                    <select
                      aria-label="Pay token"
                      value={pay}
                      onChange={(e) =>
                        switchToken("pay", e.target.value as Token)
                      }
                    >
                      {tokens.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="fiat-hint">
                  ≈ $
                  {valid
                    ? (Number(amount) * demoPrices[pay]).toFixed(2)
                    : "0.00"}{" "}
                  · illustrative
                </div>
              </div>
              <div className="switch-row">
                <Button
                  variant="secondary icon"
                  aria-label="Reverse token pair"
                  onClick={() => {
                    setPay(receive);
                    setReceive(pay);
                  }}
                >
                  <ArrowDown size={18} />
                </Button>
              </div>
              <div className="token-input">
                <div className="token-label">
                  <label htmlFor="receive-amount">You receive</label>
                  <span>Estimated · demo</span>
                </div>
                <div className="amount-row">
                  <output id="receive-amount" aria-live="polite">
                    {scenario === "Loading quote" ? "…" : formatted}
                  </output>
                  <label className="token-selector">
                    <TokenIcon token={receive} />
                    <span className="sr-only">Receive token</span>
                    <select
                      aria-label="Receive token"
                      value={receive}
                      onChange={(e) =>
                        switchToken("receive", e.target.value as Token)
                      }
                    >
                      {tokens.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="fiat-hint">
                  ≈ $
                  {valid
                    ? (Number(amount) * demoPrices[pay]).toFixed(2)
                    : "0.00"}{" "}
                  · illustrative
                </div>
              </div>
              <div id="amount-feedback" role="status">
                {!valid && (
                  <p className="quote-alert">
                    Enter a positive amount up to 1 trillion.
                  </p>
                )}
                {scenario === "Loading quote" && (
                  <p className="quote-alert neutral">
                    Loading quote… (design state)
                  </p>
                )}
                {scenario === "High price impact" && (
                  <p className="quote-alert">
                    High price impact: 8.2%. This demo shows how a warning would
                    appear.
                  </p>
                )}
                {scenario === "Insufficient balance" && (
                  <p className="quote-alert">
                    Insufficient balance. Illustrative account state.
                  </p>
                )}
                {scenario === "Network unavailable" && (
                  <p className="quote-alert">
                    Network data unavailable. Try again later.
                  </p>
                )}
              </div>
              <dl className="quote-details">
                <div>
                  <dt>Rate</dt>
                  <dd>
                    1 {pay} ≈{" "}
                    {(demoPrices[pay] / demoPrices[receive]).toLocaleString(
                      "en-US",
                      { maximumFractionDigits: 8 },
                    )}{" "}
                    {receive}
                  </dd>
                </div>
                <div>
                  <dt>Price impact</dt>
                  <dd>
                    {scenario === "High price impact" ? "8.2%" : "0.04%"}{" "}
                    <span className="muted">(demo)</span>
                  </dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd>
                    0.001 XRGE <span className="muted">(demo)</span>
                  </dd>
                </div>
                <div>
                  <dt>Minimum received</dt>
                  <dd>
                    {output === null
                      ? "—"
                      : (output * (1 - Number(slippage) / 100)).toLocaleString(
                          "en-US",
                          { maximumFractionDigits: 8 },
                        )}{" "}
                    {receive}
                  </dd>
                </div>
                <div>
                  <dt>Slippage tolerance</dt>
                  <dd>{Number(slippage)}%</dd>
                </div>
              </dl>
              <Button
                className="review-button"
                disabled={blocked}
                onClick={() => setReview(true)}
              >
                Review swap <ArrowRight size={16} />
              </Button>
              <p className="swap-card-note">
                Design preview only. No execution is possible.
              </p>
            </section>
            <div className="scenario-control">
              <label className="field">
                Preview an interface state
                <select
                  value={scenario}
                  onChange={(e) =>
                    setScenario(e.target.value as typeof scenario)
                  }
                >
                  {scenarios.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
        <div className="architecture-note">
          <span className="mono">PROPOSED FUTURE HOME</span>
          <span>{appById("swap")!.proposedHost}</span>
          <p>
            Architecture proposal only. Wallet connection, routing, liquidity,
            approvals, and execution are outside this POC.
          </p>
        </div>
      </div>
      <Dialog
        open={review}
        onClose={() => setReview(false)}
        title="Review swap"
      >
        <Status state="demo">Illustrative quote</Status>
        <div className="review-amounts">
          <div>
            <span>You pay</span>
            <strong>
              {amount} {pay}
            </strong>
          </div>
          <ArrowDown size={20} />
          <div>
            <span>You receive · estimated</span>
            <strong>
              {formatted} {receive}
            </strong>
          </div>
        </div>
        {scenario === "High price impact" && (
          <p className="quote-alert">
            High price impact: 8.2% (design example).
          </p>
        )}
        <p>
          All values are synthetic. This preview cannot connect a wallet,
          request an approval, sign, or submit a transaction.
        </p>
        <Button className="review-button" onClick={() => setReview(false)}>
          Demo only — close preview
        </Button>
      </Dialog>
    </main>
  );
}
function TokenIcon({ token }: { token: Token }) {
  return token === "XRGE" ? (
    <img className="token-icon" src="/xrge-logo.webp" alt="" />
  ) : (
    <span className="token-icon token-symbol" aria-hidden="true">
      {token === "qETH" ? "Ξ" : "$"}
    </span>
  );
}
