import type { ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  XCircle,
} from "lucide-react";
import {
  HASH64,
  HEIGHT,
  swapSides,
  type TxDetail,
} from "@rougechain/chain-readonly";
import { useChain } from "./chain";
import { useRead, useStats } from "./read";
import { TxTable } from "./tables";
import { BridgeTransferPanel } from "./Bridge";
import {
  AddressLink,
  Amount,
  BlockLink,
  CopyHash,
  DetailList,
  ExplorerMain,
  NotFoundState,
  PageHeading,
  ReadGate,
  Section,
  SourceNote,
  Timestamp,
  TypePill,
  Xrge,
} from "./ui";

function Finality({ height }: { height: number }) {
  const stats = useStats();
  const finalized = stats.data?.finalizedHeight;
  if (finalized === null || finalized === undefined)
    return <span className="muted">Unknown</span>;
  return height <= finalized ? (
    <span className="pill ok">Finalized</span>
  ) : (
    <span className="pill">
      Not yet finalized (finalized height {finalized.toLocaleString()})
    </span>
  );
}

/** /block/:height. A 64-hex block hash is resolved to its height through /tx/:hash. */
export function BlockDetailPage() {
  const { height: param = "" } = useParams();
  if (HASH64.test(param.toLowerCase()))
    return <BlockByHash hash={param.toLowerCase()} />;
  if (!HEIGHT.test(param))
    return (
      <ExplorerMain>
        <NotFoundState
          title="Not a block height"
          back={{ to: "/explorer/blocks", label: "View all blocks" }}
        >
          “{param}” is not a block height or block hash.
        </NotFoundState>
      </ExplorerMain>
    );
  return <BlockByHeight height={Number(param)} />;
}

function BlockByHash({ hash }: { hash: string }) {
  const lookup = useRead(["tx", hash], (c) => c.tx(hash));
  if (lookup.data?.blockHash === hash)
    return <Navigate replace to={`/block/${lookup.data.blockHeight}`} />;
  if (lookup.data) return <Navigate replace to={`/tx/${hash}`} />;
  return (
    <ExplorerMain>
      <PageHeading eyebrow="Block" title="Finding block" />
      <SourceNote read={lookup} what="Block" />
      <ReadGate
        read={lookup}
        what="Block"
        notFound={
          <NotFoundState
            title="Block not found"
            back={{ to: "/explorer/blocks", label: "View all blocks" }}
          >
            No recent block or transaction has this hash. Only blocks that
            contain a transaction can be found by hash.
          </NotFoundState>
        }
      >
        {() => null}
      </ReadGate>
    </ExplorerMain>
  );
}

function BlockByHeight({ height }: { height: number }) {
  const { config } = useChain();
  const block = useRead(["block", height], (c) => c.block(height));
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={`Block · ${config.label}`}
        title={`Block #${height.toLocaleString()}`}
      >
        <span className="heading-actions">
          {height > 0 && (
            <Link className="button outline small" to={`/block/${height - 1}`}>
              <ArrowLeft size={14} /> Previous
            </Link>
          )}
          <Link className="button outline small" to={`/block/${height + 1}`}>
            Next <ArrowRight size={14} />
          </Link>
        </span>
      </PageHeading>
      <SourceNote read={block} what="Block" />
      <ReadGate
        read={block}
        what="Block"
        notFound={
          <NotFoundState
            title="Block not found"
            back={{ to: "/explorer/blocks", label: "View all blocks" }}
          >
            Block #{height.toLocaleString()} does not exist on {config.label}{" "}
            yet.
          </NotFoundState>
        }
      >
        {(b) => (
          <>
            <Section id="block-overview" title="Overview">
              <DetailList
                rows={[
                  ["Height", b.height.toLocaleString()],
                  ["Finality", <Finality key="f" height={b.height} />],
                  [
                    "Block hash",
                    <CopyHash
                      key="h"
                      hash={b.hash}
                      display={<code className="mono break">{b.hash}</code>}
                    />,
                  ],
                  [
                    "Parent hash",
                    b.height > 0 ? (
                      <Link
                        className="mono address-link break"
                        to={`/block/${b.height - 1}`}
                      >
                        {b.prevHash}
                      </Link>
                    ) : (
                      <span className="mono">{b.prevHash}</span>
                    ),
                  ],
                  ["Timestamp", <Timestamp key="t" ts={b.time} />],
                  [
                    "Proposer",
                    <AddressLink key="p" identity={b.proposer} full />,
                  ],
                  ["Transactions", b.txCount.toLocaleString()],
                  ["Total fees", <Xrge key="x" amount={b.totalFees} />],
                  [
                    "Transactions root",
                    b.txHash ? (
                      <code className="mono break">{b.txHash}</code>
                    ) : (
                      "—"
                    ),
                  ],
                  [
                    "State root",
                    b.stateRoot ? (
                      <code className="mono break">{b.stateRoot}</code>
                    ) : (
                      <span className="muted">
                        Not committed (before the state-root fork)
                      </span>
                    ),
                  ],
                ]}
              />
            </Section>
            <Section
              id="block-transactions"
              title="Transactions"
              meta={`${b.txCount} in this block.`}
            >
              <TxTable
                txs={b.transactions}
                showBlock={false}
                empty="No transactions in this block"
              />
            </Section>
          </>
        )}
      </ReadGate>
    </ExplorerMain>
  );
}

