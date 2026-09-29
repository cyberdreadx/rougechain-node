import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { Button, EmptyState } from "@rougechain/ui";
import {
  BRIDGE_CURSOR,
  CHAIN_LABELS,
  HASH64,
  STATUS_EXPLANATIONS,
  directionLabel,
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
import "./bridge.css";

export const BRIDGE_PAGE_SIZE = 25;

export function bridgeDetailPath(txId: string) {
  return `/explorer/bridge/${txId}`;
}

export function BridgeStatusPill({ t }: { t: BridgeTransfer }) {
  return (
    <span
      className={`pill bridge-status tone-${statusTone(t.status)}`}
      title={STATUS_EXPLANATIONS[t.statusReason]}
    >
      {statusLabel(t)}
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
  const url = externalTxUrl(t, ctx);
  const explorer = externalExplorer(t, ctx);
  if (!url || !t.externalTxHash || !explorer)
    return <span className="bridge-note">{missingExternalTxReason(t)}</span>;
  return (
    <ExternalLink
      href={url}
      label={`View ${t.externalTxHash} on ${explorer.name}`}
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
  if (!t.externalAddress)
    return (
      <span className="bridge-note">
        {t.kind === "deposit" ? "Sender not recorded" : "—"}
      </span>
    );
  const url = externalAddressUrl(t, ctx);
  const text = full ? t.externalAddress : shorten(t.externalAddress, 8, 6);
  const explorer = externalExplorer(t, ctx);
  return url && explorer ? (
    <ExternalLink href={url} label={`View ${t.externalAddress} on ${explorer.name}`}>
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
  return t.timestamp !== null ? (
    <Age ts={t.timestamp} />
  ) : (
    <span className="bridge-note">In mempool</span>
  );
}

export function BridgeTable({
  items,
  ctx,
}: {
  items: BridgeTransfer[];
  ctx: LinkContext;
}) {
  if (!items.length)
    return (
      <EmptyState title="No bridge transfers">
        No deposits or withdrawals were found here.
      </EmptyState>
    );
  return (
    <div className="table-scroll">
      <table className="stack-table bridge-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Direction</th>
            <th>Amount</th>
            <th>From → To</th>
            <th>Status</th>
            <th>RougeChain tx</th>
            <th>External tx</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.rougechainTxId}>
              <td data-label="Time">
                <When t={t} />
              </td>
              <td data-label="Direction">
                <Link
                  className="bridge-direction address-link"
                  to={bridgeDetailPath(t.rougechainTxId)}
                >
                  {directionLabel(t)}
                </Link>
              </td>
              <td data-label="Amount">
                <BridgeAmount t={t} />
              </td>
              <td data-label="From → To" className="from-to">
                {t.kind === "withdrawal" ? (
                  <>
                    <RougeParty t={t} />
                    <span className="muted" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only"> to </span>
                    <ExternalAddress t={t} ctx={ctx} />
                  </>
                ) : (
                  <>
                    <ExternalAddress t={t} ctx={ctx} />
                    <span className="muted" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only"> to </span>
                    <RougeParty t={t} />
                  </>
                )}
              </td>
              <td data-label="Status">
                <BridgeStatusPill t={t} />
              </td>
              <td data-label="RougeChain tx">
                <Link
                  className="mono address-link"
                  to={`/tx/${t.rougechainTxId}`}
                  title={t.rougechainTxId}
                >
                  {shorten(t.rougechainTxId, 10, 6)}
                </Link>
              </td>
              <td data-label="External tx">
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
  return (
    <div className="data-note bridge-fallback" role="note">
      <strong>Reduced detail.</strong>{" "}
      <span>
        This node does not serve bridge history yet, so this list is rebuilt
        from on-chain bridge transactions in the node's recent-block index (
        {(data.scanned ?? 0).toLocaleString()} transactions scanned).{" "}
        {data.pendingListsRead
          ? "Withdrawals still in the node's pending-payout lists are shown as Pending; the rest as Completed."
          : "The pending-payout lists could not be read, so withdrawal status is Unknown."}{" "}
        External tx links will be available after the node update.
      </span>
    </div>
  );
}

function validCursor(value: string | null): string | undefined {
  return value && BRIDGE_CURSOR.test(value) ? value : undefined;
}

/** /explorer/bridge (also /bridge-activity, and /bridge on explorer.rougechain.io). */
export function BridgeActivityPage() {
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
      <PageHeading eyebrow="Explorer" title="Bridge activity">
        Deposits into RougeChain and withdrawals out of it, across Base and
        Bitcoin, with the transaction on both sides.
      </PageHeading>
      <ExplorerSearch />
      <Section
        id="bridge-transfers"
        title="Bridge transfers"
        meta={
          read.data?.source === "node"
            ? "Newest first, from the node's bridge activity feed."
            : read.data
              ? `${read.data.items.length.toLocaleString()} found in recent blocks.`
              : undefined
        }
      >
        <SourceNote read={read} what="Bridge activity" />
        {read.data?.source === "chain" && <FallbackNote data={read.data} />}
        <ReadGate read={read} what="Bridge activity">
          {(data) => {
            const ctx = linkContext(network, data.config);
            if (data.source === "node")
              return (
                <>
                  <BridgeTable items={data.items} ctx={ctx} />
                  {(before || data.nextCursor) && (
                    <nav className="pager" aria-label="Bridge activity pages">
                      <Button
                        variant="outline small"
                        disabled={!before}
                        onClick={() => setBefore(null)}
                      >
                        <RotateCcw size={14} /> Newest
                      </Button>
                      <Button
                        variant="outline small"
                        disabled={!data.nextCursor}
                        onClick={() => setBefore(data.nextCursor)}
                      >
                        Older <ArrowRight size={14} />
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
                  label="Bridge activity"
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

function externalChainLabel(t: BridgeTransfer, ctx: LinkContext) {
  const external = t.kind === "withdrawal" ? t.toChain : t.fromChain;
  const explorer = externalExplorer(t, ctx);
  const id = t.externalChainId ? ` · chain id ${t.externalChainId}` : "";
  return `${CHAIN_LABELS[external]}${id}${explorer ? ` · ${explorer.name}` : ""}`;
}

function TransferDetails({ t, ctx }: { t: BridgeTransfer; ctx: LinkContext }) {
  const rows: [string, ReactNode][] = [
    [
      "Status",
      <span key="s" className="inline-row">
        <BridgeStatusPill t={t} />{" "}
        <span className="muted">{STATUS_EXPLANATIONS[t.statusReason]}</span>
      </span>,
    ],
    [
      "Direction",
      `${directionLabel(t)} (${t.kind === "deposit" ? "deposit" : "withdrawal"})`,
    ],
    [
      "Amount",
      <span key="a">
        <BridgeAmount t={t} />
        {t.externalAsset && t.externalAsset !== t.asset && (
          <span className="muted"> · {t.externalAsset} on {CHAIN_LABELS[t.kind === "withdrawal" ? t.toChain : t.fromChain]}</span>
        )}
      </span>,
    ],
    [
      "RougeChain tx",
      <CopyHash
        key="tx"
        hash={t.rougechainTxId}
        label="transaction hash"
        display={
          <Link className="mono address-link break" to={`/tx/${t.rougechainTxId}`}>
            {t.rougechainTxId}
          </Link>
        }
      />,
    ],
    [
      "Block",
      t.blockHeight !== null ? (
        <BlockLink key="b" height={t.blockHeight} />
      ) : (
        <span key="b" className="bridge-note">
          In mempool
        </span>
      ),
    ],
    [
      "Time",
      t.timestamp !== null ? <Timestamp key="t" ts={t.timestamp} /> : "—",
    ],
    [
      t.kind === "withdrawal" ? "From (RougeChain)" : "To (RougeChain)",
      <RougeParty key="p" t={t} full />,
    ],
    ["External chain", externalChainLabel(t, ctx)],
    [
      t.kind === "withdrawal" ? "To (external)" : "From (external)",
      <ExternalAddress key="ea" t={t} ctx={ctx} full />,
    ],
    [
      t.kind === "withdrawal" ? "Payout tx" : "Source tx",
      <ExternalTx key="et" t={t} ctx={ctx} full />,
    ],
  ];
  if (t.statusUpdatedAt !== null)
    rows.push(["Status updated", <Timestamp key="u" ts={t.statusUpdatedAt} />]);
  return <DetailList rows={rows} />;
}

function ChainSourceNote() {
  return (
    <div className="data-note bridge-fallback" role="note">
      <strong>Reduced detail.</strong>{" "}
      <span>
        This node does not serve bridge history yet: the transfer is read from
        its RougeChain transaction and the node's pending-payout lists. External
        tx links will be available after the node update.
      </span>
    </div>
  );
}

/** /explorer/bridge/:txId */
export function BridgeTransferPage() {
  const { network } = useChain();
  const { txId: param = "" } = useParams();
  const txId = param.toLowerCase();
  const valid = HASH64.test(txId);
  const read = useBridgeTransfer(txId, valid);
  const back = { to: "/explorer/bridge", label: "View bridge activity" };
  return (
    <ExplorerMain>
      <PageHeading eyebrow="Bridge" title="Bridge transfer" />
      {!valid ? (
        <NotFoundState title="Not a transaction id" back={back}>
          A bridge transfer is identified by its 64-character RougeChain
          transaction hash.
        </NotFoundState>
      ) : (
        <>
          <SourceNote read={read} what="Bridge transfer" />
          <ReadGate
            read={read}
            what="Bridge transfer"
            notFound={
              <NotFoundState title="Not a bridge transfer" back={back}>
                This transaction is not a bridge deposit or withdrawal on this
                network, or it does not exist.
              </NotFoundState>
            }
          >
            {({ transfer, config }) => (
              <>
                {transfer.source === "chain" && <ChainSourceNote />}
                <Section id="bridge-transfer" title="Transfer">
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
  const { network } = useChain();
  const read = useBridgeTransfer(txId);
  const data = read.data;
  return (
    <Section
      id="tx-bridge"
      title="Bridge transfer"
      aside={
        <Link className="address-link" to={bridgeDetailPath(txId)}>
          Bridge details
        </Link>
      }
    >
      {data ? (
        <>
          {data.transfer.source === "chain" && (
            <p className="bridge-note">
              Reduced detail until the node update: status from the node's
              pending-payout lists.
            </p>
          )}
          <DetailList
            rows={[
              [
                "Status",
                <span key="s" className="inline-row">
                  <BridgeStatusPill t={data.transfer} />{" "}
                  <span className="muted">
                    {STATUS_EXPLANATIONS[data.transfer.statusReason]}
                  </span>
                </span>,
              ],
              ["Direction", directionLabel(data.transfer)],
              [
                data.transfer.kind === "withdrawal"
                  ? "To (external)"
                  : "From (external)",
                <ExternalAddress
                  key="a"
                  t={data.transfer}
                  ctx={linkContext(network, data.config)}
                  full
                />,
              ],
              [
                data.transfer.kind === "withdrawal" ? "Payout tx" : "Source tx",
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
            ? "Reading the bridge status…"
            : read.state === "not-found"
              ? "The node does not recognise this as a bridge transfer."
              : "The bridge status could not be read from the node."}
        </p>
      )}
    </Section>
  );
}
