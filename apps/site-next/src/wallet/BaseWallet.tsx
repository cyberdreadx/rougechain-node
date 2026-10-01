/**
 * The wallet's Base (Ethereum L2) account: same recovery phrase, standard Ethereum path — the
 * address Qwalla shows. Derivation, fee quotes and signing are core's evm-wallet / base-wallet.
 *
 * A wallet without a phrase here (connected through Qwalla's in-app browser or the RougeChain
 * extension) uses the injected EVM wallet's own Base account instead: read silently with
 * eth_accounts (never a popup on load), connected on click, and sends go through the wallet's
 * eth_sendTransaction so the key never leaves it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { formatUnits, type Hex } from "viem";
import { deriveBaseAddress, hasBaseAccount } from "@rougechain/core/evm-wallet";
import {
  baseAddressUrl,
  basePriceUsd,
  baseTxUrl,
  buildSendCall,
  checkBaseAddress,
  fetchBaseBalances,
  formatBaseUnits,
  getBaseChain,
  maxSendableEth,
  quoteBaseFee,
  signAndSendBase,
  toBaseUnits,
  type BaseAssetSymbol,
  type BaseBalance,
  type BaseChainInfo,
  type BaseFeeQuote,
} from "@rougechain/core/base-wallet";
import { formatUsd } from "@rougechain/core/price-service";
import type { NetworkType } from "@rougechain/core/network";
import { MASKED_AMOUNT } from "./hooks";
import { CopyText, TokenIcon } from "./parts";
import { useQr } from "./ReceiveDialog";
import { WrongChainError, ensureChain, pickInjected, toHex, useEip6963Wallets, type Eip1193Provider } from "../bridge/evm";

/** How a Base send is signed: locally from the phrase, or by the injected wallet (its approval). */
export type BaseSigner = { kind: "phrase"; mnemonic: string } | { kind: "injected"; provider: Eip1193Provider; walletName: string };

function isAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * The injected EVM wallet's Base account (Qwalla in-app browser / RougeChain extension / other).
 * On mount only eth_accounts is asked — it never prompts; `connect()` (a click) asks
 * eth_requestAccounts.
 */
