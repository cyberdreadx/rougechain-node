import { Component, type ReactNode } from "react";
import CompactWorkspace from "./CompactWorkspace";
import type { WorkspaceView } from "./model";
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
          Workspace unavailable. Use the compact workspace below.
        </p>
        <CompactWorkspace requested={this.props.requested} />
      </>
    ) : (
      this.props.children
    );
  }
}
export default function WorkspaceExperience({
  requested,
}: {
  embedded?: boolean;
  requested?: WorkspaceView;
}) {
  return (
    <WorkspaceBoundary requested={requested}>
      <CompactWorkspace key={requested} requested={requested} />
    </WorkspaceBoundary>
  );
}
