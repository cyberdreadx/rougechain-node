import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { Button, EmptyState } from "@rougechain/ui";
import {
  BRIDGE_CURSOR,
  CHAIN_LABELS,
  HASH64,
  STATUS_EXPLANATIONS,
  externalAddressUrl,
  externalExplorer,
  externalTxUrl,
  formatUnits,
  linkContext,
  missingExternalTxReason,
  readBridgeActivity,
  readBridgeTransfer,
  shorten,
  statusLabel,
  statusTone,
  tokenDecimals,
  type BridgeActivityView,
  type BridgeChain,
  type BridgeTransfer,
  type LinkContext,
} from "@rougechain/chain-readonly";
import { useChain } from "./chain";
import { useRead, useTokenDecimals } from "./read";
import {
  AddressLink,
  Age,
  BlockLink,
  CopyHash,
  DetailList,
  ExplorerMain,
  ExplorerSearch,
  NotFoundState,
  PageHeading,
  Pager,
  ReadGate,
  Section,
  SourceNote,
  Timestamp,
  usePageParam,
} from "./ui";
import { fmtInt } from "../i18n/format";
import "./bridge.css";

export const BRIDGE_PAGE_SIZE = 25;

export function bridgeDetailPath(txId: string) {
  return `/explorer/bridge/${txId}`;
}

// Labels from @rougechain/chain-readonly are English; they are translated here by key, with the
// package's English as the fallback for anything new.

/** "Base → RougeChain" etc. in the current language. */
function chainLabel(tr: TFunction, chain: BridgeChain) {
  return tr(`explorer:bridge.chain.${chain}`, {
    defaultValue: CHAIN_LABELS[chain],
  });
}

/** As directionLabel(), with translated chain names. */
function directionText(tr: TFunction, t: BridgeTransfer) {
  return `${chainLabel(tr, t.fromChain)} → ${chainLabel(tr, t.toChain)}`;
}

function statusText(tr: TFunction, t: BridgeTransfer) {
  const key =
    t.status === "paid" && t.kind === "deposit" ? "minted" : t.status;
  return tr(`explorer:bridge.status.${key}`, { defaultValue: statusLabel(t) });
}

function explanation(tr: TFunction, t: BridgeTransfer) {
  return tr(`explorer:bridge.reason.${t.statusReason}`, {
    defaultValue: STATUS_EXPLANATIONS[t.statusReason],
  });
}

const MISSING_KEYS: Record<string, string> = {
  "Source transaction not recorded by the node": "sourceNotRecorded",
  "External tx link available after node update": "afterUpdate",
  "No payout (refunded)": "refunded",
  "No payout (rejected on RougeChain)": "rejected",
  "Payout hash not recorded by the node": "payoutHashNotRecorded",
  "Payout not recorded by the node": "payoutNotRecorded",
  "Not paid out yet": "notPaidYet",
};

function missingReason(tr: TFunction, t: BridgeTransfer) {
  const english = missingExternalTxReason(t);
  const key = MISSING_KEYS[english];
  return key ? tr(`explorer:bridge.missing.${key}`) : english;
}

export function BridgeStatusPill({ t }: { t: BridgeTransfer }) {
  const { t: tr } = useTranslation("explorer");
  return (
    <span
      className={`pill bridge-status tone-${statusTone(t.status)}`}
      title={explanation(tr, t)}
    >
      {statusText(tr, t)}
    </span>
  );
}

/** Amount in whole units with the bridge asset's decimals (the node's token directory as backup). */
export function BridgeAmount({ t }: { t: BridgeTransfer }) {
  const known = useTokenDecimals();
  const decimals = t.decimals ?? tokenDecimals(t.asset, known);
  return (
    <span className="amount">
      {formatUnits(t.amountUnits, decimals)}{" "}
      <Link
        className="address-link"
        to={`/token/${encodeURIComponent(t.asset)}`}
      >
        {t.asset}
      </Link>
    </span>
  );
}

function ExternalLink({ href, children, label }: { href: string; children: ReactNode; label: string }) {
  return (
    <a
      className="mono address-link external-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      aria-label={label}
      title={href}
    >
      {children}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  );
}

export function ExternalTx({
  t,
  ctx,
  full = false,
}: {
  t: BridgeTransfer;
  ctx: LinkContext;
  full?: boolean;
}) {
  const { t: tr } = useTranslation("explorer");
  const url = externalTxUrl(t, ctx);
  const explorer = externalExplorer(t, ctx);
  if (!url || !t.externalTxHash || !explorer)
    return <span className="bridge-note">{missingReason(tr, t)}</span>;
  return (
    <ExternalLink
      href={url}
      label={tr("bridge.viewOn", {
        id: t.externalTxHash,
        explorer: explorer.name,
      })}
    >
      {full ? t.externalTxHash : shorten(t.externalTxHash, 10, 6)}
    </ExternalLink>
  );
}

