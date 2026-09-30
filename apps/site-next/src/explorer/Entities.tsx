import type { ReactNode } from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EmptyState, Metric } from "@rougechain/ui";
import {
  COLLECTION_ID,
  CONTRACT_ADDR,
  TOKEN_SYMBOL,
  formatTokenAmount,
  formatUnits,
  formatXrge,
  isPubkeyHex,
  isRougeAddress,
  pubkeyToAddress,
  safeExternalUrl,
  shorten,
  type NftToken,
} from "@rougechain/chain-readonly";
import { useRead, useTokenDecimals } from "./read";
import { TxTable } from "./tables";
import {
  AddressLink,
  Age,
  BlockLink,
  CopyHash,
  DetailList,
  ExplorerMain,
  NotFoundState,
  PageHeading,
  Pager,
  ReadGate,
  SafeImage,
  Section,
  SourceNote,
  Timestamp,
  TypePill,
  usePageParam,
  useNetworkLabel,
} from "./ui";
import { fmtInt, fmtNum } from "../i18n/format";

const ACTIVITY_PER_PAGE = 25;
const NFTS_PER_PAGE = 24;
const EVENTS_PER_PAGE = 25;

// ─── Address ─────────────────────────────────────────────────────────────────

/**
 * /address/:pubkey accepts a rouge1 address or a public key. A public key's rouge1 address is
 * derived locally; a rouge1 address is resolved to its public key when the node knows it (needed
 * only for the NFT lookup, which the node indexes by public key).
 */
