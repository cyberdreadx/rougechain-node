import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "@rougechain/ui";
import { shorten } from "@rougechain/chain-readonly";
import { useChain } from "./chain";
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
  Section,
  SourceNote,
  usePageParam,
} from "./ui";

const BLOCKS_PER_PAGE = 20;
const TXS_PER_PAGE = 25;

export function BlocksPage() {
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
      <PageHeading eyebrow="Explorer" title="Blocks">
        Every block, newest first.
      </PageHeading>
      <ExplorerSearch />
      <Section
        id="blocks"
        title="Blocks"
        meta={
          blocks.data
            ? `Chain height ${blocks.data.totalHeight.toLocaleString()}.`
            : undefined
        }
      >
        <SourceNote read={blocks} what="Blocks" />
        <ReadGate read={blocks} what="Blocks">
          {(data) => (
            <>
              <BlockTable blocks={data.blocks} />
              <Pager
                page={data.page}
                totalPages={data.totalPages}
                onChange={setPage}
                label="Blocks"
              />
            </>
          )}
        </ReadGate>
      </Section>
    </ExplorerMain>
  );
}

export function TransactionsPage() {
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
      <PageHeading eyebrow="Explorer" title="Transactions">
        Transfers, swaps, contract calls and every other transaction, newest
        first.
      </PageHeading>
      <ExplorerSearch />
      <Section
        id="transactions"
        title="Transactions"
        meta={
          txs.data
            ? `${txs.data.total.toLocaleString()} transactions in the node's recent-block index (latest 500 blocks).`
            : undefined
        }
      >
        <SourceNote read={txs} what="Transactions" />
        <ReadGate read={txs} what="Transactions">
          {(data) => (
            <>
              <TxTable
                txs={data.txs}
                empty={
                  page > 1 ? "No transactions on this page" : "No transactions"
                }
              />
              <Pager
                page={page}
                totalPages={totalPages}
                onChange={setPage}
                label="Transactions"
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
  const tokens = useRead(["tokens"], (c) => c.tokens(), { refetchMs: 300_000 });
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tokens.data ?? []).filter(
      (t) =>
        !q ||
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q),
    );
  }, [tokens.data, query]);
  return (
    <ExplorerMain>
      <PageHeading eyebrow="Explorer" title="Tokens">
        The native token, bridged assets and every token created on RougeChain.
      </PageHeading>
      <Section
        id="tokens"
        title="Token directory"
        meta={
          tokens.data
            ? `${tokens.data.length} tokens reported by the node.`
            : undefined
        }
        aside={
          <FilterInput
            id="token-filter"
            label="Filter tokens"
            value={query}
            onChange={setQuery}
          />
        }
      >
        <SourceNote read={tokens} what="Tokens" />
        <ReadGate read={tokens} what="Tokens">
          {() =>
            filtered.length === 0 ? (
              <EmptyState title="No matching tokens">
                Try a different symbol or name.
              </EmptyState>
            ) : (
              <div className="table-scroll">
                <table className="stack-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Decimals</th>
                      <th>Creator</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => (
                      <tr key={t.symbol}>
                        <td data-label="Token">
                          <Link
                            className="token-cell"
                            to={`/token/${encodeURIComponent(t.symbol)}`}
                          >
                            <SafeImage
                              className="token-mark"
                              src={t.image}
                              alt=""
                              fallback={t.symbol}
                            />
                            <span>
                              <strong>{t.symbol}</strong>
                              <small className="muted">{t.name}</small>
                            </span>
                          </Link>
                        </td>
                        <td data-label="Decimals">{t.decimals}</td>
                        <td data-label="Creator">
                          {t.creator ? (
                            <AddressLink identity={t.creator} />
                          ) : (
                            <span className="muted">Protocol</span>
                          )}
                        </td>
                        <td
                          data-label="Description"
                          className="description-cell"
                        >
                          {t.description ? (
                            t.description.length > 90 ? (
                              `${t.description.slice(0, 89)}…`
                            ) : (
                              t.description
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
      <PageHeading eyebrow="Explorer" title="NFTs">
        Collections minted on RougeChain. Only images are displayed; other media
        is never loaded.
      </PageHeading>
      <Section
        id="collections"
        title="Collections"
        meta={
          collections.data
            ? `${collections.data.length} collections.`
            : undefined
        }
        aside={
          <FilterInput
            id="nft-filter"
            label="Filter collections"
            value={query}
            onChange={setQuery}
          />
        }
      >
        <SourceNote read={collections} what="Collections" />
        <ReadGate read={collections} what="Collections">
          {() =>
            filtered.length === 0 ? (
              <EmptyState
                title={query ? "No matching collections" : "No collections yet"}
              >
                {query
                  ? "Try a different name or symbol."
                  : "No NFT collection has been created on this network."}
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
                        {c.minted.toLocaleString()} minted
                        {c.maxSupply !== null
                          ? ` of ${c.maxSupply.toLocaleString()}`
                          : ""}
                        {c.frozen ? " · frozen" : ""}
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
  const { config } = useChain();
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
      <PageHeading eyebrow="Explorer" title="Contracts">
        WASM contracts deployed on RougeChain {config.label.toLowerCase()}.
        Read-only: nothing here calls or executes a contract.
      </PageHeading>
      <Section
        id="contracts"
        title="Deployed contracts"
        meta={
          contracts.data ? `${contracts.data.length} contracts.` : undefined
        }
        aside={
          <FilterInput
            id="contract-filter"
            label="Filter by address or code hash"
            value={query}
            onChange={setQuery}
          />
        }
      >
        <SourceNote read={contracts} what="Contracts" />
        <ReadGate read={contracts} what="Contracts">
          {() =>
            filtered.length === 0 ? (
              <EmptyState
                title={
                  query ? "No matching contracts" : "No contracts deployed"
                }
              >
                {query
                  ? "Try a different address."
                  : "No contract has been deployed on this network."}
              </EmptyState>
            ) : (
              <div className="table-scroll">
                <table className="stack-table">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Code hash</th>
                      <th>Deployer</th>
                      <th>Deployed</th>
                      <th>WASM size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.address}>
                        <td data-label="Contract">
                          <Link
                            className="mono address-link"
                            to={`/contract/${c.address}`}
                            title={c.address}
                          >
                            {shorten(c.address, 10, 6)}
                          </Link>
                        </td>
                        <td data-label="Code hash">
                          <span className="mono" title={c.codeHash}>
                            {shorten(c.codeHash, 10, 6)}
                          </span>
                        </td>
                        <td data-label="Deployer">
                          <AddressLink identity={c.deployer} />
                        </td>
                        <td data-label="Deployed">
                          <BlockLink height={c.createdAt} />
                        </td>
                        <td data-label="WASM size">
                          {c.wasmSize.toLocaleString()} bytes
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
