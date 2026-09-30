import { Status } from "@rougechain/ui";
import { useTranslation } from "react-i18next";
import { fmtDateTime, fmtInt } from "../i18n/format";
import type { BlockPreview } from "./PreviewContext";
export function BlockDetail({ block }: { block: BlockPreview }) {
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state={block.provenance === "live" ? "live" : "demo"}>
        {block.provenance === "live"
          ? t("block.liveAtSelection")
          : t("block.dataAtSelection", {
              source: t(`network.state.${block.provenance}`, {
                defaultValue: block.provenance,
              }),
            })}
      </Status>
      <h3>{t("block.title", { height: fmtInt(block.height) })}</h3>
      <dl className="block-detail">
        <dt>{t("block.hash")}</dt>
        <dd className="mono">{block.hash}</dd>
        <dt>{t("block.transactions")}</dt>
        <dd>{fmtInt(block.transactions)}</dd>
        <dt>{t("block.timestamp")}</dt>
        <dd>
          <time dateTime={new Date(block.timestamp).toISOString()}>
            {fmtDateTime(block.timestamp, {
              dateStyle: "medium",
              timeStyle: "medium",
            })}
          </time>
        </dd>
      </dl>
      <p className="pane-note">{t("block.note")}</p>
      <a className="text-link" href="/explorer/blocks">
        {t("block.openExplorer")} ↗
      </a>
    </div>
  );
}
