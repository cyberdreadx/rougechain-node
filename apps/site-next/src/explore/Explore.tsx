import { Section } from "@rougechain/ui";
import { NetworkControls, DataNote } from "../Network";
import WorkspaceExperience from "./WorkspaceExperience";
export default function Explore() {
  return (
    <Section id="explore" eyebrow="02 / Your window into the network">
      <div className="section-heading">
        <div>
          <h2>Explore RougeChain</h2>
          <p className="explore-subtitle">
            The network. The tools. The possibilities. Make it your own.
          </p>
        </div>
        <NetworkControls />
      </div>
      <WorkspaceExperience embedded />
      <div className="workspace-footer">
        <a className="button outline" href="/workspace">
          Open full workspace ↗
        </a>
        <span className="pane-note">
          Start with three panes. Open more from the launcher.
        </span>
      </div>
      <DataNote />
    </Section>
  );
}
