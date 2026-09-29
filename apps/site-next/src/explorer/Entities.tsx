import type { ReactNode } from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
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
import { useChain } from "./chain";
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
} from "./ui";

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
          title="Not a RougeChain address"
          back={{ to: "/explorer", label: "Back to Explorer" }}
        >
          Addresses start with rouge1, or are ML-DSA public keys in hexadecimal.
        </NotFoundState>
      </ExplorerMain>
    );
  const b = balance.data;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow="Address"
        title={<span className="address-title">{shorten(address, 14, 8)}</span>}
      />
      <DetailList
        rows={[
          [
            "Address",
            <CopyHash
              key="a"
              hash={address}
              label="address"
              display={<code className="mono break">{address}</code>}
            />,
          ],
          [
            "Public key",
            pubkey ? (
              <details key="pk" className="pubkey">
                <summary className="mono">
                  {shorten(pubkey, 16, 8)} ·{" "}
                  {(pubkey.length / 2).toLocaleString()} bytes
                </summary>
                <CopyHash
                  hash={pubkey}
                  label="public key"
                  display={<code className="mono break">{pubkey}</code>}
                />
              </details>
            ) : resolved.state === "loading" ? (
              <span className="muted">Resolving…</span>
            ) : (
              <span className="muted">
                Not yet revealed on-chain (the address has not sent a
                transaction).
              </span>
            ),
          ],
        ]}
      />
      <Section id="balances" title="Balances">
        <SourceNote read={balance} what="Balances" />
        <ReadGate read={balance} what="Balances">
          {() => (
            <div className="metrics">
              <Metric label="XRGE balance" value={formatXrge(b!.xrge)} />
              <Metric
                label="Tokens held"
                value={b!.tokens.filter(([, v]) => v > 0).length}
              />
              <Metric
                label="LP positions"
                value={b!.lp.filter(([, v]) => v > 0).length}
              />
              <Metric
                label="Transactions"
                value={activity.data?.total.toLocaleString() ?? "—"}
              />
            </div>
          )}
        </ReadGate>
        {b && b.tokens.some(([, v]) => v > 0) && (
          <div className="table-scroll sub-table">
            <table className="stack-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {b.tokens
                  .filter(([, v]) => v > 0)
                  .map(([symbol, raw]) => (
                    <tr key={symbol}>
                      <td data-label="Token">
                        <Link
                          className="address-link"
                          to={`/token/${encodeURIComponent(symbol)}`}
                        >
                          {symbol}
                        </Link>
                      </td>
                      <td data-label="Balance" className="amount">
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
                  <th>Liquidity pool</th>
                  <th>LP units</th>
                </tr>
              </thead>
              <tbody>
                {b.lp
                  .filter(([, v]) => v > 0)
                  .map(([pool, units]) => (
                    <tr key={pool}>
                      <td data-label="Pool" className="mono">
                        {pool}
                      </td>
                      <td data-label="LP units">{units.toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section id="nfts" title="NFTs owned">
        {!pubkey ? (
          <EmptyState title="NFTs unavailable">
            The node indexes NFT owners by public key, and this address's key is
            not known yet.
          </EmptyState>
        ) : (
          <>
            <SourceNote read={nfts} what="NFTs" />
            <ReadGate read={nfts} what="NFTs">
              {(list) =>
                list.length ? (
                  <NftGrid tokens={list} showCollection />
                ) : (
                  <EmptyState title="No NFTs">
                    This address owns no NFTs.
                  </EmptyState>
                )
              }
            </ReadGate>
          </>
        )}
      </Section>
      <Section
        id="activity"
        title="Activity"
        meta={
          activity.data
            ? `${activity.data.total.toLocaleString()} transactions in the node's recent-block index.`
            : undefined
        }
      >
        <SourceNote read={activity} what="Activity" />
        <ReadGate read={activity} what="Activity">
          {(data) => (
            <>
              <TxTable
                txs={data.txs}
                empty="No transactions for this address"
              />
              <Pager
                page={page}
                totalPages={Math.max(
                  1,
                  Math.ceil(data.total / ACTIVITY_PER_PAGE),
                )}
                onChange={setPage}
                label="Activity"
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
          title="Not a token symbol"
          back={{ to: "/tokens", label: "View all tokens" }}
        >
          “{param}” is not a valid token symbol.
        </NotFoundState>
      </ExplorerMain>
    );
  const website = safeExternalUrl(meta.data?.website);
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow="Token"
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
      <SourceNote read={meta} what="Token" />
      <ReadGate
        read={meta}
        what="Token"
        notFound={
          <NotFoundState
            title="Token not found"
            back={{ to: "/tokens", label: "View all tokens" }}
          >
            No token with the symbol “{param}” exists on this network.
          </NotFoundState>
        }
      >
        {(t) => (
          <>
            <DetailList
              rows={[
                [
                  "Symbol",
                  <span key="s" className="mono">
                    {t.symbol}
                  </span>,
                ],
                [
                  "Decimals",
                  `${t.decimals} (1 ${t.symbol} = ${(10 ** t.decimals).toLocaleString()} base units)`,
                ],
                [
                  "Creator",
                  t.creator ? (
                    <AddressLink key="c" identity={t.creator} full />
                  ) : (
                    <span className="muted">Protocol asset</span>
                  ),
                ],
                [
                  "Created",
                  t.createdAt ? (
                    <Timestamp key="t" ts={t.createdAt} />
                  ) : (
                    <span className="muted">Genesis</span>
                  ),
                ],
                ...(website
                  ? ([
                      [
                        "Website",
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
                  "Status",
                  `${t.frozen ? "Frozen" : "Active"} · ${t.mintable ? "mintable" : "fixed supply"}`,
                ],
              ]}
            />
            <Section id="supply" title="Supply">
              <SourceNote read={holders} what="Holders" />
              <ReadGate read={holders} what="Supply">
                {(h) => (
                  <div className="metrics">
                    <Metric
                      label={
                        h.totalSupply ? "Total supply" : "Circulating supply"
                      }
                      value={formatUnits(
                        h.totalSupply || h.circulatingSupply,
                        decimals,
                      )}
                    />
                    <Metric
                      label="Holders"
                      value={h.holders.length.toLocaleString()}
                    />
                    <Metric
                      label="Shielded"
                      value={formatUnits(h.shieldedSupply, decimals)}
                    />
                    <Metric
                      label="Burned"
                      value={formatUnits(h.burnedSupply, decimals)}
                    />
                  </div>
                )}
              </ReadGate>
            </Section>
            {holders.data && holders.data.holders.length > 0 && (
              <Section id="holders" title="Holders">
                <div className="table-scroll">
                  <table className="stack-table">
                    <thead>
                      <tr>
                        <th>Holder</th>
                        <th>Balance</th>
                        <th>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holders.data.holders.map((h) => {
                        const base =
                          holders.data!.totalSupply ||
                          holders.data!.circulatingSupply;
                        return (
                          <tr key={h.address}>
                            <td data-label="Holder">
                              <AddressLink identity={h.address} />
                            </td>
                            <td data-label="Balance" className="amount">
                              {formatUnits(h.balance, decimals)} {t.symbol}
                            </td>
                            <td data-label="Share">
                              {base
                                ? `${((h.balance / base) * 100).toFixed(2)}%`
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
              <Section id="pools" title="Liquidity pools">
                <div className="table-scroll">
                  <table className="stack-table">
                    <thead>
                      <tr>
                        <th>Pool</th>
                        <th>Reserves</th>
                        <th>Price</th>
                        <th>LP supply</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokenPools.map((p) => {
                        const other =
                          p.tokenA === t.symbol ? p.tokenB : p.tokenA;
                        const mine =
                          p.tokenA === t.symbol ? p.reserveA : p.reserveB;
                        const theirs =
                          p.tokenA === t.symbol ? p.reserveB : p.reserveA;
                        return (
                          <tr key={p.poolId}>
                            <td data-label="Pool" className="mono">
                              {p.poolId}
                            </td>
                            <td data-label="Reserves">
                              {formatTokenAmount(p.reserveA, p.tokenA, known)}{" "}
                              {p.tokenA} ·{" "}
                              {formatTokenAmount(p.reserveB, p.tokenB, known)}{" "}
                              {p.tokenB}
                            </td>
                            <td data-label="Price">
                              {mine > 0 ? (
                                <PoolPrice
                                  mine={mine}
                                  theirs={theirs}
                                  symbol={t.symbol}
                                  decimals={decimals}
                                  other={other}
                                />
                              ) : (
                                "—"
                              )}
                            </td>
                            <td data-label="LP supply">
                              {p.totalLpSupply.toLocaleString()}
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
              title="Recent activity"
              meta={
                activity.data
                  ? `${activity.data.total.toLocaleString()} transactions involve ${t.symbol}. Latest 50 shown.`
                  : undefined
              }
            >
              <SourceNote read={activity} what="Activity" />
              <ReadGate read={activity} what="Activity">
                {(a) =>
                  a.transactions.length === 0 ? (
                    <EmptyState title="No activity">
                      No transactions involve this token yet.
                    </EmptyState>
                  ) : (
                    <div className="table-scroll">
                      <table className="stack-table">
                        <thead>
                          <tr>
                            <th>Type</th>
                            <th>From → To</th>
                            <th>Amount</th>
                            <th>Block</th>
                            <th>Age</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.transactions.map((x, i) => (
                            <tr key={`${x.hashPrefix}-${i}`}>
                              <td data-label="Type">
                                <TypePill type={x.type} />
                              </td>
                              <td data-label="From → To" className="from-to">
                                <AddressLink identity={x.from} />
                                {x.to && (
                                  <>
                                    <span className="muted"> → </span>
                                    <AddressLink identity={x.to} />
                                  </>
                                )}
                              </td>
                              <td data-label="Amount" className="amount">
                                {formatUnits(x.amount, decimals)} {t.symbol}
                              </td>
                              <td data-label="Block">
                                <BlockLink height={x.blockHeight} />
                              </td>
                              <td data-label="Age">
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
        ? price.toLocaleString("en-US", { maximumFractionDigits: 4 })
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
  return (
    <div className="asset-grid">
      {tokens.map((t) => {
        const metadata = safeExternalUrl(t.metadataUri);
        return (
          <article
            key={`${t.collectionId}-${t.tokenId}`}
            className="asset-card"
          >
            <SafeImage
              className="asset-media"
              src={t.image}
              alt={t.name ? `${t.name} image` : ""}
              fallback={t.name || "NFT"}
            />
            <div className="asset-body">
              <strong>
                #{t.tokenId} {t.name}
              </strong>
              {showCollection && (
                <Link
                  className="mono address-link"
                  to={`/nfts/${encodeURIComponent(t.collectionId)}`}
                >
                  {t.collectionId}
                </Link>
              )}
              <span className="asset-meta">
                Owner <AddressLink identity={t.owner} />
              </span>
              {t.locked && <span className="pill">Locked</span>}
              {metadata && (
                <a
                  className="asset-meta address-link"
                  href={metadata}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  Metadata (external) ↗
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
          title="Not a collection id"
          back={{ to: "/nfts", label: "View all collections" }}
        >
          Collection ids look like col:0123456789abcdef:SYMBOL.
        </NotFoundState>
      </ExplorerMain>
    );
  const c = collection.data;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow="NFT collection"
        title={c?.name || c?.symbol || "Collection"}
      >
        {c?.description ?? undefined}
      </PageHeading>
      <SourceNote read={collection} what="Collection" />
      <ReadGate
        read={collection}
        what="Collection"
        notFound={
          <NotFoundState
            title="Collection not found"
            back={{ to: "/nfts", label: "View all collections" }}
          >
            No collection with this id exists on this network.
          </NotFoundState>
        }
      >
        {(col) => (
          <>
            <div className="collection-hero">
              <SafeImage
                className="asset-media"
                src={col.image}
                alt={`${col.name} cover`}
                fallback={col.symbol}
              />
              <DetailList
                rows={[
                  [
                    "Collection id",
                    <CopyHash
                      key="id"
                      hash={col.id}
                      label="collection id"
                      display={<code className="mono break">{col.id}</code>}
                    />,
                  ],
                  ["Symbol", col.symbol],
                  [
                    "Minted",
                    `${col.minted.toLocaleString()}${col.maxSupply !== null ? ` of ${col.maxSupply.toLocaleString()}` : ""}`,
                  ],
                  [
                    "Creator",
                    <AddressLink key="c" identity={col.creator} full />,
                  ],
                  ["Royalty", `${(col.royaltyBps / 100).toLocaleString()}%`],
                  [
                    "Minting",
                    col.frozen
                      ? "Frozen"
                      : col.publicMint
                        ? `Public${col.mintPrice !== null ? ` · ${formatXrge(col.mintPrice)} XRGE` : ""}`
                        : "Creator only",
                  ],
                  ["Created", <Timestamp key="t" ts={col.createdAt} />],
                ]}
              />
            </div>
            <Section
              id="collection-tokens"
              title="Tokens"
              meta={
                tokens.data
                  ? `${tokens.data.total.toLocaleString()} minted.`
                  : undefined
              }
            >
              <SourceNote read={tokens} what="Tokens" />
              <ReadGate read={tokens} what="Tokens">
                {(data) => (
                  <>
                    {data.tokens.length ? (
                      <NftGrid tokens={data.tokens} />
                    ) : (
                      <EmptyState title="Nothing minted yet">
                        This collection has no tokens.
                      </EmptyState>
                    )}
                    <Pager
                      page={page}
                      totalPages={Math.max(
                        1,
                        Math.ceil(data.total / NFTS_PER_PAGE),
                      )}
                      onChange={setPage}
                      label="Tokens"
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
  const { config } = useChain();
  if (!valid)
    return (
      <ExplorerMain>
        <NotFoundState
          title="Not a contract address"
          back={{ to: "/contracts", label: "View all contracts" }}
        >
          Contract addresses are 40 hexadecimal characters.
        </NotFoundState>
      </ExplorerMain>
    );
  const last = events.data?.[events.data.length - 1];
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={`Contract · ${config.label}`}
        title={<span className="address-title">{shorten(addr, 10, 6)}</span>}
      >
        Read-only view. Calls, queries and deployments are not available here.
      </PageHeading>
      <SourceNote read={contract} what="Contract" />
      <ReadGate
        read={contract}
        what="Contract"
        notFound={
          <NotFoundState
            title="Contract not found"
            back={{ to: "/contracts", label: "View all contracts" }}
          >
            No contract is deployed at this address on {config.label}.
          </NotFoundState>
        }
      >
        {(c) => (
          <>
            <DetailList
              rows={[
                [
                  "Address",
                  <CopyHash
                    key="a"
                    hash={c.address}
                    label="address"
                    display={<code className="mono break">{c.address}</code>}
                  />,
                ],
                [
                  "Code hash",
                  <code key="h" className="mono break">
                    {c.codeHash}
                  </code>,
                ],
                ["WASM size", `${c.wasmSize.toLocaleString()} bytes`],
                [
                  "Deployer",
                  <AddressLink key="d" identity={c.deployer} full />,
                ],
                ["Deployed in", <BlockLink key="b" height={c.createdAt} />],
                [
                  "Verification",
                  <span key="v" className="muted">
                    Source verification is not available; the code hash
                    identifies the deployed WASM.
                  </span>,
                ],
              ]}
            />
            <Section
              id="storage"
              title="Storage"
              meta={
                storage.data
                  ? `${storage.data.count.toLocaleString()} entries.`
                  : undefined
              }
            >
              <SourceNote read={storage} what="Storage" />
              <ReadGate read={storage} what="Storage">
                {(s) =>
                  s.entries.length === 0 ? (
                    <EmptyState title="No storage">
                      This contract has written no storage.
                    </EmptyState>
                  ) : (
                    <div className="table-scroll">
                      <table className="stack-table">
                        <thead>
                          <tr>
                            <th>Key</th>
                            <th>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.entries.map(([k, v]) => (
                            <tr key={k}>
                              <td data-label="Key" className="mono break">
                                {k}
                              </td>
                              <td data-label="Value" className="mono break">
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
              title="Events"
              meta={
                before
                  ? `Events before block #${before.toLocaleString()}.`
                  : "Newest first."
              }
            >
              <SourceNote read={events} what="Events" />
              <ReadGate read={events} what="Events">
                {(list) =>
                  list.length === 0 ? (
                    <EmptyState title="No events">
                      {before
                        ? "No older events."
                        : "This contract has emitted no events."}
                    </EmptyState>
                  ) : (
                    <div className="table-scroll">
                      <table className="stack-table">
                        <thead>
                          <tr>
                            <th>Block</th>
                            <th>Topic</th>
                            <th>Data</th>
                            <th>Transaction</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((e, i) => (
                            <tr key={`${e.txHash}-${i}`}>
                              <td data-label="Block">
                                <BlockLink height={e.blockHeight} />
                              </td>
                              <td data-label="Topic">
                                <span className="pill">{e.topic || "—"}</span>
                              </td>
                              <td data-label="Data" className="mono break">
                                {e.data}
                              </td>
                              <td data-label="Transaction">
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
              <nav className="pager" aria-label="Event pages">
                {before && (
                  <button
                    className="button outline small"
                    onClick={() => setParams({})}
                  >
                    Newest events
                  </button>
                )}
                {last && events.data!.length >= EVENTS_PER_PAGE && (
                  <button
                    className="button outline small"
                    onClick={() =>
                      setParams({ before: String(last.blockHeight) })
                    }
                  >
                    Older events
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
