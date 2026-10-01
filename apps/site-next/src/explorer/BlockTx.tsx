import type { ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
  useNetworkLabel,
} from "./ui";
import { fmtInt } from "../i18n/format";

function Finality({ height }: { height: number }) {
  const { t } = useTranslation("explorer");
  const stats = useStats();
  const finalized = stats.data?.finalizedHeight;
  if (finalized === null || finalized === undefined)
    return <span className="muted">{t("block.finalityUnknown")}</span>;
  return height <= finalized ? (
    <span className="pill ok">{t("block.finalized")}</span>
  ) : (
    <span className="pill">
      {t("block.notFinalized", { height: fmtInt(finalized) })}
    </span>
  );
}

/** /block/:height. A 64-hex block hash is resolved to its height through /tx/:hash. */
export function BlockDetailPage() {
  const { t } = useTranslation("explorer");
  const { height: param = "" } = useParams();
  if (HASH64.test(param.toLowerCase()))
    return <BlockByHash hash={param.toLowerCase()} />;
  if (!HEIGHT.test(param))
    return (
      <ExplorerMain>
        <NotFoundState
          title={t("block.notHeight")}
          back={{ to: "/explorer/blocks", label: t("block.viewAll") }}
        >
          {t("block.notHeightBody", { param })}
        </NotFoundState>
      </ExplorerMain>
    );
  return <BlockByHeight height={Number(param)} />;
}

function BlockByHash({ hash }: { hash: string }) {
  const { t } = useTranslation("explorer");
  const lookup = useRead(["tx", hash], (c) => c.tx(hash));
  if (lookup.data?.blockHash === hash)
    return <Navigate replace to={`/block/${lookup.data.blockHeight}`} />;
  if (lookup.data) return <Navigate replace to={`/tx/${hash}`} />;
  return (
    <ExplorerMain>
      <PageHeading eyebrow={t("block.eyebrow")} title={t("block.finding")} />
      <SourceNote read={lookup} what={t("what.block")} />
      <ReadGate
        read={lookup}
        what={t("what.block")}
        notFound={
          <NotFoundState
            title={t("block.notFound")}
            back={{ to: "/explorer/blocks", label: t("block.viewAll") }}
          >
            {t("block.hashNotFoundBody")}
          </NotFoundState>
        }
      >
        {() => null}
      </ReadGate>
    </ExplorerMain>
  );
}

function BlockByHeight({ height }: { height: number }) {
  const { t } = useTranslation("explorer");
  const network = useNetworkLabel();
  const block = useRead(["block", height], (c) => c.block(height));
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={`${t("block.eyebrow")} · ${network}`}
        title={t("block.title", { height: fmtInt(height) })}
      >
        <span className="heading-actions">
          {height > 0 && (
            <Link className="button outline small" to={`/block/${height - 1}`}>
              <ArrowLeft size={14} /> {t("block.previous")}
            </Link>
          )}
          <Link className="button outline small" to={`/block/${height + 1}`}>
            {t("block.next")} <ArrowRight size={14} />
          </Link>
        </span>
      </PageHeading>
      <SourceNote read={block} what={t("what.block")} />
      <ReadGate
        read={block}
        what={t("what.block")}
        notFound={
          <NotFoundState
            title={t("block.notFound")}
            back={{ to: "/explorer/blocks", label: t("block.viewAll") }}
          >
            {t("block.heightNotFoundBody", { height: fmtInt(height), network })}
          </NotFoundState>
        }
      >
        {(b) => (
          <>
            <Section id="block-overview" title={t("detail.overview")}>
              <DetailList
                rows={[
                  [t("col.height"), fmtInt(b.height)],
                  [t("block.finality"), <Finality key="f" height={b.height} />],
                  [
                    t("col.blockHash"),
                    <CopyHash
                      key="h"
                      hash={b.hash}
                      display={<code className="mono break">{b.hash}</code>}
                    />,
                  ],
                  [
                    t("block.parentHash"),
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
                  [t("detail.timestamp"), <Timestamp key="t" ts={b.time} />],
                  [
                    t("col.proposer"),
                    <AddressLink key="p" identity={b.proposer} full />,
                  ],
                  [t("col.transactions"), fmtInt(b.txCount)],
                  [t("block.totalFees"), <Xrge key="x" amount={b.totalFees} />],
                  [
                    t("block.txRoot"),
                    b.txHash ? (
                      <code className="mono break">{b.txHash}</code>
                    ) : (
                      "—"
                    ),
                  ],
                  [
                    t("block.stateRoot"),
                    b.stateRoot ? (
                      <code className="mono break">{b.stateRoot}</code>
                    ) : (
                      <span className="muted">{t("block.noStateRoot")}</span>
                    ),
                  ],
                ]}
              />
            </Section>
            <Section
              id="block-transactions"
              title={t("col.transactions")}
              meta={t("block.txMeta", { n: fmtInt(b.txCount) })}
            >
              <TxTable
                txs={b.transactions}
                showBlock={false}
                empty={t("block.noTxs")}
              />
            </Section>
          </>
        )}
      </ReadGate>
    </ExplorerMain>
  );
}

