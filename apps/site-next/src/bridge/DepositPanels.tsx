/** Deposits into RougeChain: Base (ETH / USDC / XRGE), Bitcoin (per-user address + OP_RETURN fallback), and claims. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import { Button } from "@rougechain/ui";
import { getBtcDepositAddress, type BridgeConfig } from "@rougechain/core/bridge";
import { formatBaseUnits } from "@rougechain/core/base-wallet";
import { CopyText } from "../wallet/parts";
import { useQr } from "../wallet/ReceiveDialog";
import { toast } from "../wallet/toast";
import i18n from "../i18n";
import { BaseConnect, shortAddr } from "./BaseConnect";
import { claimBtcDeposit, claimExistingDeposit, depositFromBase, errorMessage, evmDepositsEnabled, L1_SYMBOL, type FlowCtx, type FlowOutcome } from "./flows";
import { WrongChainError } from "./evm";
import type { BaseConnection, EvmBalances } from "./useBaseConnection";
import { assetDef, formatUnits, isBaseTxHash, normalizeBtcTxid, parseDepositAmount, type DepositAmount } from "./validate";

export interface ChainInfo {
  chainId: number;
  chainLabel: string;
  usdcAddress: string;
  networkLabel: string;
}

/** Test hook: flows poll with real timers unless a test swaps this. */
export const flowTiming: { sleep?: FlowCtx["sleep"] } = {};

function report(outcome: FlowOutcome) {
  if (outcome.kind === "success") toast.success(outcome.message);
  else toast.info(outcome.message);
}

function flowError(e: unknown, fallback: string, chain: ChainInfo): string {
  if (e instanceof WrongChainError) return i18n.t("bridge:errors.wrongChain", { actual: e.actual ?? i18n.t("bridge:unknownChain"), chain: chain.chainLabel, expected: e.expected });
  return errorMessage(e, fallback);
}

// ── Base → RougeChain ─────────────────────────────────────────────────────────

