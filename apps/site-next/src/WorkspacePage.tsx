import { useSearchParams } from "react-router-dom";
import WorkspaceExperience from "./explore/WorkspaceExperience";
import { resolveWorkspaceView } from "./explore/model";
import { NetworkControls, DataNote } from "./Network";
import { useTranslation } from "react-i18next";
export default function WorkspacePage() {
  const { t } = useTranslation("common");
  const [params] = useSearchParams();
  const requested = resolveWorkspaceView(params.get("open"));
  return (
    <main id="main" className="workspace-page container">
      <div className="app-page-heading">
        <div>
          <div className="eyebrow">{t("workspacePage.eyebrow")}</div>
          <h1>{t("workspacePage.title")}</h1>
          <p>{t("workspacePage.lead")}</p>
        </div>
        <NetworkControls />
      </div>
      {params.has("open") && !requested && (
        <p role="status">{t("workspacePage.unknownPreview")}</p>
      )}
      <WorkspaceExperience requested={requested} />
      <DataNote />
    </main>
  );
}