function StatusBanner({ tx }: { tx: TxDetail }) {
  const { t } = useTranslation("explorer");
  const block = fmtInt(tx.blockHeight);
  if (tx.receipt?.status === "failed")
    return (
      <div className="status-banner failed" role="status">
        <XCircle size={20} />
        <div>
          <strong>{t("tx.failed")}</strong>
          <p>
            {t("tx.failedBody", {
              block,
              reason: tx.receipt.failReason ?? t("tx.noReason"),
            })}
          </p>
        </div>
      </div>
    );
  if (tx.receipt?.status === "success")
    return (
      <div className="status-banner success" role="status">
        <CheckCircle2 size={20} />
        <div>
          <strong>{t("tx.success")}</strong>
          <p>{t("tx.successBody", { block })}</p>
        </div>
      </div>
    );
  return (
    <div className="status-banner" role="status">
      <CircleDashed size={20} />
      <div>
        <strong>{t("tx.included")}</strong>
        <p>{t("tx.includedBody", { block })}</p>
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
  const { t } = useTranslation("explorer");
  const { hash: param = "" } = useParams();
  const hash = param.toLowerCase();
  const valid = HASH64.test(hash);
  const tx = useRead(["tx", hash], (c) => c.tx(hash), { enabled: valid });
  if (!valid)
    return (
      <ExplorerMain>
        <NotFoundState
          title={t("tx.notHash")}
          back={{ to: "/transactions", label: t("tx.viewAll") }}
        >
          {t("tx.notHashBody")}
        </NotFoundState>
      </ExplorerMain>
    );
  // The node falls back to a block-hash lookup; send block hashes to the block page.
  if (tx.data && tx.data.blockHash === hash && tx.data.id !== hash)
    return <Navigate replace to={`/block/${tx.data.blockHeight}`} />;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("col.transaction")}
        title={t("tx.title")}
        aside={tx.data ? <TypePill type={tx.data.type} /> : undefined}
      />
      <SourceNote read={tx} what={t("what.transaction")} />
      <ReadGate
        read={tx}
        what={t("what.transaction")}
        notFound={
          <NotFoundState
            title={t("tx.notFound")}
            back={{ to: "/transactions", label: t("tx.viewAll") }}
          >
            {t("tx.notFoundBody")}
          </NotFoundState>
        }
      >
        {(data) => <TxBody tx={data} />}
      </ReadGate>
    </ExplorerMain>
  );
}