export function AddressDetailPage() {
  const { t } = useTranslation("explorer");
  const { pubkey: param = "" } = useParams();
  const location = useLocation();
  const raw = param.trim();
  const lower = raw.toLowerCase();
  const statePubkey = (location.state as { pubkey?: unknown } | null)?.pubkey;
  const isAddress = isRougeAddress(lower);
  const isKey = !isAddress && isPubkeyHex(lower);
  const knownKey = isKey
    ? lower
    : typeof statePubkey === "string" && isPubkeyHex(statePubkey)
      ? statePubkey
      : null;
  const address = isAddress ? lower : isKey ? pubkeyToAddress(lower) : null;
  const resolved = useRead(["resolve", address], (c) => c.resolve(address!), {
    enabled: isAddress && !knownKey,
  });
  const pubkey = knownKey ?? resolved.data?.publicKey ?? null;
  const [page, setPage] = usePageParam();
  const offset = (page - 1) * ACTIVITY_PER_PAGE;
  const balance = useRead(["balance", address], (c) => c.balance(address!), {
    enabled: !!address,
    refetchMs: 60_000,
  });
  const activity = useRead(
    ["address-txs", address, offset],
    (c) => c.addressTxs(address!, ACTIVITY_PER_PAGE, offset),
    {
      enabled: !!address,
      refetchMs: page === 1 ? 60_000 : undefined,
      keepPrevious: true,
    },
  );
  const nfts = useRead(["owner-nfts", pubkey], (c) => c.ownerNfts(pubkey!), {
    enabled: !!pubkey,
  });
  const decimals = useTokenDecimals();

  if (!address)
    return (
      <ExplorerMain>
        <NotFoundState
          title={t("address.invalid")}
          back={{ to: "/explorer", label: t("address.back") }}
        >
          {t("address.invalidBody")}
        </NotFoundState>
      </ExplorerMain>
    );
  const b = balance.data;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("address.eyebrow")}
        title={<span className="address-title">{shorten(address, 14, 8)}</span>}
      />
      <DetailList
        rows={[
          [
            t("address.eyebrow"),
            <CopyHash
              key="a"
              hash={address}
              label={t("copy.address")}
              display={<code className="mono break">{address}</code>}
            />,
          ],
          [
            t("address.publicKey"),
            pubkey ? (
              <details key="pk" className="pubkey">
                <summary className="mono">
                  {shorten(pubkey, 16, 8)} ·{" "}
                  {t("bytes", { n: fmtInt(pubkey.length / 2) })}
                </summary>
                <CopyHash
                  hash={pubkey}
                  label={t("copy.publicKey")}
                  display={<code className="mono break">{pubkey}</code>}
                />
              </details>
            ) : resolved.state === "loading" ? (
              <span className="muted">{t("address.resolving")}</span>
            ) : (
              <span className="muted">{t("address.keyUnrevealed")}</span>
            ),
          ],
        ]}
      />
      <Section id="balances" title={t("what.balances")}>
        <SourceNote read={balance} what={t("what.balances")} />
        <ReadGate read={balance} what={t("what.balances")}>
          {() => (
            <div className="metrics">
              <Metric
                label={t("address.xrgeBalance")}
                value={formatXrge(b!.xrge)}
              />
              <Metric
                label={t("address.tokensHeld")}
                value={fmtInt(b!.tokens.filter(([, v]) => v > 0).length)}
              />
              <Metric
                label={t("address.lpPositions")}
                value={fmtInt(b!.lp.filter(([, v]) => v > 0).length)}
              />
              <Metric
                label={t("col.transactions")}
                value={activity.data ? fmtInt(activity.data.total) : "—"}
              />
            </div>
          )}
        </ReadGate>
        {b && b.tokens.some(([, v]) => v > 0) && (
          <div className="table-scroll sub-table">
            <table className="stack-table">
              <thead>
                <tr>
                  <th>{t("col.token")}</th>
                  <th>{t("col.balance")}</th>
                </tr>
              </thead>
              <tbody>
                {b.tokens
                  .filter(([, v]) => v > 0)
                  .map(([symbol, raw]) => (
                    <tr key={symbol}>
                      <td data-label={t("col.token")}>
                        <Link
                          className="address-link"
                          to={`/token/${encodeURIComponent(symbol)}`}
                        >
                          {symbol}
                        </Link>
                      </td>
                      <td data-label={t("col.balance")} className="amount">
                        {formatTokenAmount(raw, symbol, decimals)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        {b && b.lp.some(([, v]) => v > 0) && (
          <div className="table-scroll sub-table">
            <table className="stack-table">
              <thead>
                <tr>
                  <th>{t("address.liquidityPool")}</th>
                  <th>{t("col.lpUnits")}</th>
                </tr>
              </thead>
              <tbody>
                {b.lp
                  .filter(([, v]) => v > 0)
                  .map(([pool, units]) => (
                    <tr key={pool}>
                      <td data-label={t("col.pool")} className="mono">
                        {pool}
                      </td>
                      <td data-label={t("col.lpUnits")}>{fmtInt(units)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section id="nfts" title={t("address.nftsOwned")}>
        {!pubkey ? (
          <EmptyState
            title={t("gate.unavailableTitle", { what: t("what.nfts") })}
          >
            {t("address.nftsNoKey")}
          </EmptyState>
        ) : (
          <>
            <SourceNote read={nfts} what={t("what.nfts")} />
            <ReadGate read={nfts} what={t("what.nfts")}>
              {(list) =>
                list.length ? (
                  <NftGrid tokens={list} showCollection />
                ) : (
                  <EmptyState title={t("address.noNfts")}>
                    {t("address.noNftsBody")}
                  </EmptyState>
                )
              }
            </ReadGate>
          </>
        )}
      </Section>
      <Section
        id="activity"
        title={t("what.activity")}
        meta={
          activity.data
            ? t("address.activityMeta", {
                count: activity.data.total,
                n: fmtInt(activity.data.total),
              })
            : undefined
        }
      >
        <SourceNote read={activity} what={t("what.activity")} />
        <ReadGate read={activity} what={t("what.activity")}>
          {(data) => (
            <>
              <TxTable
                txs={data.txs}
                empty={t("address.noTxs")}
              />
              <Pager
                page={page}
                totalPages={Math.max(
                  1,
                  Math.ceil(data.total / ACTIVITY_PER_PAGE),
                )}
                onChange={setPage}
                label={t("what.activity")}
              />
            </>
          )}
        </ReadGate>
      </Section>
    </ExplorerMain>
  );
}

// ─── Token ───────────────────────────────────────────────────────────────────

export function TokenDetailPage() {
  const { t } = useTranslation("explorer");
  const { symbol: param = "" } = useParams();
  const valid = TOKEN_SYMBOL.test(param);
  const meta = useRead(["token-meta", param], (c) => c.tokenMetadata(param), {
    enabled: valid,
  });
  const symbol = meta.data?.symbol ?? param;
  const holders = useRead(
    ["token-holders", symbol],
    (c) => c.tokenHolders(symbol),
    { enabled: !!meta.data, refetchMs: 120_000 },
  );
  const activity = useRead(
    ["token-txs", symbol],
    (c) => c.tokenTxs(symbol, 50),
    { enabled: !!meta.data, refetchMs: 120_000 },
  );
  const pools = useRead(["pools"], (c) => c.pools(), {
    enabled: !!meta.data,
    refetchMs: 120_000,
  });
  const decimals = meta.data?.decimals ?? 0;
  const known = useTokenDecimals();
  const tokenPools = (pools.data ?? []).filter(
    (p) => p.tokenA === symbol || p.tokenB === symbol,
  );
  if (!valid)
    return (
      <ExplorerMain>
        <NotFoundState
          title={t("token.invalid")}
          back={{ to: "/tokens", label: t("token.viewAll") }}
        >
          {t("token.invalidBody", { param })}
        </NotFoundState>
      </ExplorerMain>
    );
  const website = safeExternalUrl(meta.data?.website);
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("col.token")}
        title={
          <span className="token-title">
            <SafeImage
              className="token-mark large"
              src={meta.data?.image}
              alt=""
              fallback={symbol}
            />
            {meta.data?.name || symbol}
          </span>
        }
      >
        {meta.data?.description ?? undefined}
      </PageHeading>
      <SourceNote read={meta} what={t("col.token")} />
      <ReadGate
        read={meta}
        what={t("col.token")}
        notFound={
          <NotFoundState
            title={t("token.notFound")}
            back={{ to: "/tokens", label: t("token.viewAll") }}
          >
            {t("token.notFoundBody", { param })}
          </NotFoundState>
        }
      >
        {(tok) => (
          <>
            <DetailList
              rows={[
                [
                  t("token.symbol"),
                  <span key="s" className="mono">
                    {tok.symbol}
                  </span>,
                ],
                [
                  t("col.decimals"),
                  t("token.decimalsValue", {
                    decimals: tok.decimals,
                    symbol: tok.symbol,
                    units: fmtInt(10 ** tok.decimals),
                  }),
                ],
                [
                  t("col.creator"),
                  tok.creator ? (
                    <AddressLink key="c" identity={tok.creator} full />
                  ) : (
                    <span className="muted">{t("token.protocolAsset")}</span>
                  ),
                ],
                [
                  t("token.created"),
                  tok.createdAt ? (
                    <Timestamp key="t" ts={tok.createdAt} />
                  ) : (
                    <span className="muted">{t("genesis")}</span>
                  ),
                ],
                ...(website
                  ? ([
                      [
                        t("token.website"),
                        <a
                          key="w"
                          className="address-link"
                          href={website}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                        >
                          {website}
                        </a>,
                      ],
                    ] as [string, ReactNode][])
                  : []),
                [
                  t("col.status"),
                  `${tok.frozen ? t("token.frozen") : t("token.active")} · ${tok.mintable ? t("token.mintable") : t("token.fixedSupply")}`,
                ],
              ]}
            />
            <Section id="supply" title={t("what.supply")}>
              <SourceNote read={holders} what={t("what.holders")} />
              <ReadGate read={holders} what={t("what.supply")}>
                {(h) => (
                  <div className="metrics">
                    <Metric
                      label={
                        h.totalSupply
                          ? t("token.totalSupply")
                          : t("token.circulatingSupply")
                      }
                      value={formatUnits(
                        h.totalSupply || h.circulatingSupply,
                        decimals,
                      )}
                    />
                    <Metric
                      label={t("what.holders")}
                      value={fmtInt(h.holders.length)}
                    />
                    <Metric
                      label={t("token.shielded")}
                      value={formatUnits(h.shieldedSupply, decimals)}
                    />
                    <Metric
                      label={t("token.burned")}
                      value={formatUnits(h.burnedSupply, decimals)}
                    />
                  </div>
                )}
              </ReadGate>
            </Section>
            {holders.data && holders.data.holders.length > 0 && (
              <Section id="holders" title={t("what.holders")}>
                <div className="table-scroll">
                  <table className="stack-table">
                    <thead>
                      <tr>
                        <th>{t("token.holder")}</th>
                        <th>{t("col.balance")}</th>
                        <th>{t("token.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holders.data.holders.map((h) => {
                        const base =
                          holders.data!.totalSupply ||
                          holders.data!.circulatingSupply;
                        return (
                          <tr key={h.address}>
                            <td data-label={t("token.holder")}>
                              <AddressLink identity={h.address} />
                            </td>
                            <td data-label={t("col.balance")} className="amount">
                              {formatUnits(h.balance, decimals)} {tok.symbol}
                            </td>
                            <td data-label={t("token.share")}>
                              {base
                                ? fmtNum(h.balance / base, 2, {
                                    style: "percent",
                                    minimumFractionDigits: 2,
                                  })
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
            {tokenPools.length > 0 && (
              <Section id="pools" title={t("token.pools")}>
                <div className="table-scroll">
                  <table className="stack-table">
                    <thead>
                      <tr>
                        <th>{t("col.pool")}</th>
                        <th>{t("token.reserves")}</th>
                        <th>{t("token.price")}</th>
                        <th>{t("token.lpSupply")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokenPools.map((p) => {
                        const other =
                          p.tokenA === tok.symbol ? p.tokenB : p.tokenA;
                        const mine =
                          p.tokenA === tok.symbol ? p.reserveA : p.reserveB;
                        const theirs =
                          p.tokenA === tok.symbol ? p.reserveB : p.reserveA;
                        return (
                          <tr key={p.poolId}>
                            <td data-label={t("col.pool")} className="mono">
                              {p.poolId}
                            </td>
                            <td data-label={t("token.reserves")}>
                              {formatTokenAmount(p.reserveA, p.tokenA, known)}{" "}
                              {p.tokenA} ·{" "}
                              {formatTokenAmount(p.reserveB, p.tokenB, known)}{" "}
                              {p.tokenB}
                            </td>
                            <td data-label={t("token.price")}>
                              {mine > 0 ? (
                                <PoolPrice
                                  mine={mine}
                                  theirs={theirs}
                                  symbol={tok.symbol}
                                  decimals={decimals}
                                  other={other}
                                />
                              ) : (
                                "—"
                              )}
                            </td>
                            <td data-label={t("token.lpSupply")}>
                              {fmtInt(p.totalLpSupply)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
            <Section
              id="token-activity"
              title={t("token.recentActivity")}
              meta={
                activity.data
                  ? t("token.activityMeta", {
                      count: activity.data.total,
                      n: fmtInt(activity.data.total),
                      symbol: tok.symbol,
                    })
                  : undefined
              }
            >
              <SourceNote read={activity} what={t("what.activity")} />
              <ReadGate read={activity} what={t("what.activity")}>
                {(a) =>
                  a.transactions.length === 0 ? (
                    <EmptyState title={t("token.noActivity")}>
                      {t("token.noActivityBody")}
                    </EmptyState>
                  ) : (
                    <div className="table-scroll">
                      <table className="stack-table">
                        <thead>
                          <tr>
                            <th>{t("col.type")}</th>
                            <th>{t("col.fromTo")}</th>
                            <th>{t("col.amount")}</th>
                            <th>{t("col.block")}</th>
                            <th>{t("col.age")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.transactions.map((x, i) => (
                            <tr key={`${x.hashPrefix}-${i}`}>
                              <td data-label={t("col.type")}>
                                <TypePill type={x.type} />
                              </td>
                              <td data-label={t("col.fromTo")} className="from-to">
                                <AddressLink identity={x.from} />
                                {x.to && (
                                  <>
                                    <span className="muted"> → </span>
                                    <AddressLink identity={x.to} />
                                  </>
                                )}
                              </td>
                              <td data-label={t("col.amount")} className="amount">
                                {formatUnits(x.amount, decimals)} {tok.symbol}
                              </td>
                              <td data-label={t("col.block")}>
                                <BlockLink height={x.blockHeight} />
                              </td>
                              <td data-label={t("col.age")}>
                                <Age ts={x.timestamp} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </ReadGate>
            </Section>
          </>
        )}
      </ReadGate>
    </ExplorerMain>
  );
}

function PoolPrice({
  mine,
  theirs,
  symbol,
  decimals,
  other,
}: {
  mine: number;
  theirs: number;
  symbol: string;
  decimals: number;
  other: string;
}) {
  const known = useTokenDecimals();
  const otherDecimals = known.get(other) ?? known.get(other.toUpperCase()) ?? 0;
  // Reserves are raw units; convert both sides before dividing.
  const price = theirs / 10 ** otherDecimals / (mine / 10 ** decimals);
  return (
    <span className="amount">
      1 {symbol} ≈{" "}
      {price >= 1
        ? fmtNum(price, 4)
        : price.toPrecision(4)}{" "}
      {other}
    </span>
  );
}

// ─── NFTs ────────────────────────────────────────────────────────────────────

function NftGrid({
  tokens,
  showCollection = false,
}: {
  tokens: NftToken[];
  showCollection?: boolean;
}) {
  const { t } = useTranslation("explorer");
  return (
    <div className="asset-grid">
      {tokens.map((nft) => {
        const metadata = safeExternalUrl(nft.metadataUri);
        return (
          <article
            key={`${nft.collectionId}-${nft.tokenId}`}
            className="asset-card"
          >
            <SafeImage
              className="asset-media"
              src={nft.image}
              alt={nft.name ? t("nft.imageAlt", { name: nft.name }) : ""}
              fallback={nft.name || "NFT"}
            />
            <div className="asset-body">
              <strong>
                #{nft.tokenId} {nft.name}
              </strong>
              {showCollection && (
                <Link
                  className="mono address-link"
                  to={`/nfts/${encodeURIComponent(nft.collectionId)}`}
                >
                  {nft.collectionId}
                </Link>
              )}
              <span className="asset-meta">
                {t("nft.owner")} <AddressLink identity={nft.owner} />
              </span>
              {nft.locked && <span className="pill">{t("nft.locked")}</span>}
              {metadata && (
                <a
                  className="asset-meta address-link"
                  href={metadata}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {t("nft.metadata")}
                </a>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function NftCollectionPage() {
  const { t } = useTranslation("explorer");
  const { collectionId: param = "" } = useParams();
  const valid = COLLECTION_ID.test(param);
  const [page, setPage] = usePageParam();
  const offset = (page - 1) * NFTS_PER_PAGE;
  const collection = useRead(
    ["nft-collection", param],
    (c) => c.collection(param),
    { enabled: valid },
  );
  const tokens = useRead(
    ["nft-tokens", param, offset],
    (c) => c.collectionTokens(param, NFTS_PER_PAGE, offset),
    {
      enabled: valid && !!collection.data,
      keepPrevious: true,
    },
  );
  if (!valid)
    return (
      <ExplorerMain>
        <NotFoundState
          title={t("collection.invalid")}
          back={{ to: "/nfts", label: t("collection.viewAll") }}
        >
          {t("collection.invalidBody")}
        </NotFoundState>
      </ExplorerMain>
    );
  const c = collection.data;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("collection.eyebrow")}
        title={c?.name || c?.symbol || t("what.collection")}
      >
        {c?.description ?? undefined}
      </PageHeading>
      <SourceNote read={collection} what={t("what.collection")} />
      <ReadGate
        read={collection}
        what={t("what.collection")}
        notFound={
          <NotFoundState
            title={t("collection.notFound")}
            back={{ to: "/nfts", label: t("collection.viewAll") }}
          >
            {t("collection.notFoundBody")}
          </NotFoundState>
        }
      >
        {(col) => (
          <>
            <div className="collection-hero">
              <SafeImage
                className="asset-media"
                src={col.image}
                alt={t("collection.coverAlt", { name: col.name })}
                fallback={col.symbol}
              />
              <DetailList
                rows={[
                  [
                    t("collection.id"),
                    <CopyHash
                      key="id"
                      hash={col.id}
                      label={t("copy.collectionId")}
                      display={<code className="mono break">{col.id}</code>}
                    />,
                  ],
                  [t("token.symbol"), col.symbol],
                  [
                    t("collection.minted"),
                    col.maxSupply !== null
                      ? t("collection.mintedOf", {
                          minted: fmtInt(col.minted),
                          max: fmtInt(col.maxSupply),
                        })
                      : fmtInt(col.minted),
                  ],
                  [
                    t("col.creator"),
                    <AddressLink key="c" identity={col.creator} full />,
                  ],
                  [
                    t("collection.royalty"),
                    fmtNum(col.royaltyBps / 10000, 2, { style: "percent" }),
                  ],
                  [
                    t("collection.minting"),
                    col.frozen
                      ? t("token.frozen")
                      : col.publicMint
                        ? `${t("collection.public")}${col.mintPrice !== null ? ` · ${formatXrge(col.mintPrice)} XRGE` : ""}`
                        : t("collection.creatorOnly"),
                  ],
                  [t("token.created"), <Timestamp key="t" ts={col.createdAt} />],
                ]}
              />
            </div>
            <Section
              id="collection-tokens"
              title={t("what.tokens")}
              meta={
                tokens.data
                  ? t("collection.tokensMeta", {
                      n: fmtInt(tokens.data.total),
                    })
                  : undefined
              }
            >
              <SourceNote read={tokens} what={t("what.tokens")} />
              <ReadGate read={tokens} what={t("what.tokens")}>
                {(data) => (
                  <>
                    {data.tokens.length ? (
                      <NftGrid tokens={data.tokens} />
                    ) : (
                      <EmptyState title={t("collection.empty")}>
                        {t("collection.emptyBody")}
                      </EmptyState>
                    )}
                    <Pager
                      page={page}
                      totalPages={Math.max(
                        1,
                        Math.ceil(data.total / NFTS_PER_PAGE),
                      )}
                      onChange={setPage}
                      label={t("what.tokens")}
                    />
                  </>
                )}
              </ReadGate>
            </Section>
          </>
        )}
      </ReadGate>
    </ExplorerMain>
  );
}

// ─── Contracts ───────────────────────────────────────────────────────────────

export function ContractDetailPage() {
  const { addr: param = "" } = useParams();
  const addr = param.toLowerCase();
  const valid = CONTRACT_ADDR.test(addr);
  const [params, setParams] = useSearchParams();
  const beforeRaw = params.get("before");
  const before =
    beforeRaw && /^[1-9]\d{0,15}$/.test(beforeRaw)
      ? Number(beforeRaw)
      : undefined;
  const contract = useRead(["contract", addr], (c) => c.contract(addr), {
    enabled: valid,
  });
  const storage = useRead(
    ["contract-state", addr],
    (c) => c.contractState(addr),
    { enabled: !!contract.data, refetchMs: 60_000 },
  );
  const events = useRead(
    ["contract-events", addr, before],
    (c) => c.contractEvents(addr, EVENTS_PER_PAGE, before),
    {
      enabled: !!contract.data,
      refetchMs: before ? undefined : 60_000,
      keepPrevious: true,
    },
  );
  const { t } = useTranslation("explorer");
  const network = useNetworkLabel();
  if (!valid)
    return (
      <ExplorerMain>
        <NotFoundState
          title={t("contract.invalid")}
          back={{ to: "/contracts", label: t("contract.viewAll") }}
        >
          {t("contract.invalidBody")}
        </NotFoundState>
      </ExplorerMain>
    );
  const last = events.data?.[events.data.length - 1];
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={`${t("col.contract")} · ${network}`}
        title={<span className="address-title">{shorten(addr, 10, 6)}</span>}
      >
        {t("contract.intro")}
      </PageHeading>
      <SourceNote read={contract} what={t("col.contract")} />
      <ReadGate
        read={contract}
        what={t("col.contract")}
        notFound={
          <NotFoundState
            title={t("contract.notFound")}
            back={{ to: "/contracts", label: t("contract.viewAll") }}
          >
            {t("contract.notFoundBody", { network })}
          </NotFoundState>
        }
      >
        {(c) => (
          <>
            <DetailList
              rows={[
                [
                  t("address.eyebrow"),
                  <CopyHash
                    key="a"
                    hash={c.address}
                    label={t("copy.address")}
                    display={<code className="mono break">{c.address}</code>}
                  />,
                ],
                [
                  t("col.codeHash"),
                  <code key="h" className="mono break">
                    {c.codeHash}
                  </code>,
                ],
                [t("col.wasmSize"), t("bytes", { n: fmtInt(c.wasmSize) })],
                [
                  t("col.deployer"),
                  <AddressLink key="d" identity={c.deployer} full />,
                ],
                [
                  t("contract.deployedIn"),
                  <BlockLink key="b" height={c.createdAt} />,
                ],
                [
                  t("contract.verification"),
                  <span key="v" className="muted">
                    {t("contract.verificationBody")}
                  </span>,
                ],
              ]}
            />
            <Section
              id="storage"
              title={t("what.storage")}
              meta={
                storage.data
                  ? t("contract.storageMeta", {
                      count: storage.data.count,
                      n: fmtInt(storage.data.count),
                    })
                  : undefined
              }
            >
              <SourceNote read={storage} what={t("what.storage")} />
              <ReadGate read={storage} what={t("what.storage")}>
                {(s) =>
                  s.entries.length === 0 ? (
                    <EmptyState title={t("contract.noStorage")}>
                      {t("contract.noStorageBody")}
                    </EmptyState>
                  ) : (
                    <div className="table-scroll">
                      <table className="stack-table">
                        <thead>
                          <tr>
                            <th>{t("contract.key")}</th>
                            <th>{t("contract.value")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.entries.map(([k, v]) => (
                            <tr key={k}>
                              <td data-label={t("contract.key")} className="mono break">
                                {k}
                              </td>
                              <td data-label={t("contract.value")} className="mono break">
                                {v}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </ReadGate>
            </Section>
            <Section
              id="events"
              title={t("what.events")}
              meta={
                before
                  ? t("contract.eventsBefore", { height: fmtInt(before) })
                  : t("contract.newestFirst")
              }
            >
              <SourceNote read={events} what={t("what.events")} />
              <ReadGate read={events} what={t("what.events")}>
                {(list) =>
                  list.length === 0 ? (
                    <EmptyState title={t("contract.noEvents")}>
                      {before
                        ? t("contract.noOlderEvents")
                        : t("contract.noEventsBody")}
                    </EmptyState>
                  ) : (
                    <div className="table-scroll">
                      <table className="stack-table">
                        <thead>
                          <tr>
                            <th>{t("col.block")}</th>
                            <th>{t("contract.topic")}</th>
                            <th>{t("contract.data")}</th>
                            <th>{t("col.transaction")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((e, i) => (
                            <tr key={`${e.txHash}-${i}`}>
                              <td data-label={t("col.block")}>
                                <BlockLink height={e.blockHeight} />
                              </td>
                              <td data-label={t("contract.topic")}>
                                <span className="pill">{e.topic || "—"}</span>
                              </td>
                              <td data-label={t("contract.data")} className="mono break">
                                {e.data}
                              </td>
                              <td data-label={t("col.transaction")}>
                                {e.txHash ? (
                                  <Link
                                    className="mono address-link"
                                    to={`/tx/${e.txHash}`}
                                  >
                                    {shorten(e.txHash, 10, 6)}
                                  </Link>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </ReadGate>
              <nav className="pager" aria-label={t("contract.eventPages")}>
                {before && (
                  <button
                    className="button outline small"
                    onClick={() => setParams({})}
                  >
                    {t("contract.newestEvents")}
                  </button>
                )}
                {last && events.data!.length >= EVENTS_PER_PAGE && (
                  <button
                    className="button outline small"
                    onClick={() =>
                      setParams({ before: String(last.blockHeight) })
                    }
                  >
                    {t("contract.olderEvents")}
                  </button>
                )}
              </nav>
            </Section>
          </>
        )}
      </ReadGate>
    </ExplorerMain>
  );
}