function StatusBanner({ tx }: { tx: TxDetail }) {
  if (tx.receipt?.status === "failed")
    return (
      <div className="status-banner failed" role="status">
        <XCircle size={20} />
        <div>
          <strong>Failed</strong>
          <p>
            Included in block #{tx.blockHeight.toLocaleString()} but execution
            failed: {tx.receipt.failReason ?? "no reason recorded"}.
          </p>
        </div>
      </div>
    );
  if (tx.receipt?.status === "success")
    return (
      <div className="status-banner success" role="status">
        <CheckCircle2 size={20} />
        <div>
          <strong>Success</strong>
          <p>
            Included in block #{tx.blockHeight.toLocaleString()} with a
            successful receipt.
          </p>
        </div>
      </div>
    );
  return (
    <div className="status-banner" role="status">
      <CircleDashed size={20} />
      <div>
        <strong>Included</strong>
        <p>
          Included in block #{tx.blockHeight.toLocaleString()}. The node
          recorded no execution receipt for it.
        </p>
      </div>
    </div>
  );
}

type Rows = [string, ReactNode][];
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const numOrNull = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function payloadJson(payload: Record<string, unknown>) {
  const entries = Object.entries(payload).filter(
    ([k, v]) => v !== null && v !== undefined && k !== "contract_wasm",
  );
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

export function TxDetailPage() {
  const { hash: param = "" } = useParams();
  const hash = param.toLowerCase();
  const valid = HASH64.test(hash);
  const tx = useRead(["tx", hash], (c) => c.tx(hash), { enabled: valid });
  if (!valid)
    return (
      <ExplorerMain>
        <NotFoundState
          title="Not a transaction hash"
          back={{ to: "/transactions", label: "View all transactions" }}
        >
          A transaction hash is 64 hexadecimal characters.
        </NotFoundState>
      </ExplorerMain>
    );
  // The node falls back to a block-hash lookup; send block hashes to the block page.
  if (tx.data && tx.data.blockHash === hash && tx.data.id !== hash)
    return <Navigate replace to={`/block/${tx.data.blockHeight}`} />;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow="Transaction"
        title="Transaction details"
        aside={tx.data ? <TypePill type={tx.data.type} /> : undefined}
      />
      <SourceNote read={tx} what="Transaction" />
      <ReadGate
        read={tx}
        what="Transaction"
        notFound={
          <NotFoundState
            title="Transaction not found"
            back={{ to: "/transactions", label: "View all transactions" }}
          >
            This transaction does not exist on this network, or has not been
            included in a block yet.
          </NotFoundState>
        }
      >
        {(t) => <TxBody tx={t} />}
      </ReadGate>
    </ExplorerMain>
  );
}

