import { appById } from "./ecosystem/apps";
import { useState } from "react";
import { Search, Copy, Check, ArrowUpRight, Box } from "lucide-react";
import { Button, Status, DemoBadge, EmptyState } from "@rougechain/ui";
import {
  NetworkControls,
  NetworkMetrics,
  DataNote,
  useNetwork,
} from "./Network";
export function age(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <div className="hash-cell">
      <span className="mono" title={hash}>
        {hash.slice(0, 10)}…{hash.slice(-6)}
      </span>
      <Button
        variant="ghost icon copy-button"
        aria-label={`Copy hash ${hash}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(hash);
            setCopied(true);
            setFailed(false);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
            setFailed(true);
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      <span className="sr-only" role="status">
        {copied
          ? "Hash copied"
          : failed
            ? "Clipboard unavailable. Select the full hash below."
            : ""}
      </span>
      {failed && <code className="copy-fallback">{hash}</code>}
    </div>
  );
}
const demoTxs = [
  {
    hash: "83f410942f7cfbb95de6d98be2102a44450e379867ad5a73d1cb76e919406b610",
    kind: "Transfer",
    from: "rc_demo_79ef…c38a",
    to: "rc_demo_201a…b77e",
    amount: "240.00 XRGE",
  },
  {
    hash: "a519ecd711242aec8798622991760a17d1686b53336a9c1a4f09af9682032715d",
    kind: "Contract call",
    from: "rc_demo_681a…25d1",
    to: "rc_demo_49fe…d704",
    amount: "0.00 XRGE",
  },
  {
    hash: "c317d98e753b15369f5702925ae5aed8f1d45d17510e50242bf6387524c132a5",
    kind: "Transfer",
    from: "rc_demo_488b…771a",
    to: "rc_demo_65aa…fe37",
    amount: "18.50 XRGE",
  },
];
export default function Explorer({
  section = "overview",
}: {
  section?: string;
}) {
  const n = useNetwork();
  const [search, setSearch] = useState("");
  const blocks = n.data?.blocks.filter((b) =>
    `${b.height} ${b.hash}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <main id="main" className="app-main">
      <div className="container">
        <div className="app-page-heading">
          <div>
            <div className="eyebrow">The network, in detail</div>
            <h1>
              {section === "overview"
                ? "Explorer"
                : section === "nfts"
                  ? "NFTs"
                  : section[0].toUpperCase() + section.slice(1)}
            </h1>
            <p>A clear view into RougeChain mainnet.</p>
          </div>
          <DemoBadge />
        </div>
        {["overview", "blocks"].includes(section) && (
          <>
            <div className="explorer-search">
              <Search size={18} />
              <label className="sr-only" htmlFor="block-search">
                Filter recent blocks by height or hash
              </label>
              <input
                id="block-search"
                placeholder="Filter recent blocks by height or hash"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="mono muted">RECENT BLOCKS ONLY</span>
            </div>
            <div className="app-toolbar">
              <span className="mono muted">ROUGECHAIN MAINNET</span>
              <NetworkControls />
            </div>
            <NetworkMetrics />
            <DataNote />
            <section className="data-section" aria-labelledby="latest-blocks">
              <div className="table-heading">
                <div>
                  <h2 id="latest-blocks">Latest blocks</h2>
                  <span className="muted">
                    The latest {n.data?.blocks.length ?? "—"} blocks returned by
                    the public API.
                  </span>
                </div>
                <Status state={n.state} />
              </div>
              {!n.data ? (
                <EmptyState title="Loading network data">
                  A saved snapshot will be shown if the API is unavailable.
                </EmptyState>
              ) : blocks?.length === 0 ? (
                <EmptyState title="No matching blocks">
                  Try a height or hash from the recent block list.
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
                      {blocks?.map((b) => (
                        <tr key={b.hash}>
                          <td>
                            <span className="block-height">
                              <Box size={14} />
                              {b.height.toLocaleString()}
                            </span>
                          </td>
                          <td>
                            <CopyHash hash={b.hash} />
                          </td>
                          <td>{b.transactions}</td>
                          <td>
                            <time
                              dateTime={new Date(b.timestamp).toISOString()}
                              title={new Date(b.timestamp).toLocaleString()}
                            >
                              {age(b.timestamp)}
                            </time>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
        {["overview", "transactions"].includes(section) && (
          <section
            className="data-section"
            aria-labelledby="latest-transactions"
          >
            <div className="table-heading">
              <div>
                <h2 id="latest-transactions">Transaction design</h2>
                <span className="muted">
                  Illustrative records. No transaction endpoint is consumed.
                </span>
              </div>
              <Status state="demo">Synthetic demo</Status>
            </div>
            <div className="table-scroll">
              <table className="transaction-table">
                <thead>
                  <tr>
                    <th>Transaction hash</th>
                    <th>Type</th>
                    <th>From → To</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {demoTxs.map((tx) => (
                    <tr key={tx.hash}>
                      <td>
                        <CopyHash hash={tx.hash} />
                      </td>
                      <td>{tx.kind}</td>
                      <td className="mono muted">
                        {tx.from}
                        <br />
                        {tx.to}
                      </td>
                      <td>{tx.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {["tokens", "nfts", "contracts"].includes(section) && (
          <section className="data-section">
            <Status state="demo">Synthetic specimen</Status>
            <h2>
              {section === "tokens"
                ? "Asset directory"
                : section === "nfts"
                  ? "Collectibles"
                  : "WASM contracts"}
            </h2>
            <p className="muted">
              Illustrative layout only. No additional API endpoint is consumed.
            </p>
            <div className="specimen-grid">
              {(section === "tokens"
                ? ["XRGE", "qETH", "qUSDC"]
                : section === "nfts"
                  ? ["Genesis collection · Demo", "No collectibles connected"]
                  : ["WASM contract · Demo", "Deployment unavailable"]
              ).map((name) => (
                <article className="surface" key={name}>
                  <h3>{name}</h3>
                  <p>Supply / activity —</p>
                  <span className="mono muted">DEMO DATA</span>
                </article>
              ))}
            </div>
          </section>
        )}
        <div className="architecture-note">
          <span className="mono">PROPOSED FUTURE HOME</span>
          <span>{appById("explorer")!.proposedHost}</span>
          <p>
            Architecture proposal only. This standalone POC does not create or
            migrate a production destination.
          </p>
          <a href="/design-system">
            Explore the shared design language <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
    </main>
  );
}
