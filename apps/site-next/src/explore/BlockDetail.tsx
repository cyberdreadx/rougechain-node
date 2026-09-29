import { Status } from "@rougechain/ui";
import type { BlockPreview } from "./PreviewContext";
export function BlockDetail({ block }: { block: BlockPreview }) {
  return (
    <div className="explore-content">
      <Status state={block.provenance === "live" ? "live" : "demo"}>
        {block.provenance === "live"
          ? "Live API at selection"
          : `${block.provenance} data at selection`}
      </Status>
      <h3>Block #{block.height}</h3>
      <dl className="block-detail">
        <dt>Hash</dt>
        <dd className="mono">{block.hash}</dd>
        <dt>Transactions</dt>
        <dd>{block.transactions}</dd>
        <dt>Timestamp</dt>
        <dd>{new Date(block.timestamp).toISOString()}</dd>
      </dl>
      <p className="pane-note">
        Captured from the current block list. No detail endpoint requested.
      </p>
      <a className="text-link" href="/explorer/blocks">
        Open full Explorer ↗
      </a>
    </div>
  );
}
