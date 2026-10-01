import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Box } from "lucide-react";
import { EmptyState, Status } from "@rougechain/ui";
import {
  NetworkControls,
  NetworkMetrics,
  DataNote,
  useNetwork,
} from "../Network";
import { useRead } from "./read";
import { TxTable } from "./tables";
import {
  Age,
  ExplorerMain,
  ExplorerSearch,
  HashLink,
  PageHeading,
  ReadGate,
  Section,
  SourceNote,
  useNetworkLabel,
} from "./ui";
import { fmtInt } from "../i18n/format";

/** Explorer overview: live network figures, latest blocks, latest transactions and search. */
export default function Overview() {
  const { t } = useTranslation("explorer");
  const n = useNetwork();
  const network = useNetworkLabel();
  const txs = useRead(["txs", 8, 0], (c) => c.txs(8, 0), { refetchMs: 30_000 });
  const blocks = n.data?.blocks;
  return (
    <ExplorerMain>
      <PageHeading
        eyebrow={t("overview.eyebrow")}
        title={t("overview.title")}
      >
        {t("overview.intro", { network: network.toLowerCase() })}
      </PageHeading>
      <ExplorerSearch />
      <div className="app-toolbar">
        <span className="mono muted">
          ROUGECHAIN {network.toUpperCase()}
        </span>
        <NetworkControls />
      </div>
      <NetworkMetrics />
      <DataNote />
      <Section
        id="latest-blocks"
        title={t("overview.latestBlocks")}
        meta={
          n.state === "demo"
            ? t("overview.snapshotNote")
            : t("overview.latestBlocksMeta", {
                n: blocks ? fmtInt(blocks.length) : "—",
              })
        }
        aside={
          <Status state={n.state}>
            {n.state === "demo"
              ? t("overview.snapshot")
              : n.state === "live"
                ? t("state.live")
                : t(`state.${n.state}`)}
          </Status>
        }
      >
        {!blocks ? (
          <EmptyState
            title={
              n.state === "unavailable"
                ? t("overview.blocksUnavailable")
                : t("overview.loadingNetwork")
            }
          >
            {n.state === "unavailable"
              ? t("overview.apiUnreadable", { network })
              : t("overview.readingBlocks")}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="block-table">
              <thead>
                <tr>
                  <th>{t("col.height")}</th>
                  <th>{t("col.blockHash")}</th>
                  <th>{t("col.transactions")}</th>
                  <th>{t("col.blockTime")}</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.hash}>
                    <td>
                      <Link
                        className="block-height address-link"
                        to={`/block/${b.height}`}
                      >
                        <Box size={14} />
                        {fmtInt(b.height)}
                      </Link>
                    </td>
                    <td>
                      <HashLink hash={b.hash} to={`/block/${b.height}`} />
                    </td>
                    <td>{fmtInt(b.transactions)}</td>
                    <td>
                      <Age ts={b.timestamp} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Link className="text-link section-more" to="/explorer/blocks">
          {t("overview.allBlocks")} <ArrowRight size={14} />
        </Link>
      </Section>
      <Section
        id="latest-transactions"
        title={t("overview.latestTxs")}
        meta={t("overview.latestTxsMeta")}
      >
        <SourceNote read={txs} what={t("what.transactions")} />
        <ReadGate read={txs} what={t("what.transactions")}>
          {(page) => <TxTable txs={page.txs} />}
        </ReadGate>
        <Link className="text-link section-more" to="/transactions">
          {t("overview.allTxs")} <ArrowRight size={14} />
        </Link>
      </Section>
    </ExplorerMain>
  );
}
