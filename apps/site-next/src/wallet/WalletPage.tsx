import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Coins,
  DollarSign,
  Droplets,
  Eye,
  EyeOff,
  FileKey2,
  Lock,
  Plus,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
} from "lucide-react";
import { Button } from "@rougechain/ui";
import { describeAsset } from "@rougechain/core/asset-display";
import { formatUsd } from "@rougechain/core/price-service";
import type { WalletTransaction } from "@rougechain/core/pqc-wallet";
import { NetworkBadge, PageHeading } from "../explorer/ui";
import { useWallet } from "./WalletProvider";
import { MASKED_AMOUNT, networkLabel as netLabel, useExtensionProvider, useHideBalances, useMajorPrices, useRougeAddress, useTokenMetadata, useTokenPrices, useWalletData, useXrgePrice } from "./hooks";
import { CopyText, TokenIcon, UnlockForm } from "./parts";
import { SendDialog } from "./SendDialog";
import { ReceiveDialog } from "./ReceiveDialog";
import { CreateTokenDialog } from "./CreateTokenDialog";
import { BackupDialog, ImportForm } from "./BackupDialog";
import { BaseWalletCard } from "./BaseWallet";
import { OnboardingSteps, PasswordSetup, SeedReveal } from "./Onboarding";
import { claimFaucet } from "./send";
import { toast } from "./toast";
import { fmtNum, fmtRelative } from "../i18n/format";

function WalletMain({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="app-main wallet-main">
      <div className="container">{children}</div>
    </main>
  );
}

function Welcome() {
  const { t } = useTranslation("wallet");
  const extensionProvider = useExtensionProvider();
  const w = useWallet();
  const [params] = useSearchParams();
  const [importing, setImporting] = useState(params.get("import") === "1");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, fail: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(fail, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wallet-welcome">
      <section className="surface">
        <h2>{t("welcome.createTitle")}</h2>
        <p>{t("welcome.createBody")}</p>
        <Button disabled={busy} onClick={() => run(w.create, t("welcome.createFailed"))}>
          {t("welcome.createButton")}
        </Button>
      </section>
      <section className="surface">
        <h2>{t("welcome.importTitle")}</h2>
        <p>{t("welcome.importBody")}</p>
        {importing ? (
          <ImportForm />
        ) : (
          <Button variant="outline" onClick={() => setImporting(true)}>
            {t("welcome.importButton")}
          </Button>
        )}
      </section>
      <section className="surface">
        <h2>{t("welcome.extensionTitle")}</h2>
        <p>{extensionProvider ? t("welcome.extensionDetected") : t("welcome.extensionMissing")}</p>
        <div className="actions">
          <Button variant="outline" disabled={busy} onClick={() => run(w.connectExtension, t("welcome.connectFailed"))}>
            {t("welcome.connect")}
          </Button>
          <a className="text-link" href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj" target="_blank" rel="noreferrer">
            {t("welcome.getExtension")}
          </a>
        </div>
      </section>
    </div>
  );
}

const TX_TYPES: ReadonlySet<string> = new Set([
  "send",
  "receive",
  "swap",
  "create_token",
  "fee",
  "stake",
  "unstake",
  "add_liquidity",
  "remove_liquidity",
  "create_pool",
  "nft_mint",
  "nft_transfer",
  "bridge",
]);

function TxIcon({ type }: { type: WalletTransaction["type"] }) {
  if (type === "send") return <ArrowUpRight size={16} aria-hidden="true" />;
  if (type === "receive") return <ArrowDownLeft size={16} aria-hidden="true" />;
  if (type === "swap" || type === "bridge") return <ArrowLeftRight size={16} aria-hidden="true" />;
  if (type === "create_token" || type === "create_pool") return <Plus size={16} aria-hidden="true" />;
  return <Coins size={16} aria-hidden="true" />;
}

