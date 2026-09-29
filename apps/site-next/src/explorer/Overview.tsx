import { Link } from "react-router-dom";
import { ArrowRight, Box } from "lucide-react";
import { EmptyState, Status } from "@rougechain/ui";
import {
  NetworkControls,
  NetworkMetrics,
  DataNote,
  useNetwork,
} from "../Network";
import { useChain } from "./chain";
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
} from "./ui";

/** Explorer overview: live network figures, latest blocks, latest transactions and search. */
export default function Overview() {
  const n = useNetwork();
  const { config } = useChain();
  const txs = useRead(["txs", 8, 0], (c) => c.txs(8, 0), { refetchMs: 30_000 });
  const blocks = n.data?.blocks;
  return (
    <ExplorerMain>
      <PageHeading eyebrow="The network, in detail" title="Explorer">
        A clear view into RougeChain {config.label.toLowerCase()}.
      </PageHeading>
      <ExplorerSearch />
      <div className="app-toolbar">
        <span className="mono muted">
          ROUGECHAIN {config.label.toUpperCase()}
        </span>
        <NetworkControls />
      </div>
      <NetworkMetrics />
      <DataNote />
      <Section
        id="latest-blocks"
        title="Latest blocks"
        meta={
          n.state === "demo"
            ? "From the saved snapshot. Not live data."
            : `The latest ${blocks?.length ?? "—"} blocks returned by the public API.`
        }
        aside={
          <Status state={n.state}>
            {n.state === "demo"
              ? "Snapshot"
              : n.state === "live"
                ? "Live"
                : n.state}
          </Status>
        }
      >
        {!blocks ? (
          <EmptyState
            title={
              n.state === "unavailable"
                ? "Blocks unavailable"
                : "Loading network data"
            }
          >
            {n.state === "unavailable"
              ? `The ${config.label} API could not be read.`
              : "Reading the latest blocks from the public API."}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="block-table">
              <thead>
                <tr>
                  <th>Height</th>
                  <th>Block hash</th>
                  <th>Transactions</th>
                  <th>Block time</th>
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
                        {b.height.toLocaleString()}
                      </Link>
                    </td>
                    <td>
                      <HashLink hash={b.hash} to={`/block/${b.height}`} />
                    </td>
                    <td>{b.transactions}</td>
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
          All blocks <ArrowRight size={14} />
        </Link>
      </Section>
      <Section
        id="latest-transactions"
        title="Latest transactions"
        meta="Most recent transactions indexed by the node."
      >
        <SourceNote read={txs} what="Transactions" />
        <ReadGate read={txs} what="Transactions">
          {(page) => <TxTable txs={page.txs} />}
        </ReadGate>
        <Link className="text-link section-more" to="/transactions">
          All transactions <ArrowRight size={14} />
        </Link>
      </Section>
    </ExplorerMain>
  );
}
