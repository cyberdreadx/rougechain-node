import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtInt } from "../i18n/format";
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
  const { t } = useTranslation("common");
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
            aria-label={t("workspace.panels")}
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
                  {t(`workspace.views.${name}`)}
                </button>
              ))}
            {block && (
              <button
                role="tab"
                aria-selected={active === "BlockDetail"}
                onClick={() => setActive("BlockDetail")}
              >
                {t("block.title", { height: fmtInt(block.height) })}
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
                  aria-label={t(`workspace.views.${name}`)}
                  hidden={active !== name || hidden.includes(name)}
                >
                  <div className="compact-panel-heading">
                    <h3>{t(`workspace.views.${name}`)}</h3>
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
                      {t("workspace.hideView", {
                        name: t(`workspace.views.${name}`),
                      })}
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
            {t("workspace.reset")}
          </button>
          <p className="pane-note">
            {t("workspace.compactNote")}
          </p>
        </div>
      </div>
    </PreviewContext.Provider>
  );
}