function History({ transactions, hidden, loaded }: { transactions: WalletTransaction[]; hidden: boolean; loaded: boolean }) {
  const { t } = useTranslation("wallet");
  const [limit, setLimit] = useState(10);
  return (
    <section className="surface wallet-panel" aria-labelledby="wallet-history-title">
      <div className="panel-head">
        <h2 id="wallet-history-title">{t("activity.title")}</h2>
      </div>
      {!loaded ? (
        <p className="muted">{t("activity.loading")}</p>
      ) : transactions.length === 0 ? (
        <div className="empty-state compact">
          <h3>{t("activity.emptyTitle")}</h3>
          <p>{t("activity.emptyBody")}</p>
        </div>
      ) : (
        <>
          <ul className="tx-rows">
            {transactions.slice(0, limit).map((tx, i) => (
              <li key={`${tx.txHash}-${i}`} className={tx.type}>
                <span className="tx-icon">
                  <TxIcon type={tx.type} />
                </span>
                <div className="tx-main">
                  <strong>{TX_TYPES.has(tx.type) ? t(`activity.types.${tx.type}`) : tx.type}</strong>
                  <small title={tx.memo || undefined}>
                    {tx.type === "send"
                      ? t("activity.to", { address: tx.address })
                      : tx.type === "receive"
                        ? t("activity.from", { address: tx.address })
                        : tx.address}{" "}
                    · {tx.timestamp ? fmtRelative(tx.timestamp, Date.now(), "short") : tx.timeLabel}
                  </small>
                </div>
                <div className="tx-amount">
                  <strong className="mono">
                    {tx.type === "send" ? "−" : tx.type === "receive" ? "+" : ""}
                    {hidden ? MASKED_AMOUNT : tx.amount} {tx.symbol}
                  </strong>
                  <Link className="mono" to={`/block/${tx.blockIndex}`}>
                    #{tx.blockIndex}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          {transactions.length > limit && (
            <Button variant="ghost small" onClick={() => setLimit((l) => l + 20)}>
              {t("activity.showMore")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function Dashboard() {
  const { t } = useTranslation("wallet");
  const w = useWallet();
  const wallet = w.wallet!;
  const { full: address } = useRougeAddress(wallet.signingPublicKey);
  const data = useWalletData(wallet.signingPublicKey, address, w.network);
  const metadata = useTokenMetadata(w.network);
  const { priceUsd: xrgeUsd, change24h } = useXrgePrice();
  const pools = useTokenPrices(xrgeUsd, w.network);
  const majors = useMajorPrices();
  const { hidden, toggle } = useHideBalances();
  const [dialog, setDialog] = useState<null | "send" | "receive" | "create" | "backup">(null);
  const [sendSymbol, setSendSymbol] = useState<string | undefined>();
  const [faucetBusy, setFaucetBusy] = useState(false);
  const isMainnet = w.network === "mainnet";
  const networkLabel = netLabel(w.network);

  // `metadata` is a dependency: loading it fills core's decimals cache used by describeAsset.
  const assets = useMemo(
    () =>
      data.balances.map((b) => ({
        b,
        d: describeAsset(b.symbol, b.balance, { poolPriceUsdPerRaw: pools[b.symbol], majors }),
        image: metadata[b.symbol]?.image ?? null,
      })),
    [data.balances, pools, majors, metadata],
  );
  const total = assets.some((a) => a.d.usd !== null) ? assets.reduce((s, a) => s + (a.d.usd ?? 0), 0) : null;
  const xrge = data.balances.find((b) => b.symbol === "XRGE")?.balance ?? 0;

  const faucet = async (token?: "qUSDC") => {
    setFaucetBusy(true);
    try {
      await claimFaucet(wallet.signingPublicKey, token);
      toast.success(token ? t("faucet.claimedUsdc") : t("faucet.claimedXrge"), { description: t("faucet.claimedBody") });
      for (const ms of [800, 2400]) window.setTimeout(data.refresh, ms);
    } catch (e) {
      toast.error(t("faucet.failed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <>
      <div className="wallet-grid">
        <div className="wallet-col">
          <section className="surface balance-card" aria-labelledby="balance-title">
            <div className="panel-head">
              <span id="balance-title" className="eyebrow">
                {w.displayName || t("myWallet")} · {networkLabel}
              </span>
              <Button variant="ghost icon" aria-label={hidden ? t("dashboard.showBalances") : t("dashboard.hideBalances")} aria-pressed={hidden} onClick={toggle}>
                {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
              </Button>
            </div>
            <div className="balance-total">
              {!data.loaded ? (
                <span className="muted">{t("loading")}</span>
              ) : hidden ? (
                `$${MASKED_AMOUNT}`
              ) : total !== null ? (
                formatUsd(total)
              ) : (
                `${xrge.toLocaleString()} XRGE`
              )}
            </div>
            <p className="balance-sub mono">
              {hidden ? MASKED_AMOUNT : xrge.toLocaleString()} XRGE
              {change24h !== null && !hidden && (
                <span className={change24h >= 0 ? "up" : "down"}>
                  {" "}
                  {change24h >= 0 ? "+" : ""}
                  {t("dashboard.change24h", { value: fmtNum(change24h, 2, { minimumFractionDigits: 2 }) })}
                </span>
              )}
            </p>
            {address ? <CopyText value={address} label={t("copy.address")} /> : <small className="muted">{t("dashboard.deriving")}</small>}
            {w.isExtension && <p className="form-hint">{t("dashboard.viaExtension")}</p>}
            {data.error && <p className="form-hint error">{t("dashboard.nodeError", { network: networkLabel, error: data.error })}</p>}
          </section>

          <nav className="quick-actions" aria-label={t("dashboard.actions")}>
            <button type="button" onClick={() => setDialog("send")} disabled={data.balances.length === 0}>
              <Send size={18} aria-hidden="true" />
              {t("dashboard.send")}
            </button>
            <button type="button" onClick={() => setDialog("receive")}>
              <ArrowDownLeft size={18} aria-hidden="true" />
              {t("dashboard.receive")}
            </button>
            {!isMainnet && (
              <>
                <button type="button" onClick={() => faucet()} disabled={faucetBusy} title={t("faucet.xrgeTitle")}>
                  <Droplets size={18} aria-hidden="true" />
                  {t("faucet.getXrge")}
                </button>
                <button type="button" onClick={() => faucet("qUSDC")} disabled={faucetBusy} title={t("faucet.usdcTitle")}>
                  <DollarSign size={18} aria-hidden="true" />
                  {t("faucet.getUsdc")}
                </button>
              </>
            )}
            <button type="button" onClick={() => setDialog("create")}>
              <Plus size={18} aria-hidden="true" />
              {t("dashboard.createToken")}
            </button>
            <button type="button" onClick={() => setDialog("backup")}>
              <FileKey2 size={18} aria-hidden="true" />
              {t("dashboard.backup")}
            </button>
          </nav>

          <section className="surface wallet-panel" aria-labelledby="assets-title">
            <div className="panel-head">
              <h2 id="assets-title">{t("assets.title")}</h2>
              <Button variant="ghost icon" aria-label={t("assets.refresh")} onClick={data.refresh} disabled={data.refreshing}>
                <RefreshCw size={15} className={data.refreshing ? "spin" : ""} />
              </Button>
            </div>
            {!data.loaded ? (
              <p className="muted">{t("assets.loading")}</p>
            ) : assets.length === 0 ? (
              <div className="empty-state compact">
                <h3>{t("assets.emptyTitle")}</h3>
                <p>{isMainnet ? t("assets.emptyMainnet") : t("assets.emptyTestnet")}</p>
              </div>
            ) : (
              <ul className="asset-rows">
                {assets.map(({ b, d, image }) => (
                  <li key={b.symbol}>
                    <TokenIcon symbol={b.symbol} image={image} />
                    <div className="asset-name">
                      <Link to={`/token/${encodeURIComponent(b.symbol)}`}>
                        <strong>{b.symbol}</strong>
                      </Link>
                      <small>{b.symbol === "XRGE" ? "RougeCoin" : (metadata[b.symbol]?.name ?? b.name)}</small>
                    </div>
                    <div className="asset-amount">
                      <strong className="mono">{hidden ? MASKED_AMOUNT : d.balance}</strong>
                      {d.usdValue && <small className="mono">{hidden ? `$${MASKED_AMOUNT}` : d.usdValue}</small>}
                    </div>
                    <Button
                      variant="ghost icon"
                      aria-label={t("assets.send", { symbol: b.symbol })}
                      onClick={() => {
                        setSendSymbol(b.symbol);
                        setDialog("send");
                      }}
                    >
                      <Send size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="wallet-col">
          <BaseWalletCard mnemonic={wallet.mnemonic} network={w.network} ethPriceUsd={majors.eth} xrgePriceUsd={xrgeUsd} hidden={hidden} />
          <History transactions={data.transactions} hidden={hidden} loaded={data.loaded} />
        </div>
      </div>

      <SendDialog
        key={`send-${sendSymbol ?? "XRGE"}`}
        open={dialog === "send"}
        balances={data.balances}
        initialSymbol={sendSymbol}
        onClose={() => {
          setDialog(null);
          setSendSymbol(undefined);
        }}
        onSent={() => {
          setDialog(null);
          setSendSymbol(undefined);
          data.refresh();
        }}
      />
      <ReceiveDialog open={dialog === "receive"} onClose={() => setDialog(null)} address={address} publicKey={wallet.signingPublicKey} networkLabel={networkLabel} />
      <CreateTokenDialog
        open={dialog === "create"}
        onClose={() => setDialog(null)}
        balances={data.balances}
        onCreated={() => {
          setDialog(null);
          data.refresh();
        }}
      />
      {dialog === "backup" && <BackupDialog open onClose={() => setDialog(null)} />}
    </>
  );
}

export default function WalletPage() {
  const { t } = useTranslation("wallet");
  const w = useWallet();
  let body: React.ReactNode;
  if (w.flow && w.flow.step === "seed" && w.status === "unlocked") body = <SeedReveal />;
  else if (w.flow && w.flow.step === "password" && w.status === "unlocked") body = <PasswordSetup mode={w.flow.mode} />;
  else if (w.flow && w.flow.step === "onboarding" && w.status === "unlocked") body = <OnboardingSteps mode={w.flow.mode} />;
  else if (w.status === "locked")
    body = (
      <section className="surface unlock-card">
        <Lock size={22} aria-hidden="true" />
        <h2>{w.displayName ? t("page.namedLocked", { name: w.displayName }) : t("page.locked")}</h2>
        {w.publicKey && <p className="mono break">{`${w.publicKey.slice(0, 32)}…${w.publicKey.slice(-12)}`}</p>}
        <UnlockForm />
      </section>
    );
  else if (w.status === "unlocked") body = <Dashboard />;
  else body = <Welcome />;

  return (
    <WalletMain>
      <PageHeading
        eyebrow={t("page.eyebrow")}
        title={t("page.title")}
        aside={
          <div className="heading-actions">
            <NetworkBadge />
            {w.status === "unlocked" && (
              <Link className="button ghost icon" to="/settings" aria-label={t("page.settings")}>
                <SettingsIcon size={16} />
              </Link>
            )}
          </div>
        }
      >
        {t("page.lede")}
      </PageHeading>
      {body}
    </WalletMain>
  );
}
