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
import { useTranslation } from "react-i18next";
import { fmtInt } from "../i18n/format";
export function ExploreNetworkView() {
  const n = useNetwork();
  const { t } = useTranslation("common");
  return (
    <div className="explore-content network-view">
      <div className="pane-kicker">
        <span>{t("views.network.kicker")}</span>
        <Status state={n.state}>
          {n.state === "live"
            ? t("views.network.connected")
            : t(`network.state.${n.state}`)}
        </Status>
      </div>
      <div className="network-height">
        {n.data ? fmtInt(n.data.height) : "—"}
      </div>
      <div className="mono muted">{t("views.network.latest")}</div>
      <div className="pane-metrics">
        <div>
          <span>{t("views.network.validators")}</span>
          <strong>{n.data ? fmtInt(n.data.validators) : "—"}</strong>
        </div>
        <div>
          <span>{t("network.metrics.peers")}</span>
          <strong>{n.data ? fmtInt(n.data.peers) : "—"}</strong>
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
          ? t("views.network.noteDemo")
          : n.state === "live"
            ? t("views.network.noteLive")
            : n.state === "stale"
              ? t("views.network.noteStale")
              : t("views.network.noteLoading")}
      </p>
    </div>
  );
}
export function ExploreExplorerView() {
  const n = useNetwork();
  const preview = usePreview();
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <div className="pane-kicker">
        <span>{t("views.explorer.kicker")}</span>
        <a href="/explorer">
          {t("views.explorer.open")} <ArrowUpRight size={13} />
        </a>
      </div>
      {n.data?.blocks.slice(0, 4).map((b) => (
        <button
          onClick={() => preview.openBlock({ ...b, provenance: n.state })}
          className="mini-block"
          key={b.hash}
        >
          <Box size={17} />
          <strong>#{fmtInt(b.height)}</strong>
          <span className="mono muted">
            {b.hash.slice(0, 8)}…{b.hash.slice(-4)}
          </span>
          <span>{t("views.explorer.txs", { count: b.transactions })}</span>
        </button>
      )) ?? <p>{t("views.explorer.loading")}</p>}
      <div className="pane-note">
        {n.state === "demo"
          ? t("network.dataState.demo")
          : t("views.explorer.publicData")}{" "}
        · {t("views.explorer.note")}
      </div>
    </div>
  );
}
export function ExploreEcosystemView() {
  const preview = usePreview();
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <p className="pane-intro">{t("views.ecosystem.intro")}</p>
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
              <span>{t(`apps.${a.id}.name`)}</span>
              <small>{t("views.ecosystem.openPreview")} ↗</small>
            </button>
          ))}
      </div>
      <a className="pane-note text-link" href="/architecture">
        {t("views.ecosystem.architecture")} ↗
      </a>
    </div>
  );
}
export function ExploreBuildView() {
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <p className="pane-intro">{t("views.build.intro")}</p>
      <CodeBlock>
        npm install
        <br />
        @rougechain/sdk
      </CodeBlock>
      <div className="pane-links">
        <TextLink href={DOCS}>{t("views.build.sdk")}</TextLink>
        <TextLink href={DOCS}>{t("views.build.wasm")}</TextLink>
        <TextLink href={DOCS}>{t("views.build.agents")}</TextLink>
        <TextLink href={GITHUB}>{t("views.build.source")}</TextLink>
      </div>
    </div>
  );
}
export function ExploreSecurityView() {
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <p className="pane-intro">{t("views.security.intro")}</p>
      <div className="security-primitives">
        <div>
          <strong>ML-DSA-65</strong>
          <span>{t("views.security.signatures")} · FIPS 204</span>
        </div>
        <div>
          <strong>ML-KEM-768</strong>
          <span>{t("views.security.kem")} · FIPS 203</span>
        </div>
        <div>
          <strong>AES-256-GCM</strong>
          <span>{t("views.security.aead")} · FIPS 197 / SP 800-38D</span>
        </div>
        <div>
          <strong>SHA-256 + BLAKE3</strong>
          <span>{t("views.security.hashing")} · FIPS 180-4 / BLAKE3</span>
        </div>
      </div>
      <TextLink href="/#security">{t("views.security.stack")}</TextLink>
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
