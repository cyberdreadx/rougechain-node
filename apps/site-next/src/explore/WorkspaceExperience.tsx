import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import CompactWorkspace from "./CompactWorkspace";
import type { WorkspaceView } from "./model";
// Desktop-only chunk: dockview and its stylesheet download only when the interactive view renders.
const DockviewWorkspace = lazy(() => import("./DockviewWorkspace"));
export const DESKTOP_QUERY = "(min-width: 900px)";
function UnavailableNote() {
  const { t } = useTranslation("common");
  return <p role="status">{t("workspace.unavailable")}</p>;
}
export class WorkspaceBoundary extends Component<
  { children: ReactNode; requested?: WorkspaceView },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <>
        <UnavailableNote />
        <CompactWorkspace requested={this.props.requested} />
      </>
    ) : (
      this.props.children
    );
  }
}
export default function WorkspaceExperience({
  embedded = false,
  requested,
}: {
  embedded?: boolean;
  requested?: WorkspaceView;
}) {
  const { t } = useTranslation("common");
  const [desktop, setDesktop] = useState(false),
    [simple, setSimple] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <>
      <div className="workspace-toolbar">
        <span className="mono muted">
          {t("workspace.toolbar")}
        </span>
        {desktop && (
          <button
            type="button"
            className="button ghost small"
            onClick={() => setSimple(!simple)}
          >
            {simple ? t("workspace.interactive") : t("workspace.simple")}
          </button>
        )}
      </div>
      {desktop && !simple ? (
        <WorkspaceBoundary requested={requested}>
          <Suspense fallback={<CompactWorkspace requested={requested} />}>
            <DockviewWorkspace embedded={embedded} requested={requested} />
          </Suspense>
        </WorkspaceBoundary>
      ) : (
        <CompactWorkspace key={requested} requested={requested} />
      )}
    </>
  );
}
