/**
 * /bridge — Base ⇄ RougeChain (ETH, USDC, XRGE) and Bitcoin ⇄ qBTC, at parity with apps/web's
 * Bridge page. Every node call and signature goes through @rougechain/core (see flows.ts).
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, ShieldAlert } from "lucide-react";
import { Button, Status } from "@rougechain/ui";
import {
  BASE_MAINNET_CHAIN_ID,
  expectedBaseChainId,
  getBaseChainConfig,
  getBridgeConfig,
  getUsdcAddress,
  getXrgeBridgeConfig,
  isKnownBaseChain,
  type BridgeConfig,
  type XrgeBridgeConfig,
} from "@rougechain/core/bridge";
import { getBaseChain } from "@rougechain/core/base-wallet";
import { getWalletBalance } from "@rougechain/core/pqc-wallet";
import type { NetworkType } from "@rougechain/core/network";
import { useWallet } from "../wallet/WalletProvider";
import { useMajorPrices, useRougeAddress } from "../wallet/hooks";
import { UnlockForm } from "../wallet/parts";
import { useBaseAddress } from "../wallet/BaseWallet";
import { ApprovalDialog } from "./ApprovalDialog";
import { BtcDepositPanel, ClaimExistingCard, EvmDepositForm, type ChainInfo } from "./DepositPanels";
import { ActivityCard, PendingWithdrawalsCard } from "./StatusCards";
import { useBaseConnection, useEvmBalances } from "./useBaseConnection";
import { WithdrawPanel, type L1Balances } from "./WithdrawPanel";
import { ASSETS, type BridgeAsset, type BtcNetwork } from "./validate";
import "./bridge-app.css";

type Direction = "deposit" | "withdraw";

interface Configs {
  config: BridgeConfig;
  xrge: XrgeBridgeConfig;
}

async function loadConfigs(): Promise<Configs> {
  // Same fallbacks as apps/web: a failed read is treated as "bridge not enabled".
  const [config, xrge] = await Promise.all([
    getBridgeConfig().catch(() => ({ enabled: false }) as BridgeConfig),
    getXrgeBridgeConfig().catch(() => ({ enabled: false }) as XrgeBridgeConfig),
  ]);
  return { config, xrge };
}

function Heading({ network }: { network: NetworkType }) {
  const { t } = useTranslation("bridge");
  return (
    <div className="app-page-heading bridge-heading">
      <div>
        <div className="eyebrow">{t("eyebrow")}</div>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
      </div>
      <Status state={network === "mainnet" ? "live" : "warning"}>{t(`networkBadge.${network}`)}</Status>
    </div>
  );
}

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="app-main bridge-main">
      <div className="container">{children}</div>
    </main>
  );
}

function Blocked({ tone, title, body, action }: { tone: "muted" | "warning" | "error"; title?: string; body: string; action?: React.ReactNode }) {
  return (
    <section className={`surface bridge-blocked tone-${tone}`} role={tone === "muted" ? "status" : "alert"}>
      {tone === "muted" ? <ArrowRightLeft size={28} aria-hidden="true" /> : <ShieldAlert size={28} aria-hidden="true" />}
      {title && <h2>{title}</h2>}
      <p>{body}</p>
      {action}
    </section>
  );
}

export default function BridgePage() {
  const { t } = useTranslation("bridge");
  const { network } = useWallet();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bridge", "config", network], queryFn: loadConfigs, retry: false, staleTime: 60_000 });

  if (!q.data) {
    return (
      <Main>
        <Heading network={network} />
        <p className="form-hint" role="status">
          {t("loading")}
        </p>
      </Main>
    );
  }
  const { config, xrge } = q.data;
  if (!config.enabled && !xrge.enabled) {
    return (
      <Main>
        <Heading network={network} />
        <Blocked
          tone="muted"
          body={t("notEnabled")}
          action={
            <Button variant="outline small" onClick={() => void qc.invalidateQueries({ queryKey: ["bridge", "config", network] })}>
              {t("retry")}
            </Button>
          }
        />
      </Main>
    );
  }
  // Fail closed (apps/web): an unrecognized Base chain, or the wrong one for this RougeChain network.
  const detected = config.chainId ?? xrge.chainId;
  if (!isKnownBaseChain(detected)) {
    return (
      <Main>
        <Heading network={network} />
        <Blocked tone="warning" title={t("networkUnknown.title")} body={t("networkUnknown.body")} />
      </Main>
    );
  }
  const expected = expectedBaseChainId(network);
  if (detected !== expected) {
    return (
      <Main>
        <Heading network={network} />
        <Blocked
          tone="error"
          title={t("networkMismatch.title")}
          body={t("networkMismatch.body", {
            network: t(`networkWord.${network}`),
            chainLabel: getBaseChainConfig(detected).name,
            chainId: detected,
            assets: network === "testnet" ? t("networkMismatch.realMainnetAssets") : t("networkMismatch.testnetAssets"),
          })}
        />
      </Main>
    );
  }
  return (
    <Main>
      <Heading network={network} />
      <BridgeApp key={network} network={network} chainId={detected} config={config} xrge={xrge} />
    </Main>
  );
}

function BridgeApp({ network, chainId, config, xrge }: { network: NetworkType; chainId: number; config: BridgeConfig; xrge: XrgeBridgeConfig }) {
  const { t } = useTranslation("bridge");
  const w = useWallet();
  const qc = useQueryClient();
  const { full: rougeAddress } = useRougeAddress(w.publicKey);
  const [direction, setDirection] = useState<Direction>("deposit");
  const [asset, setAsset] = useState<BridgeAsset>("ETH");
  const [refreshKey, setRefreshKey] = useState(0);
  const { eth: ethPriceUsd } = useMajorPrices();

  const chainCfg = getBaseChainConfig(chainId ?? BASE_MAINNET_CHAIN_ID);
  const chain: ChainInfo = {
    chainId,
    chainLabel: chainCfg.name,
    usdcAddress: getUsdcAddress(chainId),
    networkLabel: `RougeChain ${t(`networkBadge.${network}`)}`,
  };
  const localChain = useMemo(() => getBaseChain(network), [network]);
  const btcNetwork: BtcNetwork = config.btcNetwork ?? (network === "mainnet" ? "mainnet" : "testnet");

  const unlocked = w.status === "unlocked" && !!w.wallet;
  const mnemonic = w.wallet?.mnemonic ?? null;
  const conn = useBaseConnection({ chainId, network, mnemonic });
  const myBase = useBaseAddress(mnemonic);
  const evm = useEvmBalances(conn.provider, conn.address, chain.usdcAddress, xrge.tokenAddress, refreshKey);

  // RougeChain balances (core getWalletBalance → GET /balance/:pubkey); polled every 20 s as apps/web's BTC panel.
  const balQ = useQuery({
    queryKey: ["bridge", "balances", network, w.publicKey],
    queryFn: () => getWalletBalance(w.publicKey!),
    enabled: unlocked && !!w.publicKey,
    refetchInterval: 20_000,
    retry: false,
  });
  const balances: L1Balances = useMemo(() => {
    const list = balQ.data;
    const pick = (s: string) => (list ? (list.find((b) => b.symbol === s)?.balance ?? 0) : null);
    return { XRGE: pick("XRGE"), qETH: pick("qETH"), qUSDC: pick("qUSDC"), qBTC: pick("qBTC") };
  }, [balQ.data]);

  const onDone = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void qc.invalidateQueries({ queryKey: ["bridge", "balances"] });
    window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["bridge", "balances"] }), 3000);
  }, [qc]);

  // Only offer BTC when the node configured the BTC bridge (apps/web).
  const btcConfigured = !!config.btcCustodyAddress && (config.supportedTokens?.includes("BTC") ?? true);
  const visible = ASSETS.filter((a) => a.id !== "BTC" || btcConfigured);
  const current = visible.some((a) => a.id === asset) ? asset : "ETH";

  const walletGate = !unlocked ? (
    w.status === "locked" ? (
      <div className="wallet-form">
        <p className="bridge-callout">{t("wallet.locked")}</p>
        <UnlockForm />
      </div>
    ) : (
      <div className="wallet-form">
        <p className="bridge-callout">{t("wallet.none")}</p>
        <Link className="button" to="/wallet">
          {t("wallet.open")}
        </Link>
      </div>
    )
  ) : null;

  const wallet = w.wallet;
  return (
    <div className="bridge-layout">
      <section className="surface bridge-panel" aria-label={t("title")}>
        <div className="bridge-tabs" role="tablist" aria-label={t("title")}>
          {(["deposit", "withdraw"] as const).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={direction === d} className={direction === d ? "active" : ""} onClick={() => setDirection(d)}>
              {d === "deposit" ? <ArrowDownToLine size={16} aria-hidden="true" /> : <ArrowUpFromLine size={16} aria-hidden="true" />}
              {t(`tabs.${d}`)}
            </button>
          ))}
        </div>
        <div className="bridge-panel-body">
          <div className="field">
            <span>{t("asset")}</span>
            <div className="chip-row bridge-assets" role="group" aria-label={t("asset")}>
              {visible.map((a) => (
                <button key={a.id} type="button" className={`chip ${current === a.id ? "active" : ""}`} aria-pressed={current === a.id} onClick={() => setAsset(a.id)}>
                  {direction === "deposit" ? a.label : a.l1Label}
                </button>
              ))}
            </div>
            <span className="form-hint">
              {direction === "deposit"
                ? `${current === "BTC" ? "Bitcoin" : chain.chainLabel} → RougeChain`
                : `RougeChain → ${current === "BTC" ? "Bitcoin" : chain.chainLabel}`}
            </span>
          </div>

          {walletGate ??
            (wallet && (
              <>
                {w.isExtension && <p className="form-hint">{t("wallet.extension")}</p>}
                {direction === "deposit" ? (
                  current === "BTC" ? (
                    <BtcDepositPanel key={`btc-${network}`} config={config} rougeAddress={rougeAddress} qbtcBalance={balances.qBTC} onDone={onDone} />
                  ) : (
                    <EvmDepositForm
                      asset={current}
                      conn={conn}
                      evm={evm}
                      chain={chain}
                      config={config}
                      xrge={xrge}
                      recipientPubkey={wallet.signingPublicKey}
                      recipientAddress={rougeAddress}
                      onDone={onDone}
                    />
                  )
                ) : (
                  <WithdrawPanel
                    asset={current}
                    config={config}
                    btcNetwork={btcNetwork}
                    chainLabel={chain.chainLabel}
                    chainId={chainId}
                    networkLabel={chain.networkLabel}
                    wallet={{ publicKey: wallet.signingPublicKey, privateKey: wallet.signingPrivateKey || undefined }}
                    balances={balances}
                    myBaseAddress={myBase.address}
                    available={current === "XRGE" ? xrge.enabled : config.enabled}
                    onDone={onDone}
                  />
                )}
              </>
            ))}
        </div>
      </section>

      <aside className="bridge-side">
        {unlocked && wallet && <ClaimExistingCard conn={conn} chain={chain} recipientPubkey={wallet.signingPublicKey} onDone={onDone} />}
        {w.publicKey && <PendingWithdrawalsCard pubkey={w.publicKey} network={network} btcNetwork={config.btcNetwork} refreshKey={refreshKey} />}
        {w.publicKey && <ActivityCard pubkey={w.publicKey} network={network} refreshKey={refreshKey} />}
      </aside>

      {conn.pendingApproval && <ApprovalDialog chain={localChain} request={conn.pendingApproval.req} ethPriceUsd={ethPriceUsd} onResolve={conn.resolveApproval} />}
    </div>
  );
}
