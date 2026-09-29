import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import CompactWorkspace from "./CompactWorkspace";
import type { WorkspaceView } from "./model";
const Trellis = lazy(() => import("./TrellisWorkspace"));
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
        <p role="status">
          Interactive layout unavailable. Use the compact workspace below.
        </p>
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
  const [desktop, setDesktop] = useState(false),
    [simple, setSimple] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <>
      <div className="workspace-toolbar">
        <span className="mono muted">
          OPEN · ARRANGE · TAB · FOCUS · HIDE · RESTORE
        </span>
        <button
          className="button ghost small"
          onClick={() => setSimple(!simple)}
        >
          {simple ? "Interactive view" : "Simple view"}
        </button>
      </div>
      {desktop && !simple ? (
        <WorkspaceBoundary requested={requested}>
          <Suspense fallback={<CompactWorkspace requested={requested} />}>
            <Trellis embedded={embedded} requested={requested} />
          </Suspense>
        </WorkspaceBoundary>
      ) : (
        <CompactWorkspace key={requested} requested={requested} />
      )}
    </>
  );
}
