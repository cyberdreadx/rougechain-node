/**
 * Buy XRGE (apps/web /buy): the official Base contract, how to buy, and links to Aerodrome and the
 * bridge. apps/web also embeds an in-page Aerodrome swap (its components/buy/AerodromeSwap.tsx);
 * that EVM router code isn't in @rougechain/core yet, so site-next links out instead of copying it.
 */
import { Link } from "react-router-dom";
import { ArrowDownUp, ArrowUpRight, Coins, Info, ShieldCheck } from "lucide-react";
import { CopyText } from "../wallet/parts";
import { S } from "../swap/strings";
import "../swap/swap.css";

/** XRGE on Base mainnet (same constant as apps/web pages/Buy.tsx `XRGE_BASE`). */
export const XRGE_BASE = "0x147120faEC9277ec02d957584CFCD92B56A24317";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const AERODROME_URL = `https://aerodrome.finance/swap?from=${USDC_BASE}&to=${XRGE_BASE}&chain0=8453&chain1=8453`;
export const BASESCAN_URL = `https://basescan.org/token/${XRGE_BASE}`;

export default function Buy() {
  return (
    <main id="main" className="app-main dex-main">
      <div className="container">
        <div className="app-page-heading">
          <div className="heading-copy">
            <div className="eyebrow">{S.buy.eyebrow}</div>
            <h1>{S.buy.title}</h1>
            <p>{S.buy.intro}</p>
          </div>
        </div>
        <div className="dex-buy">
          <section className="surface dex-panel">
            <h2 className="dex-with-icon">
              <ShieldCheck size={18} aria-hidden="true" /> {S.buy.contractLabel}
            </h2>
            <CopyText value={XRGE_BASE} label="contract address" />
            <p className="form-hint">
              {S.buy.contractNote}{" "}
              <a className="text-link" href={BASESCAN_URL} target="_blank" rel="noopener noreferrer">
                Basescan <ArrowUpRight size={13} />
              </a>
            </p>
            <a className="button review-button dex-buy-cta" href={AERODROME_URL} target="_blank" rel="noopener noreferrer">
              <Coins size={16} aria-hidden="true" /> {S.buy.openAerodrome} <ArrowUpRight size={15} />
            </a>
          </section>
          <section className="surface dex-panel">
            <h2>{S.buy.howTitle}</h2>
            <ol className="dex-steps">
              {S.buy.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="dex-links">
              <Link className="text-link" to="/bridge">
                {S.buy.bridge} <ArrowUpRight size={14} />
              </Link>
              <Link className="text-link" to="/swap">
                <ArrowDownUp size={14} aria-hidden="true" /> {S.buy.swapOnChain}
              </Link>
            </div>
            <p className="form-hint dex-with-icon">
              <Info size={14} aria-hidden="true" /> {S.buy.disclaimer}
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
