import { useSearchParams } from "react-router-dom";
import WorkspaceExperience from "./explore/WorkspaceExperience";
import { resolveWorkspaceView } from "./explore/model";
import { NetworkControls, DataNote } from "./Network";
export default function WorkspacePage() {
  const [params] = useSearchParams();
  const requested = resolveWorkspaceView(params.get("open"));
  return (
    <main id="main" className="workspace-page container">
      <div className="app-page-heading">
        <div>
          <div className="eyebrow">Your ecosystem / Workspace</div>
          <h1>Make room for possibility.</h1>
          <p>Open an app. Bring the network into focus.</p>
        </div>
        <NetworkControls />
      </div>
      {params.has("open") && !requested && (
        <p role="status">That preview is not available. Choose an app below.</p>
      )}
      <WorkspaceExperience requested={requested} />
      <DataNote />
    </main>
  );
}
