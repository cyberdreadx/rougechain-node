import { useState } from "react";
import { Launcher } from "./Launcher";
import { defaultViews, workspaceViews, type WorkspaceView } from "./model";
import { views } from "./Views";
import { PreviewContext, type BlockPreview } from "./PreviewContext";
import { BlockDetail } from "./BlockDetail";
export default function CompactWorkspace({
  requested,
}: {
  requested?: WorkspaceView;
}) {
  const [opened, setOpened] = useState<WorkspaceView[]>(() =>
    requested ? [...new Set([...defaultViews, requested])] : defaultViews,
  );
  const [hidden, setHidden] = useState<WorkspaceView[]>([]);
  const [active, setActive] = useState<WorkspaceView | "BlockDetail">(
    requested ?? "Network",
  );
  const [block, setBlock] = useState<BlockPreview>();
  const open = (name: WorkspaceView) => {
    setOpened((old) => (old.includes(name) ? old : [...old, name]));
    setHidden((old) => old.filter((v) => v !== name));
    setActive(name);
  };
  return (
    <PreviewContext.Provider
      value={{
        open,
        openBlock: (block) => {
          setBlock(block);
          setActive("BlockDetail");
        },
      }}
    >
      <div className="compact-workspace">
        <Launcher
          onOpen={open}
          state={(name) =>
            !opened.includes(name)
              ? "Not opened"
              : hidden.includes(name)
                ? "Hidden"
                : active === name
                  ? "Focused"
                  : "Open"
          }
        />
        <div className="compact-panels">
          <div
            className="explore-tabs"
            role="tablist"
            aria-label="Workspace panels"
          >
            {opened
              .filter((n) => !hidden.includes(n))
              .map((name) => (
                <button
                  key={name}
                  role="tab"
                  id={`compact-tab-${name}`}
                  aria-controls={`compact-panel-${name}`}
                  tabIndex={active === name ? 0 : -1}
                  onKeyDown={(e) => {
                    const tabs = opened.filter((n) => !hidden.includes(n));
                    const index = tabs.indexOf(name);
                    const next =
                      e.key === "ArrowRight"
                        ? tabs[(index + 1) % tabs.length]
                        : e.key === "ArrowLeft"
                          ? tabs[(index + tabs.length - 1) % tabs.length]
                          : e.key === "Home"
                            ? tabs[0]
                            : e.key === "End"
                              ? tabs[tabs.length - 1]
                              : undefined;
                    if (next) {
                      e.preventDefault();
                      setActive(next);
                      document.getElementById(`compact-tab-${next}`)?.focus();
                    }
                  }}
                  aria-selected={active === name}
                  onClick={() => setActive(name)}
                >
                  {name}
                </button>
              ))}
            {block && (
              <button
                role="tab"
                aria-selected={active === "BlockDetail"}
                onClick={() => setActive("BlockDetail")}
              >
                Block #{block.height}
              </button>
            )}
          </div>
          {workspaceViews
            .filter((name) => opened.includes(name))
            .map((name) => {
              const Content = views[name];
              return (
                <section
                  key={name}
                  role="tabpanel"
                  id={`compact-panel-${name}`}
                  aria-labelledby={`compact-tab-${name}`}
                  aria-label={name}
                  hidden={active !== name || hidden.includes(name)}
                >
                  <div className="compact-panel-heading">
                    <h3>{name}</h3>
                    <button
                      className="button ghost small"
                      onClick={() => {
                        setHidden((old) => [...old, name]);
                        const next = opened.find(
                          (n) => n !== name && !hidden.includes(n),
                        );
                        if (next) setActive(next);
                      }}
                    >
                      Hide {name}
                    </button>
                  </div>
                  <Content />
                </section>
              );
            })}
          {active === "BlockDetail" && block && <BlockDetail block={block} />}
          <button
            className="button ghost small"
            onClick={() => {
              setOpened(defaultViews);
              setHidden([]);
              setActive("Network");
              setBlock(undefined);
            }}
          >
            Reset workspace
          </button>
          <p className="pane-note">
            Compact workspace · Panel state lasts for this visit.
          </p>
        </div>
      </div>
    </PreviewContext.Provider>
  );
}
