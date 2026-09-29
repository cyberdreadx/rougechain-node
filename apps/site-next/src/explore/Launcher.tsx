import { launcherGroups, type WorkspaceView } from "./model";
export function Launcher({
  onOpen,
  state,
}: {
  onOpen: (name: WorkspaceView) => void;
  state: (name: WorkspaceView) => string;
}) {
  return (
    <nav className="workspace-launcher" aria-label="Workspace launcher">
      {launcherGroups.map((group) => (
        <section key={group.name}>
          <h3>{group.name}</h3>
          {group.views.map((name) => (
            <button
              key={name}
              onClick={() => onOpen(name)}
              aria-label={`Open ${name}`}
              data-state={state(name)}
            >
              <span>{name === "Build" ? "Developer" : name}</span>
              <small>{state(name)}</small>
            </button>
          ))}
        </section>
      ))}
    </nav>
  );
}
