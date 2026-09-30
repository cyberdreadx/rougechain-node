import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
import { fmtInt } from "../i18n/format";

export function BlockTable({
  blocks,
  empty,
}: {
  blocks: BlockSummary[];
  empty?: string;
}) {
  const { t } = useTranslation("explorer");
  if (!blocks.length)
    return (
      <EmptyState title={empty ?? t("tables.noBlocks")}>
        {t("tables.noBlocksBody")}
      </EmptyState>
    );
  return (
    <div className="table-scroll">
      <table className="stack-table">
        <thead>
          <tr>
            <th>{t("col.height")}</th>
            <th>{t("col.blockHash")}</th>
            <th>{t("col.transactions")}</th>
            <th>{t("col.proposer")}</th>
            <th>{t("col.blockTime")}</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.hash}>
              <td data-label={t("col.height")}>
                <Link
                  className="block-height address-link"
                  to={`/block/${b.height}`}
                >
                  <Box size={14} />
                  {fmtInt(b.height)}
                </Link>
              </td>
              <td data-label={t("col.hash")}>
                <HashLink hash={b.hash} to={`/block/${b.height}`} />
              </td>
              <td data-label={t("col.transactions")}>{fmtInt(b.txCount)}</td>
              <td data-label={t("col.proposer")}>
                <AddressLink identity={b.proposer} />
              </td>
              <td data-label={t("col.time")}>
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
  empty,
}: {
  txs: TxView[];
  showBlock?: boolean;
  empty?: string;
}) {
  const { t } = useTranslation("explorer");
  if (!txs.length)
    return (
      <EmptyState title={empty ?? t("tables.noTxs")}>
        {t("tables.noTxsBody")}
      </EmptyState>
    );
  const direction = txs.some((tx) => tx.direction);
  return (
    <div className="table-scroll">
      <table className="stack-table tx-table">
        <thead>
          <tr>
            <th>{t("col.transaction")}</th>
            <th>{t("col.type")}</th>
            {direction && <th>{t("col.direction")}</th>}
            <th>{t("col.fromTo")}</th>
            <th>{t("col.amount")}</th>
            <th>{t("col.fee")}</th>
            {showBlock && <th>{t("col.block")}</th>}
            <th>{t("col.age")}</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((tx) => (
            <tr key={`${tx.id}-${tx.blockHeight}`}>
              <td data-label={t("col.transaction")}>
                <HashLink hash={tx.id} to={`/tx/${tx.id}`} />
              </td>
              <td data-label={t("col.type")}>
                <TypePill type={tx.type} />
              </td>
              {direction && (
                <td data-label={t("col.direction")}>
                  <span className={`pill direction-${tx.direction}`}>
                    {tx.direction === "in" ? t("tables.in") : t("tables.out")}
                  </span>
                </td>
              )}
              <td data-label={t("col.fromTo")} className="from-to">
                {tx.faucet ? (
                  <span className="muted">{t("tables.faucet")}</span>
                ) : (
                  <AddressLink identity={tx.from} />
                )}
                {tx.to && (
                  <>
                    <span className="muted" aria-hidden="true">
                      {" → "}
                    </span>
                    <span className="sr-only"> {t("tables.to")} </span>
                    <AddressLink identity={tx.to} />
                  </>
                )}
              </td>
              <td data-label={t("col.amount")}>
                <Amount raw={tx.amount} symbol={tx.symbol} />
              </td>
              <td data-label={t("col.fee")}>
                <Xrge amount={tx.fee} />
              </td>
              {showBlock && (
                <td data-label={t("col.block")}>
                  <BlockLink height={tx.blockHeight} />
                </td>
              )}
              <td data-label={t("col.age")}>
                <Age ts={tx.blockTime} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