function ExternalAddress({
  t,
  ctx,
  full = false,
}: {
  t: BridgeTransfer;
  ctx: LinkContext;
  full?: boolean;
}) {
  const { t: tr } = useTranslation("explorer");
  if (!t.externalAddress)
    return (
      <span className="bridge-note">
        {t.kind === "deposit" ? tr("bridge.senderNotRecorded") : "—"}
      </span>
    );
  const url = externalAddressUrl(t, ctx);
  const text = full ? t.externalAddress : shorten(t.externalAddress, 8, 6);
  const explorer = externalExplorer(t, ctx);
  return url && explorer ? (
    <ExternalLink
      href={url}
      label={tr("bridge.viewOn", {
        id: t.externalAddress,
        explorer: explorer.name,
      })}
    >
      {text}
    </ExternalLink>
  ) : (
    <span className="mono">{text}</span>
  );
}

function RougeParty({ t, full = false }: { t: BridgeTransfer; full?: boolean }) {
  return t.rougechainAddress ? (
    <AddressLink identity={t.rougechainAddress} full={full} />
  ) : (
    <span className="muted">—</span>
  );
}

function When({ t }: { t: BridgeTransfer }) {
  const { t: tr } = useTranslation("explorer");
  return t.timestamp !== null ? (
    <Age ts={t.timestamp} />
  ) : (
    <span className="bridge-note">{tr("bridge.inMempool")}</span>
  );
}

export function BridgeTable({
  items,
  ctx,
}: {
  items: BridgeTransfer[];
  ctx: LinkContext;
}) {
  const { t: tr } = useTranslation("explorer");
  if (!items.length)
    return (
      <EmptyState title={tr("bridge.none")}>{tr("bridge.noneBody")}</EmptyState>
    );
  return (
    <div className="table-scroll">
      <table className="stack-table bridge-table">
        <thead>
          <tr>
            <th>{tr("col.time")}</th>
            <th>{tr("col.direction")}</th>
            <th>{tr("col.amount")}</th>
            <th>{tr("col.fromTo")}</th>
            <th>{tr("col.status")}</th>
            <th>{tr("bridge.rougechainTx")}</th>
            <th>{tr("bridge.externalTx")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.rougechainTxId}>
              <td data-label={tr("col.time")}>
                <When t={t} />
              </td>
              <td data-label={tr("col.direction")}>
                <Link
                  className="bridge-direction address-link"
                  to={bridgeDetailPath(t.rougechainTxId)}
                >
                  {directionText(tr, t)}
                </Link>
              </td>
              <td data-label={tr("col.amount")}>
                <BridgeAmount t={t} />
              </td>
              <td data-label={tr("col.fromTo")} className="from-to">
                {t.kind === "withdrawal" ? (
                  <>
                    <RougeParty t={t} />
                    <span className="muted" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only"> {tr("tables.to")} </span>
                    <ExternalAddress t={t} ctx={ctx} />
                  </>
                ) : (
                  <>
                    <ExternalAddress t={t} ctx={ctx} />
                    <span className="muted" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only"> {tr("tables.to")} </span>
                    <RougeParty t={t} />
                  </>
                )}
              </td>
              <td data-label={tr("col.status")}>
                <BridgeStatusPill t={t} />
              </td>
              <td data-label={tr("bridge.rougechainTx")}>
                <Link
                  className="mono address-link"
                  to={`/tx/${t.rougechainTxId}`}
                  title={t.rougechainTxId}
                >
                  {shorten(t.rougechainTxId, 10, 6)}
                </Link>
              </td>
              <td data-label={tr("bridge.externalTx")}>
                <ExternalTx t={t} ctx={ctx} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FallbackNote({ data }: { data: BridgeActivityView }) {
  const { t } = useTranslation("explorer");
  return (
    <div className="data-note bridge-fallback" role="note">
      <strong>{t("bridge.reduced")}</strong>{" "}
      <span>
        {t("bridge.fallbackRebuilt", { n: fmtInt(data.scanned ?? 0) })}{" "}
        {data.pendingListsRead
          ? t("bridge.fallbackPending")
          : t("bridge.fallbackUnknown")}{" "}
        {t("bridge.afterUpdate")}
      </span>
    </div>
  );
}

function validCursor(value: string | null): string | undefined {
  return value && BRIDGE_CURSOR.test(value) ? value : undefined;
}

/** /explorer/bridge (also /bridge-activity, and /bridge on explorer.rougechain.io). */
export function BridgeActivityPage() {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  const [params, setParams] = useSearchParams();
  const before = validCursor(params.get("before"));
  const [page, setPage] = usePageParam();
  const read = useRead(
    ["bridge-activity", BRIDGE_PAGE_SIZE, before ?? ""],
    (c) => readBridgeActivity(c, { limit: BRIDGE_PAGE_SIZE, before }),
    { refetchMs: before ? undefined : 30_000, keepPrevious: true },
  );
  const setBefore = (cursor: string | null) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (cursor) p.set("before", cursor);
      else p.delete("before");
      p.delete("page");
      return p;
    });
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("eyebrow.explorer")}
        title={t("what.bridgeActivity")}
      >
        {t("bridge.intro")}
      </PageHeading>
      <ExplorerSearch />
      <Section
        id="bridge-transfers"
        title={t("bridge.transfers")}
        meta={
          read.data?.source === "node"
            ? t("bridge.nodeFeed")
            : read.data
              ? t("bridge.foundRecent", {
                  n: fmtInt(read.data.items.length),
                })
              : undefined
        }
      >
        <SourceNote read={read} what={t("what.bridgeActivity")} />
        {read.data?.source === "chain" && <FallbackNote data={read.data} />}
        <ReadGate read={read} what={t("what.bridgeActivity")}>
          {(data) => {
            const ctx = linkContext(network, data.config);
            if (data.source === "node")
              return (
                <>
                  <BridgeTable items={data.items} ctx={ctx} />
                  {(before || data.nextCursor) && (
                    <nav
                      className="pager"
                      aria-label={t("pager.aria", {
                        label: t("what.bridgeActivity"),
                      })}
                    >
                      <Button
                        variant="outline small"
                        disabled={!before}
                        onClick={() => setBefore(null)}
                      >
                        <RotateCcw size={14} /> {t("bridge.newest")}
                      </Button>
                      <Button
                        variant="outline small"
                        disabled={!data.nextCursor}
                        onClick={() => setBefore(data.nextCursor)}
                      >
                        {t("pager.older")} <ArrowRight size={14} />
                      </Button>
                    </nav>
                  )}
                </>
              );
            const totalPages = Math.max(
              1,
              Math.ceil(data.items.length / BRIDGE_PAGE_SIZE),
            );
            const current = Math.min(page, totalPages);
            return (
              <>
                <BridgeTable
                  items={data.items.slice(
                    (current - 1) * BRIDGE_PAGE_SIZE,
                    current * BRIDGE_PAGE_SIZE,
                  )}
                  ctx={ctx}
                />
                <Pager
                  page={current}
                  totalPages={totalPages}
                  onChange={setPage}
                  label={t("what.bridgeActivity")}
                />
              </>
            );
          }}
        </ReadGate>
      </Section>
    </ExplorerMain>
  );
}