export function useInjectedBaseAccount(enabled: boolean): {
  provider: Eip1193Provider | null;
  walletName: string | null;
  address: `0x${string}` | null;
  checked: boolean;
  connecting: boolean;
  error: unknown;
  connect(): Promise<void>;
} {
  const discovered = useEip6963Wallets();
  const picked = enabled ? pickInjected(discovered) : undefined;
  const provider = picked?.provider ?? null;
  const [state, setState] = useState<{ p: Eip1193Provider; address: `0x${string}` | null } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    provider
      .request({ method: "eth_accounts" })
      .then((list) => {
        if (!cancelled) setState({ p: provider, address: Array.isArray(list) && isAddress(list[0]) ? list[0] : null });
      })
      .catch(() => {
        if (!cancelled) setState({ p: provider, address: null });
      });
    const onAccounts = (...args: unknown[]) => {
      const list = args[0];
      setState({ p: provider, address: Array.isArray(list) && isAddress(list[0]) ? list[0] : null });
    };
    provider.on?.("accountsChanged", onAccounts);
    return () => {
      cancelled = true;
      provider.removeListener?.("accountsChanged", onAccounts);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider) return;
    setConnecting(true);
    setError(null);
    try {
      const list = await provider.request({ method: "eth_requestAccounts" });
      setState({ p: provider, address: Array.isArray(list) && isAddress(list[0]) ? list[0] : null });
    } catch (e) {
      setError(e);
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const current = state && state.p === provider ? state : null;
  return { provider, walletName: picked?.name ?? null, address: current?.address ?? null, checked: !!current, connecting, error, connect };
}

/** Base address for a phrase; derivation (BIP-39 PBKDF2) runs after the first paint. */
export function useBaseAddress(mnemonic: string | null | undefined): { address: `0x${string}` | null; ready: boolean; hasAccount: boolean } {
  const hasAccount = useMemo(() => hasBaseAccount(mnemonic), [mnemonic]);
  const [derived, setDerived] = useState<{ m: string; address: `0x${string}` | null } | null>(null);
  useEffect(() => {
    if (!hasAccount || !mnemonic) return;
    const id = window.setTimeout(() => {
      let address: `0x${string}` | null = null;
      try {
        address = deriveBaseAddress(mnemonic);
      } catch {
        address = null;
      }
      setDerived({ m: mnemonic, address });
    }, 0);
    return () => window.clearTimeout(id);
  }, [mnemonic, hasAccount]);
  const current = derived && derived.m === mnemonic ? derived : null;
  return { address: current?.address ?? null, ready: !hasAccount || !!current, hasAccount };
}

export function BaseWalletCard({
  mnemonic,
  network,
  ethPriceUsd,
  xrgePriceUsd,
  hidden,
}: {
  mnemonic?: string | null;
  network: NetworkType;
  ethPriceUsd: number | null;
  xrgePriceUsd: number | null;
  hidden: boolean;
}) {
  const { t } = useTranslation("wallet");
  const chain = useMemo(() => getBaseChain(network), [network]);
  const derived = useBaseAddress(mnemonic);
  const injected = useInjectedBaseAccount(!derived.hasAccount);
  const injectedName = injected.walletName ?? t("base.injectedFallbackName");
  const viaInjected = !derived.hasAccount && !!injected.provider;
  const address = derived.hasAccount ? derived.address : injected.address;
  const hasAccount = derived.hasAccount || viaInjected;
  const ready = derived.hasAccount ? derived.ready : injected.checked;
  const signer: BaseSigner | null = derived.hasAccount
    ? mnemonic
      ? { kind: "phrase", mnemonic }
      : null
    : injected.provider
      ? { kind: "injected", provider: injected.provider, walletName: injectedName }
      : null;
  const q = useQuery({
    queryKey: ["wallet", "base-balances", chain.chainId, address],
    enabled: !!address,
    queryFn: () => fetchBaseBalances(chain, address!),
    refetchInterval: 30_000,
    retry: false,
  });
  const [dialog, setDialog] = useState<"send" | "receive" | null>(null);
  const balances = q.data ?? null;
  const rows = (balances ?? []).map((b) => {
    const price = basePriceUsd(chain, b.asset.symbol, ethPriceUsd, xrgePriceUsd);
    const human = b.raw == null ? null : Number(formatUnits(b.raw, b.asset.decimals));
    return { ...b, amount: b.raw == null ? "—" : formatBaseUnits(b.raw, b.asset.decimals, b.asset.decimals === 6 ? 2 : 6), usd: human != null && price != null ? human * price : null };
  });
  const total = chain.isMainnet && rows.length ? rows.reduce((s, r) => s + (r.usd ?? 0), 0) : null;

  return (
    <section className="surface wallet-panel" aria-labelledby="base-wallet-title">
      <div className="panel-head">
        <h2 id="base-wallet-title">{t("base.title")}</h2>
        <span className={`pill ${chain.isMainnet ? "" : "warning"}`}>{chain.isMainnet ? chain.name : t("base.testnetPill", { chain: chain.name })}</span>
        {total != null && !hidden && <span className="mono muted panel-total">{formatUsd(total)}</span>}
      </div>
      {!hasAccount ? (
        <div className="empty-state compact">
          <h3>{t("base.noAccountTitle")}</h3>
          <p>{t("base.noAccountBody")}</p>
        </div>
      ) : !ready ? (
        <p className="muted">{viaInjected ? t("base.checkingWallet", { wallet: injectedName }) : t("base.deriving")}</p>
      ) : !address ? (
        viaInjected ? (
          <div className="empty-state compact">
            <p>{t("base.injectedConnectBody", { wallet: injectedName })}</p>
            <Button variant="outline small" disabled={injected.connecting} onClick={() => void injected.connect()}>
              {t("base.injectedConnect", { wallet: injectedName })}
            </Button>
            {injected.error != null && <p className="form-error" role="alert">{providerErrorMessage(injected.error, t("base.errors.connectFailed", { wallet: injectedName }), t)}</p>}
          </div>
        ) : (
          <p className="muted">{t("base.deriving")}</p>
        )
      ) : (
        <>
          <CopyText value={address} label={t("copy.baseAddress")} />
          <p className="form-hint">
            {viaInjected ? t("base.viaWallet", { wallet: injectedName }) : t("base.sameAsQwalla")}{" "}
            <a className="inline-link" href={baseAddressUrl(chain, address)} target="_blank" rel="noreferrer">
              {t("base.viewOnBaseScan")}
            </a>
          </p>
          {q.isError && <p className="form-hint error">{t("base.unreachable", { chain: chain.name })}</p>}
          <ul className="asset-rows">
            {rows.map((r) => (
              <li key={r.asset.symbol}>
                <TokenIcon symbol={r.asset.symbol} />
                <div className="asset-name">
                  <strong>{r.asset.name}</strong>
                  <small>{r.asset.symbol}</small>
                </div>
                <div className="asset-amount">
                  <strong className="mono">{hidden ? MASKED_AMOUNT : r.amount}</strong>
                  {r.usd != null && <small className="mono">{hidden ? `$${MASKED_AMOUNT}` : formatUsd(r.usd)}</small>}
                </div>
              </li>
            ))}
          </ul>
          <div className="actions">
            <Button variant="outline small" onClick={() => setDialog("send")} disabled={!balances}>
              {t("dashboard.send")}
            </Button>
            <Button variant="outline small" onClick={() => setDialog("receive")}>
              {t("dashboard.receive")}
            </Button>
          </div>
          <BaseReceiveDialog open={dialog === "receive"} onClose={() => setDialog(null)} chain={chain} address={address} />
          {balances && signer && (
            <BaseSendDialog
              open={dialog === "send"}
              onClose={() => setDialog(null)}
              chain={chain}
              address={address}
              signer={signer}
              balances={balances}
              ethPriceUsd={ethPriceUsd}
              xrgePriceUsd={xrgePriceUsd}
              onSent={() => void q.refetch()}
            />
          )}
        </>
      )}
    </section>
  );
}

function BaseReceiveDialog({ open, onClose, chain, address }: { open: boolean; onClose: () => void; chain: BaseChainInfo; address: string }) {
  const { t } = useTranslation("wallet");
  const qr = useQr(open ? address : null);
  return (
    <Dialog open={open} onClose={onClose} title={t("base.receiveTitle", { chain: chain.name })}>
      <div className="receive-body">
        <div className="qr-frame">{qr ? <img src={qr} alt={t("base.qrAlt")} width={220} height={220} /> : <span className="muted">{t("receive.generating")}</span>}</div>
        <CopyText value={address} label={t("copy.baseAddress")} />
        <p className="notice warning">
          {chain.isMainnet
            ? t("base.receiveMainnet", { chain: chain.name })
            : t("base.receiveTestnet", { chain: chain.name })}
        </p>
      </div>
    </Dialog>
  );
}

type Step = "form" | "review" | "sending" | "done";

type T = (key: string, opts?: Record<string, unknown>) => string;

/** A wallet (EIP-1193) error as text: user rejection (4001) in the site's words, else its message. */
function providerErrorMessage(e: unknown, fallback: string, t: T): string {
  if ((e as { code?: unknown } | null)?.code === 4001) return t("base.errors.rejected");
  if (e instanceof Error && e.message) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m : fallback;
}

/**
 * Base send: form → fee quote review → local sign (core) → broadcast; or, for an injected wallet,
 * the same call handed to its eth_sendTransaction (chain checked / switched first).
 */
export function BaseSendDialog({
  open,
  onClose,
  chain,
  address,
  signer,
  balances,
  ethPriceUsd,
  xrgePriceUsd,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  chain: BaseChainInfo;
  address: `0x${string}`;
  /** Phrase: read only at signing time; never stored or logged. Injected: the wallet signs. */
  signer: BaseSigner;
  balances: BaseBalance[];
  ethPriceUsd: number | null;
  xrgePriceUsd: number | null;
  onSent?: (hash: string) => void;
}) {
  const { t } = useTranslation("wallet");
  const [symbol, setSymbol] = useState<BaseAssetSymbol>("ETH");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [fee, setFee] = useState<BaseFeeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);

  const current = balances.find((b) => b.asset.symbol === symbol) ?? balances[0];
  const asset = current.asset;
  const balanceRaw = current.raw ?? 0n;
  const ethRaw = balances.find((b) => b.asset.symbol === "ETH")?.raw ?? 0n;
  const price = basePriceUsd(chain, symbol, ethPriceUsd, xrgePriceUsd);
  const addrCheck = checkBaseAddress(recipient);
  const units = useMemo(() => {
    try {
      return amount.trim() ? toBaseUnits(amount, asset.decimals) : null;
    } catch {
      return null;
    }
  }, [amount, asset.decimals]);
  const amountError =
    amount.trim() && (units == null || units <= 0n) ? t("base.errors.amountPositive") : units != null && units > balanceRaw ? t("base.errors.notEnough", { symbol }) : null;
  const recipientError =
    addrCheck === "invalid"
      ? t("base.errors.invalidAddress")
      : addrCheck === "bad-checksum"
        ? t("base.errors.checksum")
        : null;
  const canReview = addrCheck === "ok" && units != null && units > 0n && !amountError && !busy;
  const ethNeeded = (symbol === "ETH" ? (units ?? 0n) : 0n) + (fee?.totalFeeWei ?? 0n);
  const gasShort = fee != null && ethNeeded > ethRaw;

  const close = () => {
    if (step === "sending") return;
    setStep("form");
    setFee(null);
    setError(null);
    setHash(null);
    setAmount("");
    setRecipient("");
    onClose();
  };

  const pickMax = async () => {
    setError(null);
    if (asset.token) return setAmount(formatUnits(balanceRaw, asset.decimals));
    setBusy(true);
    try {
      const q = await quoteBaseFee(chain, address, buildSendCall(asset, addrCheck === "ok" ? recipient : address, 0n));
      const max = maxSendableEth(balanceRaw, q);
      setAmount(max > 0n ? formatUnits(max, 18) : "0");
      if (max === 0n) setError(t("base.errors.feeShortBy", { fee: formatBaseUnits(q.totalFeeWei, 18, 8) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!canReview || units == null) return;
    setBusy(true);
    setError(null);
    setFee(null);
    try {
      setFee(await quoteBaseFee(chain, address, buildSendCall(asset, recipient, units)));
    } catch (e) {
      setError(t("base.errors.estimate") + (e instanceof Error ? ` (${e.message})` : ""));
    } finally {
      setBusy(false);
      setStep("review");
    }
  };

  const injected = signer.kind === "injected" ? signer : null;
  // A phrase send needs the quote (it signs those exact fees); an injected wallet can price it itself.
  const canSend = units != null && !gasShort && (!!fee || !!injected);

  const send = async () => {
    if (!canSend || units == null) return;
    setStep("sending");
    setError(null);
    try {
      const call = buildSendCall(asset, recipient, units);
      let h: Hex;
      if (signer.kind === "phrase") {
        h = await signAndSendBase({ chain, mnemonic: signer.mnemonic, from: address, call, fee: fee! });
      } else {
        await ensureChain(signer.provider, chain.chainId);
        const tx: Record<string, string> = { from: address, to: call.to, value: toHex(call.value), data: call.data };
        if (fee) {
          tx.gas = toHex(fee.gasLimit);
          tx.maxFeePerGas = toHex(fee.maxFeePerGas);
          tx.maxPriorityFeePerGas = toHex(fee.maxPriorityFeePerGas);
        }
        const r = await signer.provider.request({ method: "eth_sendTransaction", params: [tx] });
        if (typeof r !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error(t("base.errors.noHash", { wallet: signer.walletName }));
        h = r as Hex;
      }
      setHash(h);
      setStep("done");
      onSent?.(h);
    } catch (e) {
      setError(
        e instanceof WrongChainError
          ? t("base.errors.wrongChain", { wallet: injected?.walletName ?? "", actual: e.actual ?? "?", expected: e.expected, chain: chain.name })
          : providerErrorMessage(e, String(e), t),
      );
      setStep("review");
    }
  };

  const warning = (
    <p className="notice warning">
      {chain.isMainnet
        ? t("base.warnMainnet")
        : t("base.warnTestnet")}
    </p>
  );

  return (
    <Dialog open={open} onClose={close} title={step === "done" ? t("base.sentTitle") : step === "form" ? t("base.sendTitle", { chain: chain.name }) : t("base.confirmTitle")}>
      {step === "form" && (
        <form
          className="wallet-form"
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          {warning}
          <div className="mode-switch" role="group" aria-label={t("base.asset")}>
            {balances.map((b) => (
              <Button
                type="button"
                key={b.asset.symbol}
                variant={b.asset.symbol === symbol ? "secondary small" : "ghost small"}
                aria-pressed={b.asset.symbol === symbol}
                onClick={() => {
                  setSymbol(b.asset.symbol);
                  setAmount("");
                  setError(null);
                }}
              >
                {b.asset.symbol} · {b.raw == null ? "—" : formatBaseUnits(b.raw, b.asset.decimals, 4)}
              </Button>
            ))}
          </div>
          <label className="field">
            {t("base.recipient")}
            <input className="input mono" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} />
          </label>
          {recipientError && <p className="form-hint error">{recipientError}</p>}
          {addrCheck === "ok" && recipient.toLowerCase() === address.toLowerCase() && <p className="form-hint">{t("base.ownAddress")}</p>}
          <label className="field">
            <span className="field-row">
              {t("send.amount")}
              <button type="button" className="inline-link" onClick={pickMax} disabled={busy}>
                {t("base.max")}
              </button>
            </span>
            <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} placeholder="0.0" />
          </label>
          {amountError && <p className="form-hint error">{amountError}</p>}
          {asset.token && <p className="form-hint">{t("base.feesInEth")}</p>}
          {error && <p className="form-error">{error}</p>}
          <Button type="submit" disabled={!canReview}>
            {busy ? t("base.estimating") : t("send.review")}
          </Button>
        </form>
      )}
      {(step === "review" || step === "sending") && units != null && (
        <div className="wallet-form">
          {warning}
          <dl className="review-list">
            <div>
              <dt>{t("send.reviewSend")}</dt>
              <dd className="mono">
                {formatBaseUnits(units, asset.decimals, 8)} {symbol}
                {price != null && ` · ${formatUsd(Number(formatUnits(units, asset.decimals)) * price)}`}
              </dd>
            </div>
            <div>
              <dt>{t("base.from")}</dt>
              <dd className="mono">{address}</dd>
            </div>
            <div>
              <dt>{t("send.reviewTo")}</dt>
              <dd className="mono">{recipient}</dd>
            </div>
            <div>
              <dt>{t("send.reviewNetwork")}</dt>
              <dd>{chain.name}</dd>
            </div>
            <div>
              <dt>{t("base.maxFee")}</dt>
              <dd className="mono">{fee ? `${formatBaseUnits(fee.totalFeeWei, 18, 8)} ETH` : "—"}</dd>
            </div>
          </dl>
          {gasShort && <p className="form-error">{t("base.errors.feeShort")}</p>}
          {error && <p className="form-error">{error}</p>}
          {injected ? (
            <p className="form-hint">
              {t("base.approveInWallet", { wallet: injected.walletName })}
              {!fee && ` ${t("base.walletSetsFee", { wallet: injected.walletName })}`}
            </p>
          ) : (
            <p className="form-hint">{t("base.signedLocally")}</p>
          )}
          <div className="actions">
            <Button variant="outline" onClick={() => setStep("form")} disabled={step === "sending"}>
              {t("send.back")}
            </Button>
            <Button onClick={send} disabled={!canSend || step === "sending"}>
              {step === "sending"
                ? injected
                  ? t("base.waitingWallet", { wallet: injected.walletName })
                  : t("base.sending")
                : injected
                  ? t("base.confirmInWallet", { wallet: injected.walletName })
                  : t("base.signAndSend")}
            </Button>
          </div>
        </div>
      )}
      {step === "done" && hash && (
        <div className="wallet-form">
          <p>{t("base.confirmSoon", { chain: chain.name })}</p>
          <a className="inline-link mono" href={baseTxUrl(chain, hash)} target="_blank" rel="noreferrer">
            {hash.slice(0, 18)}… ↗
          </a>
          <Button onClick={close}>{t("base.done")}</Button>
        </div>
      )}
    </Dialog>
  );
}
