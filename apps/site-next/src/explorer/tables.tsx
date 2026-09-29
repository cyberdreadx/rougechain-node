import { Link } from "react-router-dom";
import { Box } from "lucide-react";
import { EmptyState } from "@rougechain/ui";
import type { BlockSummary, TxView } from "@rougechain/chain-readonly";
import {
  AddressLink,
  Age,
  Amount,
  BlockLink,
  HashLink,
  TypePill,
  Xrge,
} from "./ui";

export function BlockTable({
  blocks,
  empty = "No blocks",
}: {
  blocks: BlockSummary[];
  empty?: string;
}) {
  if (!blocks.length)
    return (
      <EmptyState title={empty}>
        The node returned no blocks for this range.
      </EmptyState>
    );
  return (
    <div className="table-scroll">
      <table className="stack-table">
        <thead>
          <tr>
            <th>Height</th>
            <th>Block hash</th>
            <th>Transactions</th>
            <th>Proposer</th>
            <th>Block time</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.hash}>
              <td data-label="Height">
                <Link
                  className="block-height address-link"
                  to={`/block/${b.height}`}
                >
                  <Box size={14} />
                  {b.height.toLocaleString()}
                </Link>
              </td>
              <td data-label="Hash">
                <HashLink hash={b.hash} to={`/block/${b.height}`} />
              </td>
              <td data-label="Transactions">{b.txCount}</td>
              <td data-label="Proposer">
                <AddressLink identity={b.proposer} />
              </td>
              <td data-label="Time">
                <Age ts={b.time} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TxTable({
  txs,
  showBlock = true,
  empty = "No transactions",
}: {
  txs: TxView[];
  showBlock?: boolean;
  empty?: string;
}) {
  if (!txs.length)
    return (
      <EmptyState title={empty}>
        The node returned no transactions here.
      </EmptyState>
    );
  const direction = txs.some((t) => t.direction);
  return (
    <div className="table-scroll">
      <table className="stack-table tx-table">
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Type</th>
            {direction && <th>Direction</th>}
            <th>From → To</th>
            <th>Amount</th>
            <th>Fee</th>
            {showBlock && <th>Block</th>}
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t) => (
            <tr key={`${t.id}-${t.blockHeight}`}>
              <td data-label="Transaction">
                <HashLink hash={t.id} to={`/tx/${t.id}`} />
              </td>
              <td data-label="Type">
                <TypePill type={t.type} />
              </td>
              {direction && (
                <td data-label="Direction">
                  <span className={`pill direction-${t.direction}`}>
                    {t.direction === "in" ? "In" : "Out"}
                  </span>
                </td>
              )}
              <td data-label="From → To" className="from-to">
                {t.faucet ? (
                  <span className="muted">Faucet</span>
                ) : (
                  <AddressLink identity={t.from} />
                )}
                {t.to && (
                  <>
                    <span className="muted" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only"> to </span>
                    <AddressLink identity={t.to} />
                  </>
                )}
              </td>
              <td data-label="Amount">
                <Amount raw={t.amount} symbol={t.symbol} />
              </td>
              <td data-label="Fee">
                <Xrge amount={t.fee} />
              </td>
              {showBlock && (
                <td data-label="Block">
                  <BlockLink height={t.blockHeight} />
                </td>
              )}
              <td data-label="Age">
                <Age ts={t.blockTime} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