function useBridgeTransfer(txId: string, enabled = true) {
  return useRead(
    ["bridge-transfer", txId],
    (c) => readBridgeTransfer(c, txId),
    { refetchMs: 60_000, enabled },
  );
}

function externalChainLabel(tr: TFunction, t: BridgeTransfer, ctx: LinkContext) {
  const external = t.kind === "withdrawal" ? t.toChain : t.fromChain;
  const explorer = externalExplorer(t, ctx);
  const id = t.externalChainId
    ? ` · ${tr("explorer:bridge.chainId", { id: t.externalChainId })}`
    : "";
  return `${chainLabel(tr, external)}${id}${explorer ? ` · ${explorer.name}` : ""}`;
}

function TransferDetails({ t, ctx }: { t: BridgeTransfer; ctx: LinkContext }) {
  const { t: tr } = useTranslation("explorer");
  const rows: [string, ReactNode][] = [
    [
      tr("col.status"),
      <span key="s" className="inline-row">
        <BridgeStatusPill t={t} />{" "}
        <span className="muted">{explanation(tr, t)}</span>
      </span>,
    ],
    [
      tr("col.direction"),
      `${directionText(tr, t)} (${t.kind === "deposit" ? tr("bridge.deposit") : tr("bridge.withdrawal")})`,
    ],
    [
      tr("col.amount"),
      <span key="a">
        <BridgeAmount t={t} />
        {t.externalAsset && t.externalAsset !== t.asset && (
          <span className="muted">
            {" · "}
            {tr("bridge.assetOn", {
              asset: t.externalAsset,
              chain: chainLabel(
                tr,
                t.kind === "withdrawal" ? t.toChain : t.fromChain,
              ),
            })}
          </span>
        )}
      </span>,
    ],
    [
      tr("bridge.rougechainTx"),
      <CopyHash
        key="tx"
        hash={t.rougechainTxId}
        label={tr("copy.txHash")}
        display={
          <Link className="mono address-link break" to={`/tx/${t.rougechainTxId}`}>
            {t.rougechainTxId}
          </Link>
        }
      />,
    ],
    [
      tr("col.block"),
      t.blockHeight !== null ? (
        <BlockLink key="b" height={t.blockHeight} />
      ) : (
        <span key="b" className="bridge-note">
          {tr("bridge.inMempool")}
        </span>
      ),
    ],
    [
      tr("col.time"),
      t.timestamp !== null ? <Timestamp key="t" ts={t.timestamp} /> : "—",
    ],
    [
      t.kind === "withdrawal"
        ? tr("bridge.fromRougechain")
        : tr("bridge.toRougechain"),
      <RougeParty key="p" t={t} full />,
    ],
    [tr("bridge.externalChain"), externalChainLabel(tr, t, ctx)],
    [
      t.kind === "withdrawal"
        ? tr("bridge.toExternal")
        : tr("bridge.fromExternal"),
      <ExternalAddress key="ea" t={t} ctx={ctx} full />,
    ],
    [
      t.kind === "withdrawal" ? tr("bridge.payoutTx") : tr("bridge.sourceTx"),
      <ExternalTx key="et" t={t} ctx={ctx} full />,
    ],
  ];
  if (t.statusUpdatedAt !== null)
    rows.push([
      tr("bridge.statusUpdated"),
      <Timestamp key="u" ts={t.statusUpdatedAt} />,
    ]);
  return <DetailList rows={rows} />;
}

