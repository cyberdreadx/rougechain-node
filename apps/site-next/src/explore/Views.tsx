import { usePreview } from "./PreviewContext";
import { apps } from "../ecosystem/apps";
import {
  WalletPreview,
  SwapPreview,
  BridgePreview,
  MessengerPreview,
  MailPreview,
  ValidatorsPreview,
} from "./Previews";
import type { WorkspaceView } from "./model";
import { ArrowUpRight, Box } from "lucide-react";
import { Status, TextLink, CodeBlock } from "@rougechain/ui";
import { useNetwork } from "../Network";
import { DOCS, GITHUB } from "../Shell";
export function ExploreNetworkView() {
  const n = useNetwork();
  return (
    <div className="explore-content network-view">
      <div className="pane-kicker">
        <span>ROUGECHAIN MAINNET</span>
        <Status state={n.state}>
          {n.state === "live" ? "API connected" : n.state}
        </Status>
      </div>
      <div className="network-height">
        {n.data?.height.toLocaleString() ?? "—"}
      </div>
      <div className="mono muted">LATEST REPORTED BLOCK</div>
      <div className="pane-metrics">
        <div>
          <span>Validators</span>
          <strong>{n.data?.validators ?? "—"}</strong>
        </div>
        <div>
          <span>Connected peers</span>
          <strong>{n.data?.peers ?? "—"}</strong>
        </div>
      </div>
      <div className="network-line" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="pane-note">
        {n.state === "demo"
          ? "Saved public API snapshot."
          : n.state === "live"
            ? "A read-only view of public network data."
            : n.state === "stale"
              ? "Last successful data; refresh unavailable."
              : "Requesting public network data."}
      </p>
    </div>
  );
}
export function ExploreExplorerView() {
  const n = useNetwork();
  const preview = usePreview();
  return (
    <div className="explore-content">
      <div className="pane-kicker">
        <span>LATEST BLOCKS</span>
        <a href="/explorer">
          Open Explorer <ArrowUpRight size={13} />
        </a>
      </div>
      {n.data?.blocks.slice(0, 4).map((b) => (
        <button
          onClick={() => preview.openBlock({ ...b, provenance: n.state })}
          className="mini-block"
          key={b.hash}
        >
          <Box size={17} />
          <strong>#{b.height.toLocaleString()}</strong>
          <span className="mono muted">
            {b.hash.slice(0, 8)}…{b.hash.slice(-4)}
          </span>
          <span>{b.transactions} txs</span>
        </button>
      )) ?? <p>Loading network data…</p>}
      <div className="pane-note">
        {n.state === "demo" ? "Demo · saved snapshot" : "Public GET data"} ·
        Inspect the network, without connecting a wallet.
      </div>
    </div>
  );
}
export function ExploreEcosystemView() {
  const preview = usePreview();
  return (
    <div className="explore-content">
      <p className="pane-intro">Your ecosystem. One workspace.</p>
      <div className="ecosystem-launch-list">
        {apps
          .filter(
            (a) =>
              a.workspaceView &&
              ![
                "sdk",
                "mcp",
                "node",
                "network",
                "liquidity",
                "explorer",
              ].includes(a.id),
          )
          .map((a) => (
            <button
              key={a.id}
              onClick={() => preview.open(a.workspaceView as WorkspaceView)}
            >
              <span>{a.name}</span>
              <small>Open preview ↗</small>
            </button>
          ))}
      </div>
      <a className="pane-note text-link" href="/architecture">
        Explore ecosystem architecture ↗
      </a>
    </div>
  );
}
export function ExploreBuildView() {
  return (
    <div className="explore-content">
      <p className="pane-intro">Build on a new foundation.</p>
      <CodeBlock>
        npm install
        <br />
        @rougechain/sdk
      </CodeBlock>
      <div className="pane-links">
        <TextLink href={DOCS}>SDK & documentation</TextLink>
        <TextLink href={DOCS}>WASM contracts</TextLink>
        <TextLink href={DOCS}>MCP / Agents & Run a Node</TextLink>
        <TextLink href={GITHUB}>Source code</TextLink>
      </div>
    </div>
  );
}
export function ExploreSecurityView() {
  return (
    <div className="explore-content">
      <p className="pane-intro">Post-quantum primitives.</p>
      <div className="security-primitives">
        <div>
          <strong>ML-DSA-65</strong>
          <span>Signatures · FIPS 204</span>
        </div>
        <div>
          <strong>ML-KEM-768</strong>
          <span>Key encapsulation · FIPS 203</span>
        </div>
        <div>
          <strong>SHA-256</strong>
          <span>Hashing · FIPS 180-4</span>
        </div>
      </div>
      <TextLink href="/#security">The cryptographic stack</TextLink>
    </div>
  );
}
export const views: Record<WorkspaceView, () => React.ReactNode> = {
  Wallet: WalletPreview,
  Swap: SwapPreview,
  Bridge: BridgePreview,
  Messenger: MessengerPreview,
  Mail: MailPreview,
  Validators: ValidatorsPreview,
  Network: ExploreNetworkView,
  Explorer: ExploreExplorerView,
  Ecosystem: ExploreEcosystemView,
  Build: ExploreBuildView,
  Security: ExploreSecurityView,
};