function TxBody({ tx: t }: { tx: TxDetail }) {
  const p = t.payload;
  const swap = swapSides(p);
  const isAmm = ["create_pool", "add_liquidity", "remove_liquidity"].includes(
    t.type,
  );
  const isContract = t.type === "contract_deploy" || t.type === "contract_call";
  const contractAddr = str(p.contract_addr);
  const gasUsed = t.receipt?.gasUsed ?? numOrNull(p.contract_gas_limit);
  const collectionId = str(p.nft_collection_id);
  return (
    <>
      <StatusBanner tx={t} />
      <Section id="tx-overview" title="Overview">
        <DetailList
          rows={[
            [
              "Transaction hash",
              <CopyHash
                key="h"
                hash={t.id}
                display={<code className="mono break">{t.id}</code>}
              />,
            ],
            [
              "Block",
              <span key="b" className="inline-row">
                <BlockLink height={t.blockHeight} />{" "}
                <Finality height={t.blockHeight} />
              </span>,
            ],
            ["Timestamp", <Timestamp key="t" ts={t.blockTime} />],
            ["Type", <TypePill key="ty" type={t.type} />],
            [
              "From",
              t.faucet ? (
                <span className="muted">Faucet</span>
              ) : (
                <AddressLink key="f" identity={t.from} full />
              ),
            ],
            ...(t.to
              ? ([
                  ["To", <AddressLink key="to" identity={t.to} full />],
                ] as Rows)
              : []),
            ...(t.amount !== null
              ? ([
                  [
                    "Amount",
                    <Amount key="a" raw={t.amount} symbol={t.symbol} />,
                  ],
                ] as Rows)
              : []),
            ["Fee", <Xrge key="fee" amount={t.receipt?.feePaid ?? t.fee} />],
            ...(t.nonce !== null ? ([["Nonce", String(t.nonce)]] as Rows) : []),
            ...(t.signatureBytes
              ? ([
                  [
                    "Signature",
                    `ML-DSA-65 · ${t.signatureBytes.toLocaleString()} bytes`,
                  ],
                ] as Rows)
              : []),
          ]}
        />
      </Section>
      {t.type === "swap" && (swap.tokenIn || swap.tokenOut) && (
        <Section id="tx-swap" title="Swap">
          <DetailList
            rows={[
              [
                "Token in",
                swap.tokenIn ? (
                  <Amount
                    key="in"
                    raw={swap.amountIn ?? null}
                    symbol={swap.tokenIn}
                  />
                ) : (
                  "—"
                ),
              ],
              [
                "Token out (minimum)",
                swap.tokenOut ? (
                  <Amount
                    key="out"
                    raw={swap.minOut ?? null}
                    symbol={swap.tokenOut}
                  />
                ) : (
                  "—"
                ),
              ],
              ["Pool", swap.poolId ?? "—"],
            ]}
          />
        </Section>
      )}
      {isAmm && (
        <Section id="tx-amm" title="Liquidity">
          <DetailList
            rows={[
              ["Pool", str(p.pool_id) ?? "—"],
              ...(str(p.token_a_symbol)
                ? ([
                    [
                      "Token A",
                      <Amount
                        key="a"
                        raw={numOrNull(p.amount_a)}
                        symbol={str(p.token_a_symbol)!}
                      />,
                    ],
                  ] as Rows)
                : []),
              ...(str(p.token_b_symbol)
                ? ([
                    [
                      "Token B",
                      <Amount
                        key="b"
                        raw={numOrNull(p.amount_b)}
                        symbol={str(p.token_b_symbol)!}
                      />,
                    ],
                  ] as Rows)
                : []),
              ...(numOrNull(p.lp_amount) !== null
                ? ([
                    ["LP units", numOrNull(p.lp_amount)!.toLocaleString()],
                  ] as Rows)
                : []),
            ]}
          />
        </Section>
      )}
      {isContract && (
        <Section
          id="tx-contract"
          title={
            t.type === "contract_deploy"
              ? "Contract deployment"
              : "Contract call"
          }
        >
          <DetailList
            rows={[
              [
                "Contract",
                contractAddr ? (
                  <Link
                    key="c"
                    className="mono address-link break"
                    to={`/contract/${contractAddr}`}
                  >
                    {contractAddr}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              ...(str(p.contract_method)
                ? ([
                    [
                      "Method",
                      <code key="m" className="mono">
                        {str(p.contract_method)}()
                      </code>,
                    ],
                  ] as Rows)
                : []),
              ...(gasUsed !== null
                ? ([
                    [
                      t.receipt?.gasUsed != null ? "Gas used" : "Gas limit",
                      gasUsed.toLocaleString(),
                    ],
                  ] as Rows)
                : []),
              ...(t.type === "contract_deploy" && numOrNull(p.amount) !== null
                ? ([
                    [
                      "WASM size",
                      `${numOrNull(p.amount)!.toLocaleString()} bytes`,
                    ],
                  ] as Rows)
                : []),
            ]}
          />
        </Section>
      )}
      {collectionId && (
        <Section id="tx-nft" title="NFT">
          <DetailList
            rows={[
              [
                "Collection",
                <Link
                  key="c"
                  className="address-link"
                  to={`/nfts/${encodeURIComponent(collectionId)}`}
                >
                  {collectionId}
                </Link>,
              ],
              ...(str(p.nft_token_name)
                ? ([["Token", str(p.nft_token_name)!]] as Rows)
                : []),
            ]}
          />
        </Section>
      )}
      {t.type === "create_token" && str(p.token_symbol) && (
        <Section id="tx-token" title="Token created">
          <DetailList
            rows={[
              [
                "Token",
                <Link
                  key="t"
                  className="address-link"
                  to={`/token/${encodeURIComponent(str(p.token_symbol)!)}`}
                >
                  {str(p.token_symbol)}
                </Link>,
              ],
              ["Name", str(p.token_name) ?? "—"],
              [
                "Initial supply",
                numOrNull(p.token_total_supply)?.toLocaleString() ?? "—",
              ],
            ]}
          />
        </Section>
      )}
      {(t.type === "bridge_withdraw" || t.type === "bridge_mint") && (
        <BridgeTransferPanel txId={t.id} />
      )}
      {t.receipt && t.receipt.logs.length > 0 && (
        <Section
          id="tx-logs"
          title="Event logs"
          meta={`${t.receipt.logs.length} emitted.`}
        >
          <ol className="log-list">
            {t.receipt.logs.map((log, i) => (
              <li key={i} className="surface">
                <div className="log-head">
                  <span className="mono muted">#{i}</span>
                  <strong>{log.event}</strong>
                </div>
                {log.topics.map((topic, ti) => (
                  <code key={ti} className="mono break">
                    [{ti}] {topic}
                  </code>
                ))}
                {log.data !== null && (
                  <pre className="code">
                    {typeof log.data === "string"
                      ? log.data
                      : JSON.stringify(log.data, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}
      <details className="raw-payload">
        <summary>Raw payload</summary>
        <pre className="code">{payloadJson(p)}</pre>
      </details>
    </>
  );
}