function ChainSourceNote() {
  const { t } = useTranslation("explorer");
  return (
    <div className="data-note bridge-fallback" role="note">
      <strong>{t("bridge.reduced")}</strong>{" "}
      <span>
        {t("bridge.chainSource")} {t("bridge.afterUpdate")}
      </span>
    </div>
  );
}

/** /explorer/bridge/:txId */
export function BridgeTransferPage() {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  const { txId: param = "" } = useParams();
  const txId = param.toLowerCase();
  const valid = HASH64.test(txId);
  const read = useBridgeTransfer(txId, valid);
  const back = { to: "/explorer/bridge", label: t("bridge.viewActivity") };
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("bridge.eyebrow")}
        title={t("what.bridgeTransfer")}
      />
      {!valid ? (
        <NotFoundState title={t("bridge.notTxId")} back={back}>
          {t("bridge.notTxIdBody")}
        </NotFoundState>
      ) : (
        <>
          <SourceNote read={read} what={t("what.bridgeTransfer")} />
          <ReadGate
            read={read}
            what={t("what.bridgeTransfer")}
            notFound={
              <NotFoundState title={t("bridge.notTransfer")} back={back}>
                {t("bridge.notTransferBody")}
              </NotFoundState>
            }
          >
            {({ transfer, config }) => (
              <>
                {transfer.source === "chain" && <ChainSourceNote />}
                <Section id="bridge-transfer" title={t("bridge.transfer")}>
                  <TransferDetails
                    t={transfer}
                    ctx={linkContext(network, config)}
                  />
                </Section>
              </>
            )}
          </ReadGate>
        </>
      )}
    </ExplorerMain>
  );
}

/** The "Bridge transfer" panel on /tx/:hash for bridge_withdraw / bridge_mint transactions. */
export function BridgeTransferPanel({ txId }: { txId: string }) {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  const read = useBridgeTransfer(txId);
  const data = read.data;
  return (
    <Section
      id="tx-bridge"
      title={t("what.bridgeTransfer")}
      aside={
        <Link className="address-link" to={bridgeDetailPath(txId)}>
          {t("bridge.details")}
        </Link>
      }
    >
      {data ? (
        <>
          {data.transfer.source === "chain" && (
            <p className="bridge-note">{t("bridge.panelReduced")}</p>
          )}
          <DetailList
            rows={[
              [
                t("col.status"),
                <span key="s" className="inline-row">
                  <BridgeStatusPill t={data.transfer} />{" "}
                  <span className="muted">
                    {explanation(t, data.transfer)}
                  </span>
                </span>,
              ],
              [t("col.direction"), directionText(t, data.transfer)],
              [
                data.transfer.kind === "withdrawal"
                  ? t("bridge.toExternal")
                  : t("bridge.fromExternal"),
                <ExternalAddress
                  key="a"
                  t={data.transfer}
                  ctx={linkContext(network, data.config)}
                  full
                />,
              ],
              [
                data.transfer.kind === "withdrawal"
                  ? t("bridge.payoutTx")
                  : t("bridge.sourceTx"),
                <ExternalTx
                  key="x"
                  t={data.transfer}
                  ctx={linkContext(network, data.config)}
                  full
                />,
              ],
            ]}
          />
        </>
      ) : (
        <p className="bridge-note" role="status">
          {read.state === "loading"
            ? t("bridge.panelLoading")
            : read.state === "not-found"
              ? t("bridge.panelNotFound")
              : t("bridge.panelUnavailable")}
        </p>
      )}
    </Section>
  );
}