export function EvmDepositForm({
  asset,
  conn,
  evm,
  chain,
  config,
  xrge,
  recipientPubkey,
  recipientAddress,
  onDone,
}: {
  asset: "ETH" | "USDC" | "XRGE";
  conn: BaseConnection;
  evm: EvmBalances;
  chain: ChainInfo;
  config: BridgeConfig;
  xrge: { vaultAddress?: string; tokenAddress?: string; enabled: boolean };
  recipientPubkey: string;
  recipientAddress: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation("bridge");
  const def = assetDef(asset);
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<"form" | "review" | "running">("form");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState<DepositAmount | null>(null);

  // Reset on asset switch.
  const [prevAsset, setPrevAsset] = useState(asset);
  if (prevAsset !== asset) {
    setPrevAsset(asset);
    setAmount("");
    setStage("form");
    setError("");
  }

  const parsed = amount ? parseDepositAmount(asset, amount) : null;
  const baseDecimals = asset === "USDC" ? 6 : 18;
  const balance = asset === "ETH" ? evm.eth : asset === "USDC" ? evm.usdc : evm.xrge;
  const insufficient = parsed?.ok && balance !== null && parsed.value.baseUnits > balance;
  const configured = asset === "XRGE" ? xrge.enabled && !!xrge.vaultAddress && !!xrge.tokenAddress : config.enabled && !!config.custodyAddress;

  const paused = asset !== "XRGE" && !evmDepositsEnabled();

  const review = () => {
    setError("");
    if (paused) return setError(t("errors.evmDepositsPaused"));
    if (!conn.address || !conn.provider) return setError(t("errors.connectBaseFirst"));
    if (conn.wrongChain) return setError(t("errors.wrongChain", { actual: conn.walletChainId ?? t("unknownChain"), chain: chain.chainLabel, expected: chain.chainId }));
    const p = parseDepositAmount(asset, amount);
    if (!p.ok) return setError(p.error);
    if (balance !== null && p.value.baseUnits > balance) return setError(t("errors.insufficientOnBase", { symbol: def.label }));
    setReviewed(p.value);
    setStage("review");
  };

  const confirm = async () => {
    if (!reviewed || !conn.address || !conn.provider) return;
    setStage("running");
    setError("");
    try {
      const outcome = await depositFromBase(
        {
          asset,
          provider: conn.provider,
          evmAddress: conn.address,
          chainId: chain.chainId,
          recipientPubkey,
          amount: reviewed,
          custodyAddress: config.custodyAddress,
          usdcAddress: chain.usdcAddress,
          xrge,
        },
        { onStep: setStep, sleep: flowTiming.sleep },
      );
      report(outcome);
      setAmount("");
      setStage("form");
      onDone();
    } catch (e) {
      setError(flowError(e, t("errors.depositFailed"), chain));
      setStage("review");
    } finally {
      setStep("");
    }
  };

  if (!configured) return <p className="bridge-callout">{asset === "XRGE" ? t("errors.xrgeNotConfigured") : t("errors.notConfigured")}</p>;

  if (stage !== "form" && reviewed) {
    const human = formatUnits(reviewed.baseUnits, baseDecimals);
    const receive = asset === "XRGE" ? reviewed.l1Units.toString() : formatUnits(reviewed.l1Units, 6);
    return (
      <div className="wallet-form" aria-live="polite">
        <h3 className="bridge-step-title">{t("review.title")}</h3>
        <dl className="review-list">
          <div>
            <dt>{t("review.youSend")}</dt>
            <dd className="mono">
              {human} {def.label} · {chain.chainLabel}
            </dd>
          </div>
          <div>
            <dt>{t("review.youReceive")}</dt>
            <dd className="mono">
              {receive} {def.l1Label} · RougeChain
            </dd>
          </div>
          <div>
            <dt>{t("review.baseWallet")}</dt>
            <dd className="mono" title={conn.address ?? ""}>
              {conn.address ? shortAddr(conn.address) : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("review.recipient")}</dt>
            <dd className="mono" title={recipientPubkey}>
              {recipientAddress ?? `${recipientPubkey.slice(0, 10)}…`}
            </dd>
          </div>
          <div>
            <dt>{t("review.network")}</dt>
            <dd>
              {chain.chainLabel} ({chain.chainId}) → {chain.networkLabel}
            </dd>
          </div>
          <div>
            <dt>{t("review.steps")}</dt>
            <dd>{asset === "XRGE" ? t("review.depositXrgeSteps") : asset === "ETH" ? t("review.depositEthSteps") : t("review.depositUsdcSteps")}</dd>
          </div>
        </dl>
        <p className="bridge-callout warning">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{t("review.irreversible")}</span>
        </p>
        {stage === "running" && (
          <p className="bridge-progress" role="status">
            <span className="spin-dot" aria-hidden="true" /> {step || t("processing")}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <Button variant="outline" type="button" disabled={stage === "running"} onClick={() => setStage("form")}>
            {t("form.back")}
          </Button>
          <Button type="button" disabled={stage === "running"} onClick={() => void confirm()}>
            {stage === "running" ? t("processing") : t("review.confirmDeposit")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="wallet-form"
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <BaseConnect conn={conn} chainLabel={chain.chainLabel} chainId={chain.chainId} />
      <label className="field">
        <span className="field-row">
          {t("form.from", { chain: chain.chainLabel })}
          {conn.address && balance !== null && (
            <span className="bridge-sub">{t("form.balance", { balance: `${formatBaseUnits(balance, baseDecimals, 6)} ${def.label}` })}</span>
          )}
        </span>
        <span className="bridge-amount">
          <input
            className="input mono"
            inputMode="decimal"
            aria-label={t("form.amountAria", { symbol: def.label })}
            placeholder={def.decimals ? "0.0" : "0"}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(",", "."));
              setError("");
            }}
            autoComplete="off"
          />
          <span className="bridge-unit">{def.label}</span>
        </span>
      </label>
      {parsed && !parsed.ok && <p className="form-hint error">{parsed.error}</p>}
      {insufficient && <p className="form-hint error">{t("errors.insufficientOnBase", { symbol: def.label })}</p>}
      <div className="bridge-to">
        <span>{t("form.to", { chain: "RougeChain" })}</span>
        <strong className="mono">
          {parsed?.ok ? (asset === "XRGE" ? parsed.value.l1Units.toString() : formatUnits(parsed.value.l1Units, 6)) : "0"} {def.l1Label}
        </strong>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {paused && (
        <p className="form-error" role="alert">
          {t("errors.evmDepositsPaused")}
        </p>
      )}
      <Button type="submit" disabled={paused || !conn.address || conn.wrongChain || !parsed?.ok || !!insufficient}>
        {t("form.review")}
      </Button>
      <p className="form-hint">{asset === "XRGE" ? t("info.depositXrge") : t("info.depositEvm", { asset: def.label, l1: def.l1Label })}</p>
    </form>
  );
}

// ── Bitcoin → qBTC ──────────────────────────────────────────────────────────

export function BtcDepositPanel({
  config,
  rougeAddress,
  qbtcBalance,
  onDone,
}: {
  config: BridgeConfig;
  rougeAddress: string | null;
  /** Raw sats; null until loaded. */
  qbtcBalance: number | null;
  onDone: () => void;
}) {
  const { t } = useTranslation("bridge");
  const [addr, setAddr] = useState<{ for: string; address: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [addrError, setAddrError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [txid, setTxid] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimStep, setClaimStep] = useState("");
  const [claimError, setClaimError] = useState("");
  const baseline = useRef<number | null>(null);
  const depositAddress = addr && addr.for === rougeAddress ? addr.address : null;
  const qr = useQr(depositAddress ? `bitcoin:${depositAddress}` : null);
  const custodyQr = useQr(advanced && config.btcCustodyAddress ? `bitcoin:${config.btcCustodyAddress}` : null);
  const testnet = config.btcNetwork === "testnet";

  // POST /bridge/btc/deposit-address { recipient: rouge1… } — same address every call for a recipient.
  const load = async (recipient: string) => {
    setLoading(true);
    setAddrError(null);
    try {
      const res = await getBtcDepositAddress(recipient);
      if (res.success && res.address) setAddr({ for: recipient, address: res.address });
      else {
        setAddr(null);
        const err = res.error || "";
        setAddrError(/pool/i.test(err) ? t("btc.addressWarmingUp") : err || t("btc.addressFetchFailed"));
      }
    } catch (e) {
      setAddrError(e instanceof Error ? e.message : t("btc.addressFetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (rougeAddress) void load(rougeAddress);
  }, [rougeAddress]);

  // Baseline qBTC when the panel opens; any increase afterwards is the deposit landing.
  if (baseline.current === null && qbtcBalance !== null) baseline.current = qbtcBalance;
  const received = baseline.current !== null && qbtcBalance !== null && qbtcBalance > baseline.current ? qbtcBalance - baseline.current : null;

  const claim = async () => {
    setClaimError("");
    const id = normalizeBtcTxid(txid);
    if (!id) return setClaimError(t("errors.invalidBtcTxid"));
    if (!rougeAddress) return setClaimError(t("errors.connectRougeToReceive"));
    setClaimBusy(true);
    try {
      const outcome = await claimBtcDeposit({ txid: id, rougeAddress }, { onStep: setClaimStep, sleep: flowTiming.sleep });
      report(outcome);
      if (outcome.kind === "success") {
        setTxid("");
        onDone();
      }
    } catch (e) {
      setClaimError(errorMessage(e, t("errors.btcClaimFailed")));
    } finally {
      setClaimBusy(false);
      setClaimStep("");
    }
  };

  return (
    <div className="wallet-form">
      {!rougeAddress ? (
        <p className="bridge-callout">{t("btc.connectForAddress")}</p>
      ) : received !== null ? (
        <div className="bridge-received" role="status">
          <Check size={22} aria-hidden="true" />
          <strong>{t("btc.received", { amount: formatUnits(received, 8) })}</strong>
          <span className="form-hint">{t("btc.nowInWallet")}</span>
        </div>
      ) : (
        <div className="bridge-deposit-address">
          <h3 className="bridge-step-title">{t("btc.yourDepositAddress")}</h3>
          {loading && (
            <p className="form-hint" role="status">
              {t("btc.fetchingAddress")}
            </p>
          )}
          {!loading && addrError && (
            <div className="wallet-form">
              <p className="form-hint error">{addrError}</p>
              <Button variant="outline small" type="button" onClick={() => void load(rougeAddress)}>
                {t("btc.tryAgain")}
              </Button>
            </div>
          )}
          {!loading && depositAddress && (
            <>
              {qr && <img className="bridge-qr" src={qr} alt={t("btc.depositQrAlt")} width={176} height={176} />}
              <CopyText value={depositAddress} label={t("btc.depositAddressLabel")} />
              <p className="form-hint">{t("btc.sendFromAnyWallet")}</p>
              {testnet && <p className="form-hint warning-text">{t("btc.testnetOnly")}</p>}
              <p className="form-hint bridge-watching">
                <span className="spin-dot" aria-hidden="true" /> {t("btc.watching")}
              </p>
            </>
          )}
        </div>
      )}

      {config.btcCustodyAddress && (
        <div className="bridge-advanced">
          <button type="button" className="bridge-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            <span>{t("btc.advanced.title")}</span>
            <ChevronDown size={16} aria-hidden="true" className={advanced ? "open" : ""} />
          </button>
          {advanced && (
            <div className="wallet-form">
              <p className="form-hint">{t("btc.advanced.intro")}</p>
              <ol className="bridge-steps">
                <li>
                  <strong>{t("btc.advanced.step1")}</strong>
                  {custodyQr && <img className="bridge-qr" src={custodyQr} alt={t("btc.advanced.custodyQrAlt")} width={176} height={176} />}
                  <CopyText value={config.btcCustodyAddress} label={t("btc.advanced.custodyAddressLabel")} />
                  {testnet && <p className="form-hint warning-text">{t("btc.testnetOnly")}</p>}
                </li>
                <li>
                  <strong>{t("btc.advanced.step2")}</strong>
                  <p className="form-hint">{t("btc.advanced.step2Help")}</p>
                  {rougeAddress ? <CopyText value={rougeAddress} label={t("btc.advanced.rougeAddressLabel")} /> : <p className="form-hint">{t("btc.connectForAddress")}</p>}
                  <p className="form-hint">{t("btc.advanced.opReturnWallets")}</p>
                </li>
                <li>
                  <strong>{t("btc.advanced.step3")}</strong>
                  <label className="field">
                    {t("btc.advanced.txidLabel")}
                    <input
                      className="input mono"
                      value={txid}
                      placeholder={t("btc.advanced.txidPlaceholder")}
                      onChange={(e) => setTxid(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  {claimBusy && (
                    <p className="bridge-progress" role="status">
                      <span className="spin-dot" aria-hidden="true" /> {claimStep || t("steps.waitingBitcoin")}
                    </p>
                  )}
                  {claimError && (
                    <p className="form-error" role="alert">
                      {claimError}
                    </p>
                  )}
                  <Button type="button" disabled={claimBusy || !txid.trim() || !rougeAddress} onClick={() => void claim()}>
                    {claimBusy ? t("claim.claiming") : t("btc.advanced.claimButton")}
                  </Button>
                  <p className="form-hint">{t("btc.advanced.claimHelp")}</p>
                </li>
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Claim an existing ETH/USDC deposit ────────────────────────────────────────

export function ClaimExistingCard({ conn, chain, recipientPubkey, onDone }: { conn: BaseConnection; chain: ChainInfo; recipientPubkey: string | null; onDone: () => void }) {
  const { t } = useTranslation("bridge");
  const [txHash, setTxHash] = useState("");
  const [token, setToken] = useState<"ETH" | "USDC">("USDC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const claim = async () => {
    setError("");
    const tx = txHash.trim();
    if (!isBaseTxHash(tx)) return setError(t("errors.invalidBaseTxHash"));
    if (!conn.address || !conn.provider) return setError(t("errors.connectSendingBaseWallet"));
    if (!recipientPubkey) return setError(t("errors.connectRougeToReceive"));
    setBusy(true);
    try {
      const outcome = await claimExistingDeposit(
        { provider: conn.provider, evmAddress: conn.address, txHash: tx, recipientPubkey, token, chainId: chain.chainId },
        { sleep: flowTiming.sleep },
      );
      report(outcome);
      setTxHash("");
      onDone();
    } catch (e) {
      setError(flowError(e, t("errors.claimFailed"), chain));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface bridge-card" aria-labelledby="bridge-claim-title">
      <h2 id="bridge-claim-title" className="bridge-card-title">
        {t("claim.title")}
      </h2>
      <p className="form-hint">{t("claim.help")}</p>
      <form
        className="wallet-form"
        onSubmit={(e) => {
          e.preventDefault();
          void claim();
        }}
      >
        <label className="field">
          {t("claim.txHashLabel")}
          <input className="input mono" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
        </label>
        <div className="chip-row" role="group" aria-label={t("claim.token")}>
          {(["USDC", "ETH"] as const).map((tok) => (
            <button key={tok} type="button" className={`chip ${token === tok ? "active" : ""}`} aria-pressed={token === tok} onClick={() => setToken(tok)}>
              {tok} → {L1_SYMBOL[tok]}
            </button>
          ))}
        </div>
        {!conn.address && <BaseConnect conn={conn} chainLabel={chain.chainLabel} chainId={chain.chainId} compact />}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!evmDepositsEnabled() && (
          <p className="form-error" role="alert">
            {t("errors.evmDepositsPaused")}
          </p>
        )}
        <Button type="submit" disabled={!evmDepositsEnabled() || busy || !txHash.trim() || !conn.address || !recipientPubkey}>
          {busy ? t("claim.claiming") : t("claim.button")}
        </Button>
      </form>
    </section>
  );
}
