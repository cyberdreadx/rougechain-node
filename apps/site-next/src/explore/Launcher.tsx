import { useTranslation } from "react-i18next";
import { launcherGroups, type WorkspaceView } from "./model";

/** Launcher state (data-state, English) → common:workspace.state.<key>. */
const stateKeys: Record<string, string> = {
  "Not opened": "notOpened",
  Hidden: "hidden",
  Focused: "focused",
  Open: "open",
};
export function Launcher({
  onOpen,
  state,
}: {
  onOpen: (name: WorkspaceView) => void;
  state: (name: WorkspaceView) => string;
}) {
  const { t } = useTranslation("common");
  return (
    <nav className="workspace-launcher" aria-label={t("workspace.launcher")}>
      {launcherGroups.map((group) => (
        <section key={group.name}>
          <h3>{t(`workspace.groups.${group.name}`)}</h3>
          {group.views.map((name) => (
            <button
              key={name}
              onClick={() => onOpen(name)}
              aria-label={t("workspace.openView", {
                name: t(`workspace.views.${name}`),
              })}
              data-state={state(name)}
            >
              <span>
                {name === "Build"
                  ? t("workspace.developer")
                  : t(`workspace.views.${name}`)}
              </span>
              <small>
                {stateKeys[state(name)]
                  ? t(`workspace.state.${stateKeys[state(name)]}`)
                  : state(name)}
              </small>
            </button>
          ))}
        </section>
      ))}
    </nav>
  );
}
