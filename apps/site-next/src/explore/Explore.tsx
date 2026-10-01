import { Section } from "@rougechain/ui";
import { NetworkControls, DataNote } from "../Network";
import WorkspaceExperience from "./WorkspaceExperience";
import { useTranslation } from "react-i18next";
export default function Explore() {
  const { t } = useTranslation("common");
  return (
    <Section id="explore" eyebrow={t("explore.eyebrow")}>
      <div className="section-heading">
        <div>
          <h2>{t("explore.title")}</h2>
          <p className="explore-subtitle">
            {t("explore.subtitle")}
          </p>
        </div>
        <NetworkControls />
      </div>
      <WorkspaceExperience embedded />
      <div className="workspace-footer">
        <a className="button outline" href="/workspace">
          {t("explore.openWorkspace")} ↗
        </a>
        <span className="pane-note">
          {t("explore.paneNote")}
        </span>
      </div>
      <DataNote />
    </Section>
  );
}
