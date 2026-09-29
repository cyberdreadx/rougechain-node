import { apps } from "../ecosystem/apps";
import { PreviewContext, type BlockPreview } from "./PreviewContext";
import { BlockDetail } from "./BlockDetail";
import { useEffect, useState } from "react";
import {
  Workspace,
  WorkspaceProvider,
  ViewType,
  Split,
  View,
  useOptionalWorkspace,
  useWorkspaceState,
  useView,
} from "@danfessler/trellis-react";
import "@danfessler/trellis/style.css";
import {
  workspaceViews,
  workspaceKey,
  prepareV2Layout,
  type WorkspaceView,
} from "./model";
import { Launcher } from "./Launcher";
import { views } from "./Views";
import { useNetwork } from "../Network";
function WorkspaceContent({ name }: { name: WorkspaceView }) {
  const ws = useOptionalWorkspace();
  const Content = views[name];
  return (
    <PreviewContext.Provider
      value={{
        open: (name) => {
          ws?.open(name, { reuse: "type", placement: "tab" });
        },
        openBlock: (block) => {
          const explorer = ws?.views({ type: "Explorer" })[0];
          ws?.open("BlockDetail", {
            id: `block-${block.hash}`,
            params: block,
            reuse: (v) => v.params.hash === block.hash,
            placement: explorer ? { into: explorer.panelId } : "tab",
          });
        },
      }}
    >
      <Content />
    </PreviewContext.Provider>
  );
}
function BlockView() {
  const view = useView<BlockPreview>();
  return <BlockDetail block={view.params} />;
}
function ViewActions() {
  const view = useView();
  return (
    <div className="panel-actions">
      <button
        disabled={view.placement === "floating"}
        title={
          view.placement === "floating"
            ? "Dock this panel to focus"
            : "Maximize or restore panel"
        }
        onClick={() => view.workspace.navigation.toggle(view.id)}
        aria-label={`Focus ${view.type}`}
      >
        ⛶
      </button>
      <button onClick={() => view.hide()} aria-label={`Hide ${view.type}`}>
        −
      </button>
    </div>
  );
}
function Controls({ requested }: { requested?: WorkspaceView }) {
  const ws = useOptionalWorkspace();
  const state = useWorkspaceState();
  useEffect(() => {
    if (ws && requested)
      ws.open(requested, { reuse: "type", placement: "tab" });
  }, [ws, requested]);
  return (
    <Launcher
      onOpen={(name) => ws?.open(name, { reuse: "type", placement: "tab" })}
      state={(name) => {
        const v = state.views.find((v) => v.type === name);
        return !v
          ? "Not opened"
          : v.placement === "hidden"
            ? "Hidden"
            : state.focusedView === v.id
              ? "Focused"
              : "Open";
      }}
    />
  );
}
function StatusBar({ saved }: { saved: boolean }) {
  const ws = useOptionalWorkspace(),
    state = useWorkspaceState(),
    n = useNetwork();
  return (
    <div className="workspace-footer">
      <span className="mono muted">
        MAINNET · {n.state === "live" ? "LIVE API" : n.state.toUpperCase()} ·{" "}
        {state.views.filter((v) => v.placement !== "hidden").length} OPEN ·
        {saved ? "LAYOUT AUTO-SAVE ON" : "LAYOUT STORAGE UNAVAILABLE"}
      </span>
      <button
        className="button ghost small"
        onClick={() => ws?.navigation.overview()}
      >
        Overview
      </button>
      <button className="button ghost small" onClick={() => ws?.reset()}>
        Reset workspace
      </button>
    </div>
  );
}
export default function TrellisWorkspace({
  embedded = true,
  requested,
}: {
  embedded?: boolean;
  requested?: WorkspaceView;
}) {
  const [saved] = useState(() => {
    try {
      window.localStorage.setItem("rougechain-poc-storage-check", "1");
      window.localStorage.removeItem("rougechain-poc-storage-check");
      return true;
    } catch {
      return false;
    }
  });
  useState(() => {
    prepareV2Layout(workspaceKey(embedded));
    return null;
  });
  return (
    <WorkspaceProvider>
      <div className={`workspace-v2 ${embedded ? "embedded" : "full"}`}>
        <Controls requested={requested} />
        <div className="trellis-shell">
          <Workspace
            theme="dark"
            label="Explore RougeChain interactive workspace"
            navigation="focus"
            motion="system"
            floating={embedded ? false : "overlay"}
            storageKey={workspaceKey(embedded)}
            version={2}
            tokens={{
              "--trellis-font": "var(--font)",
              "--trellis-bg": "var(--bg)",
              "--trellis-panel": "var(--surface)",
              "--trellis-tabbar": "#13101b",
              "--trellis-tab-active": "var(--surface)",
              "--trellis-border": "var(--border)",
              "--trellis-text": "var(--ink)",
              "--trellis-text-muted": "var(--muted)",
              "--trellis-accent": "var(--violet)",
              "--trellis-radius": "8px",
              "--trellis-gap": "6px",
              "--trellis-tabbar-height": "40px",
              "--trellis-font-size": "12px",
              "--trellis-menu": "var(--raised)",
            }}
          >
            {workspaceViews.map((name) => {
              return (
                <ViewType
                  key={name}
                  id={name}
                  title={name}
                  menu={
                    apps.find((a) => a.workspaceView === name && a.pocRoute)
                      ? [
                          {
                            label: "Open full app",
                            run: () => {
                              window.location.href = apps.find(
                                (a) => a.workspaceView === name && a.pocRoute,
                              )!.pocRoute!;
                            },
                          },
                        ]
                      : []
                  }
                  singleton
                  closable={false}
                  accessory={<ViewActions />}
                >
                  <WorkspaceContent name={name} />
                </ViewType>
              );
            })}
            <ViewType
              id="BlockDetail"
              title={(v) => `Block #${v.params.height}`}
              accessory={<ViewActions />}
            >
              <BlockView />
            </ViewType>
            <Split weights={[1, 1.4, 1]}>
              <View type="Network" />
              <View type="Explorer" />
              <View type="Ecosystem" />
            </Split>
            <Workspace.Empty>
              <p>Choose an app in the launcher to restore your workspace.</p>
            </Workspace.Empty>
          </Workspace>
        </div>
      </div>
      <StatusBar saved={saved} />
    </WorkspaceProvider>
  );
}