function TxBody({ tx }: { tx: TxDetail }) {
  const { t } = useTranslation("explorer");
  const p = tx.payload;
  const swap = swapSides(p);
  const isAmm = ["create_pool", "add_liquidity", "remove_liquidity"].includes(
    tx.type,
  );
  const isContract = tx.type === "contract_deploy" || tx.type === "contract_call";
  const contractAddr = str(p.contract_addr);
  const gasUsed = tx.receipt?.gasUsed ?? numOrNull(p.contract_gas_limit);
  const collectionId = str(p.nft_collection_id);
  return (
    <>
      <StatusBanner tx={tx} />
      <Section id="tx-overview" title={t("detail.overview")}>
        <DetailList
          rows={[
            [
              t("tx.hash"),
              <CopyHash
                key="h"
                hash={tx.id}
                display={<code className="mono break">{tx.id}</code>}
              />,
            ],
            [
              t("col.block"),
              <span key="b" className="inline-row">
                <BlockLink height={tx.blockHeight} />{" "}
                <Finality height={tx.blockHeight} />
              </span>,
            ],
            [t("detail.timestamp"), <Timestamp key="t" ts={tx.blockTime} />],
            [t("col.type"), <TypePill key="ty" type={tx.type} />],
            [
              t("tx.from"),
              tx.faucet ? (
                <span className="muted">{t("tables.faucet")}</span>
              ) : (
                <AddressLink key="f" identity={tx.from} full />
              ),
            ],
            ...(tx.to
              ? ([
                  [t("tx.to"), <AddressLink key="to" identity={tx.to} full />],
                ] as Rows)
              : []),
            ...(tx.amount !== null
              ? ([
                  [
                    t("col.amount"),
                    <Amount key="a" raw={tx.amount} symbol={tx.symbol} />,
                  ],
                ] as Rows)
              : []),
            [t("col.fee"), <Xrge key="fee" amount={tx.receipt?.feePaid ?? tx.fee} />],
            ...(tx.nonce !== null ? ([[t("tx.nonce"), String(tx.nonce)]] as Rows) : []),
            ...(tx.signatureBytes
              ? ([
                  [
                    t("tx.signature"),
                    `ML-DSA-65 · ${t("bytes", { n: fmtInt(tx.signatureBytes) })}`,
                  ],
                ] as Rows)
              : []),
          ]}
        />
      </Section>
      {tx.type === "swap" && (swap.tokenIn || swap.tokenOut) && (
        <Section id="tx-swap" title={t("tx.swap")}>
          <DetailList
            rows={[
              [
                t("tx.tokenIn"),
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
                t("tx.tokenOutMin"),
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
              [t("col.pool"), swap.poolId ?? "—"],
            ]}
          />
        </Section>
      )}
      {isAmm && (
        <Section id="tx-amm" title={t("tx.liquidity")}>
          <DetailList
            rows={[
              [t("col.pool"), str(p.pool_id) ?? "—"],
              ...(str(p.token_a_symbol)
                ? ([
                    [
                      t("tx.tokenA"),
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
                      t("tx.tokenB"),
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
                    [t("col.lpUnits"), fmtInt(numOrNull(p.lp_amount)!)],
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
            tx.type === "contract_deploy"
              ? t("tx.contractDeploy")
              : t("tx.contractCall")
          }
        >
          <DetailList
            rows={[
              [
                t("col.contract"),
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
                      t("tx.method"),
                      <code key="m" className="mono">
                        {str(p.contract_method)}()
                      </code>,
                    ],
                  ] as Rows)
                : []),
              ...(gasUsed !== null
                ? ([
                    [
                      tx.receipt?.gasUsed != null ? t("tx.gasUsed") : t("tx.gasLimit"),
                      fmtInt(gasUsed),
                    ],
                  ] as Rows)
                : []),
              ...(tx.type === "contract_deploy" && numOrNull(p.amount) !== null
                ? ([
                    [
                      t("col.wasmSize"),
                      t("bytes", { n: fmtInt(numOrNull(p.amount)!) }),
                    ],
                  ] as Rows)
                : []),
            ]}
          />
        </Section>
      )}
      {collectionId && (
        <Section id="tx-nft" title={t("tx.nft")}>
          <DetailList
            rows={[
              [
                t("tx.collection"),
                <Link
                  key="c"
                  className="address-link"
                  to={`/nfts/${encodeURIComponent(collectionId)}`}
                >
                  {collectionId}
                </Link>,
              ],
              ...(str(p.nft_token_name)
                ? ([[t("col.token"), str(p.nft_token_name)!]] as Rows)
                : []),
            ]}
          />
        </Section>
      )}
      {tx.type === "create_token" && str(p.token_symbol) && (
        <Section id="tx-token" title={t("tx.tokenCreated")}>
          <DetailList
            rows={[
              [
                t("col.token"),
                <Link
                  key="t"
                  className="address-link"
                  to={`/token/${encodeURIComponent(str(p.token_symbol)!)}`}
                >
                  {str(p.token_symbol)}
                </Link>,
              ],
              [t("tx.name"), str(p.token_name) ?? "—"],
              [
                t("tx.initialSupply"),
                (() => {
                  const supply = numOrNull(p.token_total_supply);
                  return supply === null ? "—" : fmtInt(supply);
                })(),
              ],
            ]}
          />
        </Section>
      )}
      {(tx.type === "bridge_withdraw" || tx.type === "bridge_mint") && (
        <BridgeTransferPanel txId={tx.id} />
      )}
      {tx.receipt && tx.receipt.logs.length > 0 && (
        <Section
          id="tx-logs"
          title={t("tx.logs")}
          meta={t("tx.logsMeta", { n: fmtInt(tx.receipt.logs.length) })}
        >
          <ol className="log-list">
            {tx.receipt.logs.map((log, i) => (
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
        <summary>{t("tx.rawPayload")}</summary>
        <pre className="code">{payloadJson(p)}</pre>
      </details>
    </>
  );
}
