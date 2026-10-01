import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@rougechain/ui";
import { shorten } from "@rougechain/chain-readonly";
import { useRead } from "./read";
import { BlockTable, TxTable } from "./tables";
import {
  AddressLink,
  BlockLink,
  ExplorerMain,
  ExplorerSearch,
  PageHeading,
  Pager,
  ReadGate,
  SafeImage,
  TokenLogo,
  Section,
  SourceNote,
  usePageParam,
  useNetworkLabel,
} from "./ui";
import { fmtInt } from "../i18n/format";

const BLOCKS_PER_PAGE = 20;
const TXS_PER_PAGE = 25;

export function BlocksPage() {
  const { t } = useTranslation("explorer");
  const [page, setPage] = usePageParam();
  const blocks = useRead(
    ["blocks", page, BLOCKS_PER_PAGE],
    (c) => c.blocksPage(page, BLOCKS_PER_PAGE),
    {
      refetchMs: page === 1 ? 30_000 : undefined,
      keepPrevious: true,
    },
  );
  return (
    <ExplorerMain>
      <PageHeading eyebrow={t("eyebrow.explorer")} title={t("lists.blocks.title")}>
        {t("lists.blocks.intro")}
      </PageHeading>
      <ExplorerSearch />
      <Section
        id="blocks"
        title={t("lists.blocks.title")}
        meta={
          blocks.data
            ? t("lists.blocks.meta", {
                height: fmtInt(blocks.data.totalHeight),
              })
            : undefined
        }
      >
        <SourceNote read={blocks} what={t("what.blocks")} />
        <ReadGate read={blocks} what={t("what.blocks")}>
          {(data) => (
            <>
              <BlockTable blocks={data.blocks} />
              <Pager
                page={data.page}
                totalPages={data.totalPages}
                onChange={setPage}
                label={t("what.blocks")}
              />
            </>
          )}
        </ReadGate>
      </Section>
    </ExplorerMain>
  );
}

export function TransactionsPage() {
  const { t } = useTranslation("explorer");
  const [page, setPage] = usePageParam();
  const offset = (page - 1) * TXS_PER_PAGE;
  const txs = useRead(
    ["txs", TXS_PER_PAGE, offset],
    (c) => c.txs(TXS_PER_PAGE, offset),
    {
      refetchMs: page === 1 ? 30_000 : undefined,
      keepPrevious: true,
    },
  );
  const totalPages = txs.data
    ? Math.max(1, Math.ceil(txs.data.total / TXS_PER_PAGE))
    : 1;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("eyebrow.explorer")}
        title={t("lists.txs.title")}
      >
        {t("lists.txs.intro")}
      </PageHeading>
      <ExplorerSearch />
      <Section
        id="transactions"
        title={t("lists.txs.title")}
        meta={
          txs.data
            ? t("lists.txs.meta", {
                count: txs.data.total,
                n: fmtInt(txs.data.total),
              })
            : undefined
        }
      >
        <SourceNote read={txs} what={t("what.transactions")} />
        <ReadGate read={txs} what={t("what.transactions")}>
          {(data) => (
            <>
              <TxTable
                txs={data.txs}
                empty={
                  page > 1 ? t("lists.txs.emptyPage") : t("tables.noTxs")
                }
              />
              <Pager
                page={page}
                totalPages={totalPages}
                onChange={setPage}
                label={t("what.transactions")}
              />
            </>
          )}
        </ReadGate>
      </Section>
    </ExplorerMain>
  );
}

function FilterInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="list-filter">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function TokensPage() {
  const { t } = useTranslation("explorer");
  const tokens = useRead(["tokens"], (c) => c.tokens(), { refetchMs: 300_000 });
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tokens.data ?? []).filter(
      (tok) =>
        !q ||
        tok.symbol.toLowerCase().includes(q) ||
        tok.name.toLowerCase().includes(q) ||
        (tok.description ?? "").toLowerCase().includes(q),
    );
  }, [tokens.data, query]);
  return (
    <ExplorerMain>
      <PageHeading eyebrow={t("eyebrow.explorer")} title={t("lists.tokens.title")}>
        {t("lists.tokens.intro")}
      </PageHeading>
      <Section
        id="tokens"
        title={t("lists.tokens.directory")}
        meta={
          tokens.data
            ? t("lists.tokens.meta", {
                count: tokens.data.length,
                n: fmtInt(tokens.data.length),
              })
            : undefined
        }
        aside={
          <FilterInput
            id="token-filter"
            label={t("lists.tokens.filter")}
            value={query}
            onChange={setQuery}
          />
        }
      >
        <SourceNote read={tokens} what={t("what.tokens")} />
        <ReadGate read={tokens} what={t("what.tokens")}>
          {() =>
            filtered.length === 0 ? (
              <EmptyState title={t("lists.tokens.noMatch")}>
                {t("lists.tokens.noMatchBody")}
              </EmptyState>
            ) : (
              <div className="table-scroll">
                <table className="stack-table">
                  <thead>
                    <tr>
                      <th>{t("col.token")}</th>
                      <th>{t("col.decimals")}</th>
                      <th>{t("col.creator")}</th>
                      <th>{t("col.description")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((tok) => (
                      <tr key={tok.symbol}>
                        <td data-label={t("col.token")}>
                          <Link
                            className="token-cell"
                            to={`/token/${encodeURIComponent(tok.symbol)}`}
                          >
                            <TokenLogo
                              className="token-mark"
                              symbol={tok.symbol}
                              image={tok.image}
                            />
                            <span>
                              <strong>{tok.symbol}</strong>
                              <small className="muted">{tok.name}</small>
                            </span>
                          </Link>
                        </td>
                        <td data-label={t("col.decimals")}>{tok.decimals}</td>
                        <td data-label={t("col.creator")}>
                          {tok.creator ? (
                            <AddressLink identity={tok.creator} />
                          ) : (
                            <span className="muted">{t("lists.tokens.protocol")}</span>
                          )}
                        </td>
                        <td
                          data-label={t("col.description")}
                          className="description-cell"
                        >
                          {tok.description ? (
                            tok.description.length > 90 ? (
                              `${tok.description.slice(0, 89)}…`
                            ) : (
                              tok.description
                            )
                          ) : (
                            <span className="muted">—</span>
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
      </Section>
    </ExplorerMain>
  );
}

export function NftsPage() {
  const { t } = useTranslation("explorer");
  const collections = useRead(["nft-collections"], (c) => c.collections(), {
    refetchMs: 120_000,
  });
  const [query, setQuery] = useState("");
  const filtered = (collections.data ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    return (
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.symbol.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
    );
  });
  return (
    <ExplorerMain>
      <PageHeading eyebrow={t("eyebrow.explorer")} title={t("lists.nfts.title")}>
        {t("lists.nfts.intro")}
      </PageHeading>
      <Section
        id="collections"
        title={t("lists.nfts.collections")}
        meta={
          collections.data
            ? t("lists.nfts.meta", {
                count: collections.data.length,
                n: fmtInt(collections.data.length),
              })
            : undefined
        }
        aside={
          <FilterInput
            id="nft-filter"
            label={t("lists.nfts.filter")}
            value={query}
            onChange={setQuery}
          />
        }
      >
        <SourceNote read={collections} what={t("what.collections")} />
        <ReadGate read={collections} what={t("what.collections")}>
          {() =>
            filtered.length === 0 ? (
              <EmptyState
                title={
                  query ? t("lists.nfts.noMatch") : t("lists.nfts.none")
                }
              >
                {query
                  ? t("lists.nfts.noMatchBody")
                  : t("lists.nfts.noneBody")}
              </EmptyState>
            ) : (
              <div className="asset-grid">
                {filtered.map((c) => (
                  <Link
                    key={c.id}
                    className="asset-card"
                    to={`/nfts/${encodeURIComponent(c.id)}`}
                  >
                    <SafeImage
                      className="asset-media"
                      src={c.image}
                      alt=""
                      fallback={c.symbol}
                    />
                    <div className="asset-body">
                      <strong>{c.name || c.symbol}</strong>
                      <span className="mono muted">{c.symbol}</span>
                      <span className="asset-meta">
                        {c.maxSupply !== null
                          ? t("lists.nfts.mintedOf", {
                              minted: fmtInt(c.minted),
                              max: fmtInt(c.maxSupply),
                            })
                          : t("lists.nfts.minted", { minted: fmtInt(c.minted) })}
                        {c.frozen ? ` · ${t("lists.nfts.frozen")}` : ""}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )
          }
        </ReadGate>
      </Section>
    </ExplorerMain>
  );
}

export function ContractsPage() {
  const contracts = useRead(["contracts"], (c) => c.contracts(), {
    refetchMs: 120_000,
  });
  const { t } = useTranslation("explorer");
  const network = useNetworkLabel();
  const [query, setQuery] = useState("");
  const filtered = (contracts.data ?? [])
    .filter((c) => {
      const q = query.trim().toLowerCase();
      return (
        !q ||
        c.address.includes(q) ||
        c.codeHash.includes(q) ||
        c.deployer.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("eyebrow.explorer")}
        title={t("lists.contracts.title")}
      >
        {t("lists.contracts.intro", { network: network.toLowerCase() })}
      </PageHeading>
      <Section
        id="contracts"
        title={t("lists.contracts.deployed")}
        meta={
          contracts.data
            ? t("lists.contracts.meta", {
                count: contracts.data.length,
                n: fmtInt(contracts.data.length),
              })
            : undefined
        }
        aside={
          <FilterInput
            id="contract-filter"
            label={t("lists.contracts.filter")}
            value={query}
            onChange={setQuery}
          />
        }
      >
        <SourceNote read={contracts} what={t("what.contracts")} />
        <ReadGate read={contracts} what={t("what.contracts")}>
          {() =>
            filtered.length === 0 ? (
              <EmptyState
                title={
                  query ? t("lists.contracts.noMatch") : t("lists.contracts.none")
                }
              >
                {query
                  ? t("lists.contracts.noMatchBody")
                  : t("lists.contracts.noneBody")}
              </EmptyState>
            ) : (
              <div className="table-scroll">
                <table className="stack-table">
                  <thead>
                    <tr>
                      <th>{t("col.contract")}</th>
                      <th>{t("col.codeHash")}</th>
                      <th>{t("col.deployer")}</th>
                      <th>{t("col.deployed")}</th>
                      <th>{t("col.wasmSize")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.address}>
                        <td data-label={t("col.contract")}>
                          <Link
                            className="mono address-link"
                            to={`/contract/${c.address}`}
                            title={c.address}
                          >
                            {shorten(c.address, 10, 6)}
                          </Link>
                        </td>
                        <td data-label={t("col.codeHash")}>
                          <span className="mono" title={c.codeHash}>
                            {shorten(c.codeHash, 10, 6)}
                          </span>
                        </td>
                        <td data-label={t("col.deployer")}>
                          <AddressLink identity={c.deployer} />
                        </td>
                        <td data-label={t("col.deployed")}>
                          <BlockLink height={c.createdAt} />
                        </td>
                        <td data-label={t("col.wasmSize")}>
                          {t("bytes", { n: fmtInt(c.wasmSize) })}
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
    </ExplorerMain>
  );
}
