// Desktop window workspace (homepage Explore embed + /workspace), built on dockview (MIT).
// Reimplements the behaviour of Anders' approved Trellis integration — see
// docs/TRELLIS_WORKSPACE_ARCHITECTURE.md — with dockview as the docking engine:
// default Network / Explorer / Ecosystem panes; launcher open/focus/restore of singleton views;
// hide keeps the view mounted (state preserved); keyed Block Detail windows grouped with Explorer;
// maximize/restore + overview; floating only in the full /workspace; validated, versioned layout
// persistence with reset. Loaded lazily (desktop only) by WorkspaceExperience.
import "dockview-react/dist/styles/dockview.css";
import "./dockview-theme.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type FunctionComponent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type SerializedDockview,
} from "dockview-react";
import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { fmtInt } from "../i18n/format";
import { apps } from "../ecosystem/apps";
import { useNetwork } from "../Network";
import { BlockDetail } from "./BlockDetail";
import { Launcher } from "./Launcher";
import { PreviewContext, type BlockPreview } from "./PreviewContext";
import { views } from "./Views";
import { workspaceViews, type WorkspaceView } from "./model";
import {
  defaultLayout,
  floatingAllowed,
  launcherState,
  planOpen,
  planOpenBlock,
  withHidden,
  withoutHidden,
  type WorkspaceSnapshot,
} from "./dockModel";
import {
  BLOCK_DETAIL,
  clearDockLayout,
  dockLayoutKey,
  isBlockPreview,
  isWorkspaceView,
  loadDockLayout,
  saveDockLayout,
  storageAvailable,
  type DockLayoutJSON,
} from "./dockPersistence";

export const rougeTheme: DockviewTheme = {
  name: "rougechain",
  className: "dockview-theme-rougechain",
  colorScheme: "dark",
  gap: 6,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  dndTabIndicator: "line",
};

/** dockview options that differ between the homepage embed and the full /workspace. */
export function dockviewOptions(embedded: boolean) {
  return {
    theme: rougeTheme,
    disableFloatingGroups: !floatingAllowed(embedded),
    floatingGroupBounds: "boundedWithinViewport" as const,
    // Floating windows move by the empty part of their tab bar, like the approved design's
    // windows; dockview's separate blank title bar is not rendered.
    floatingGroupDragHandle: "tabbar" as const,
  };
}

/** Keyboard support for dockview's tabs (role="tab", tabindex 0) without the paid
 *  KeyboardNavigation module: Enter/Space activate; arrows/Home/End move within a tab strip. */
export function onTabKeyDown(
  e: ReactKeyboardEvent,
  activate: (panelId: string) => void,
) {
  const tab = (e.target as HTMLElement).closest<HTMLElement>(".dv-tab");
  if (!tab || e.target !== tab) return;
  const tabs = [
    ...(tab.parentElement?.querySelectorAll<HTMLElement>(":scope > .dv-tab") ??
      []),
  ];
  const index = tabs.indexOf(tab);
  const target =
    e.key === "ArrowRight"
      ? tabs[(index + 1) % tabs.length]
      : e.key === "ArrowLeft"
        ? tabs[(index - 1 + tabs.length) % tabs.length]
        : e.key === "Home"
          ? tabs[0]
          : e.key === "End"
            ? tabs[tabs.length - 1]
            : e.key === "Enter" || e.key === " "
              ? tab
              : undefined;
  if (!target) return;
  const id =
    target.querySelector<HTMLElement>("[data-panel-id]")?.dataset.panelId;
  if (!id) return;
  e.preventDefault();
  activate(id);
  target.focus();
}

/** Translated panel title: the view name, or "Block #<height>" for Block Detail windows. */
export function panelLabel(id: string, params?: unknown): string {
  if (isWorkspaceView(id)) return i18n.t(`common:workspace.views.${id}`);
  if (isBlockPreview(params))
    return i18n.t("common:block.title", { height: fmtInt(params.height) });
  return id;
}

const fullAppRoute = (name: WorkspaceView) =>
  apps.find((a) => a.workspaceView === name && a.pocRoute)?.pocRoute;

/** One DOM node per view, owned by the workspace (not by dockview). View content is portalled
 *  into it, and dockview panels just adopt the node — so hiding, moving or floating a panel never
 *  unmounts the React content. */
class HostStore {
  private hosts = new Map<string, HTMLDivElement>();
  get(id: string) {
    let host = this.hosts.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "dock-view-host";
      this.hosts.set(id, host);
    }
    return host;
  }
  delete(id: string) {
    this.hosts.get(id)?.remove();
    this.hosts.delete(id);
  }
}

interface Actions {
  hide: (id: string) => void;
}

function makeComponents(store: HostStore) {
  const Slot: FunctionComponent<IDockviewPanelProps> = ({ api }) => {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const el = ref.current!;
      const host = store.get(api.id);
      el.appendChild(host);
      return () => {
        if (host.parentElement === el) host.remove();
      };
    }, [api.id]);
    return <div ref={ref} className="dock-view-slot" />;
  };
  return Object.fromEntries(
    [...workspaceViews, BLOCK_DETAIL].map((c) => [c, Slot]),
  ) as Record<string, FunctionComponent<IDockviewPanelProps>>;
}

function makeTab(
  actions: Actions,
): FunctionComponent<IDockviewPanelHeaderProps> {
  return function Tab(props) {
    // Keep dockview's stored title in the current language (it renders api.title).
    useTranslation("common"); // re-render on a language change
    const label = panelLabel(props.api.id, props.params);
    useEffect(() => {
      if (props.api.title !== label) props.api.setTitle(label);
    }, [label, props.api]);
    // Singleton views are never destroyed: like the approved design their tabs carry no close
    // control (hide lives in the header), while Block Detail tabs close normally.
    return isWorkspaceView(props.api.id) ? (
      <DockviewDefaultTab
        {...props}
        data-panel-id={props.api.id}
        hideClose
        closeActionOverride={() => actions.hide(props.api.id)}
      />
    ) : (
      <DockviewDefaultTab {...props} data-panel-id={props.api.id} />
    );
  };
}

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}

/** The "…" panel menu: dock / move / float / open full app / hide, keyboard operable. */
function PanelMenu({ title, items }: { title: string; items: MenuItem[] }) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const onDown = (e: PointerEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !button.current?.contains(e.target as Node)
      )
        close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => {
      e.preventDefault();
      buttons[(i + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(buttons.length - 1);
    else if (e.key === "Tab") close(false);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="panel-menu-button"
        aria-label={t("dock.menuFor", { name: title })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("dock.menu")}
        onClick={() => {
          const r = button.current!.getBoundingClientRect();
          setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={t("dock.panel", { name: title })}
            className="panel-menu"
            style={{ top: pos.top, right: pos.right }}
            onKeyDown={onKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close(true);
                  item.run();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function makeHeaderActions(
  embedded: boolean,
  actions: Actions,
): FunctionComponent<IDockviewHeaderActionsProps> {
  return function HeaderActions({ api, containerApi, group }) {
    const { t } = useTranslation("common");
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      const subs = [
        api.onDidLocationChange(rerender),
        api.onDidActivePanelChange(rerender),
        containerApi.onDidMaximizedGroupChange(rerender),
        containerApi.onDidLayoutChange(rerender),
      ];
      return () => subs.forEach((s) => s.dispose());
    }, [api, containerApi]);
    const panel = group.activePanel;
    if (!panel) return null;
    const title = panelLabel(panel.id, panel.params);
    const singleton = isWorkspaceView(panel.id);
    const floating = api.location.type === "floating";
    const maximized = !floating && api.isMaximized();
    const route = singleton
      ? fullAppRoute(panel.id as WorkspaceView)
      : undefined;
    const toggleMaximize = () =>
      maximized ? api.exitMaximized() : api.maximize();
    const items: MenuItem[] = [];
    if (route)
      items.push({
        label: t("dock.openApp"),
        run: () => window.location.assign(route),
      });
    items.push({
      label: maximized ? t("dock.restoreLayout") : t("dock.maximize"),
      run: toggleMaximize,
      disabled: floating,
    });
    if (group.panels.length > 1 || floating)
      items.push({
        label: t("dock.newColumn"),
        run: () => {
          if (containerApi.hasMaximizedGroup())
            containerApi.exitMaximizedGroup();
          const target = containerApi.addGroup({ direction: "right" });
          panel.api.moveTo({ group: target });
        },
      });
    if (floatingAllowed(embedded))
      items.push(
        floating
          ? {
              label: t("dock.dock"),
              run: () => api.moveTo({ position: "right" }),
            }
          : {
              label: t("dock.float"),
              run: () => {
                if (containerApi.hasMaximizedGroup())
                  containerApi.exitMaximizedGroup();
                containerApi.addFloatingGroup(panel, {
                  x: 60,
                  y: 60,
                  width: 420,
                  height: 340,
                });
              },
            },
      );
    items.push({
      label: singleton ? t("dock.hide") : t("dock.close"),
      run: () => actions.hide(panel.id),
    });
    return (
      <div className="panel-actions">
        <button
          type="button"
          disabled={floating}
          aria-pressed={maximized}
          aria-label={
            maximized
              ? t("dock.restoreView", { name: title })
              : t("dock.maximizeView", { name: title })
          }
          title={
            floating
              ? t("dock.dockToMaximize")
              : maximized
                ? t("dock.restoreLayout")
                : t("dock.maximizePanel")
          }
          onClick={toggleMaximize}
        >
          ⛶
        </button>
        <button
          type="button"
          aria-label={
            singleton
              ? t("workspace.hideView", { name: title })
              : t("dock.closeView", { name: title })
          }
          title={singleton ? t("dock.hideTitle") : t("dock.close")}
          onClick={() => actions.hide(panel.id)}
        >
          −
        </button>
        <PanelMenu title={title} items={items} />
      </div>
    );
  };
}

function Watermark() {
  const { t } = useTranslation("common");
  return (
    <div className="dock-watermark">
      <p>{t("dock.watermark")}</p>
    </div>
  );
}

function StatusBar({
  saved,
  open,
  onOverview,
  onReset,
}: {
  saved: boolean;
  open: number;
  onOverview: () => void;
  onReset: () => void;
}) {
  const n = useNetwork();
  const { t } = useTranslation("common");
  return (
    <div className="workspace-footer">
      <span className="mono muted">
        {[
          t("dock.status.mainnet"),
          t(`network.state.${n.state}`).toUpperCase(),
          t("dock.status.open", { count: open }),
          saved ? t("dock.status.saveOn") : t("dock.status.saveOff"),
        ].join(" · ")}
      </span>
      <button type="button" className="button ghost small" onClick={onOverview}>
        {t("dock.overview")}
      </button>
      <button type="button" className="button ghost small" onClick={onReset}>
        {t("workspace.reset")}
      </button>
    </div>
  );
}

function buildDefault(api: DockviewApi) {
  let previous: string | undefined;
  for (const { view } of defaultLayout) {
    api.addPanel({
      id: view,
      component: view,
      title: panelLabel(view),
      position: previous
        ? { referencePanel: previous, direction: "right" }
        : undefined,
    });
    previous = view;
  }
  const total = defaultLayout.reduce((sum, p) => sum + p.weight, 0);
  if (api.width > 0)
    for (const { view, weight } of defaultLayout.slice(0, -1))
      api
        .getPanel(view)
        ?.group.api.setSize({ width: (api.width * weight) / total });
  api.getPanel(defaultLayout[0].view)?.api.setActive();
}

const snapshotOf = (
  api: DockviewApi,
  hidden: WorkspaceView[],
): WorkspaceSnapshot => ({
  open: api.panels.map((p) => p.id),
  hidden,
  active: api.activePanel?.id,
});

export default function DockviewWorkspace({
  embedded = true,
  requested,
}: {
  embedded?: boolean;
  requested?: WorkspaceView;
}) {
  const { t } = useTranslation("common");
  const key = dockLayoutKey(embedded);
  const [saved] = useState(storageAvailable);
  const [store] = useState(() => new HostStore());
  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);
  const hiddenRef = useRef<WorkspaceView[]>([]);
  const restoreHints = useRef(new Map<WorkspaceView, string>());
  const subscriptions = useRef<{ dispose(): void }[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resetting = useRef(false);
  const resetEpoch = useRef(0);
  const unmounted = useRef(false);
  const [snap, setSnap] = useState<WorkspaceSnapshot>({ open: [], hidden: [] });
  // Views whose content is mounted (in the dock or hidden) and captured Block Detail params.
  const [mounted, setMounted] = useState<WorkspaceView[]>([]);
  const [blocks, setBlocks] = useState<Record<string, BlockPreview>>({});
  const [generation, setGeneration] = useState(0);

  const sync = useCallback(() => {
    const current = apiRef.current;
    if (!current) return;
    setSnap(snapshotOf(current, hiddenRef.current));
  }, []);
  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const current = apiRef.current;
      if (!current || unmounted.current || resetting.current) return;
      saveDockLayout(
        key,
        current.toJSON() as unknown as DockLayoutJSON,
        hiddenRef.current,
      );
    }, 200);
  }, [key]);
  const track = useCallback((id: string, params: unknown) => {
    if (isWorkspaceView(id))
      setMounted((old) => (old.includes(id) ? old : [...old, id]));
    else if (isBlockPreview(params))
      setBlocks((old) => (old[id] ? old : { ...old, [id]: params }));
  }, []);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      clearTimeout(saveTimer.current);
      subscriptions.current.forEach((s) => s.dispose());
      subscriptions.current = [];
      apiRef.current = null;
    };
  }, []);

  const onReady = useCallback(
    ({ api: next }: DockviewReadyEvent) => {
      subscriptions.current.forEach((s) => s.dispose());
      apiRef.current = next;
      const stored = loadDockLayout(key, {
        allowFloating: floatingAllowed(embedded),
      });
      let loaded = false;
      if (stored) {
        try {
          next.fromJSON(stored.layout as unknown as SerializedDockview);
          hiddenRef.current = [...stored.hidden];
          loaded = true;
        } catch {
          // dockview refused a document that passed validation: recover with the default.
          clearDockLayout(key);
          next.clear();
        }
      }
      if (!loaded) {
        hiddenRef.current = [];
        buildDefault(next);
      }
      setMounted([
        ...new Set([
          ...next.panels.map((p) => p.id).filter(isWorkspaceView),
          ...hiddenRef.current,
        ]),
      ]);
      setBlocks(
        Object.fromEntries(
          next.panels
            .filter((p) => !isWorkspaceView(p.id) && isBlockPreview(p.params))
            .map((p) => [p.id, p.params as unknown as BlockPreview]),
        ),
      );
      subscriptions.current = [
        next.onDidAddPanel((p) => {
          track(p.id, p.params);
          sync();
        }),
        next.onDidRemovePanel((p) => {
          // Moves between groups/floating can remove and re-add a panel; decide afterwards.
          const epoch = resetEpoch.current;
          setTimeout(() => {
            if (apiRef.current !== next || unmounted.current) return;
            if (epoch !== resetEpoch.current || next.getPanel(p.id))
              return sync();
            if (isWorkspaceView(p.id)) {
              hiddenRef.current = withHidden(hiddenRef.current, p.id);
            } else {
              setBlocks((old) => {
                const copy = { ...old };
                delete copy[p.id];
                return copy;
              });
              store.delete(p.id);
            }
            sync();
            scheduleSave();
          });
        }),
        next.onDidActivePanelChange(sync),
        next.onDidLayoutChange(scheduleSave),
      ];
      sync();
      scheduleSave();
      setApi(next);
    },
    [embedded, key, scheduleSave, store, sync, track],
  );

  const reveal = useCallback((id: string) => {
    const current = apiRef.current;
    const panel = current?.getPanel(id);
    if (!current || !panel) return;
    if (current.hasMaximizedGroup() && !panel.group.api.isMaximized())
      current.exitMaximizedGroup();
    panel.api.setActive();
  }, []);

  const open = useCallback(
    (name: WorkspaceView) => {
      const current = apiRef.current;
      if (!current) return;
      const plan = planOpen(name, snapshotOf(current, hiddenRef.current));
      if (plan === "focus") return reveal(name);
      if (current.hasMaximizedGroup()) current.exitMaximizedGroup();
      const hint = restoreHints.current.get(name);
      const group =
        (hint && current.getGroup(hint) ? hint : undefined) ??
        current.activeGroup?.id;
      if (plan === "restore")
        hiddenRef.current = withoutHidden(hiddenRef.current, name);
      current.addPanel({
        id: name,
        component: name,
        title: panelLabel(name),
        position: group
          ? { referenceGroup: group, direction: "within" }
          : undefined,
      });
      reveal(name);
      sync();
    },
    [reveal, sync],
  );

  const openBlock = useCallback(
    (block: BlockPreview) => {
      const current = apiRef.current;
      if (!current) return;
      const { id, plan, groupWith } = planOpenBlock(
        block.hash,
        snapshotOf(current, hiddenRef.current),
      );
      if (plan === "add") {
        if (current.hasMaximizedGroup()) current.exitMaximizedGroup();
        const group = current.activeGroup?.id;
        current.addPanel({
          id,
          component: BLOCK_DETAIL,
          title: panelLabel(id, block),
          params: { ...block },
          position: groupWith
            ? { referencePanel: groupWith, direction: "within" }
            : group
              ? { referenceGroup: group, direction: "within" }
              : undefined,
        });
      }
      reveal(id);
    },
    [reveal],
  );

  const [actions] = useState<Actions>(() => ({
    hide: () => {},
  }));
  actions.hide = (id: string) => {
    const current = apiRef.current;
    const panel = current?.getPanel(id);
    if (!current || !panel) return;
    if (isWorkspaceView(id)) {
      restoreHints.current.set(id, panel.group.id);
      hiddenRef.current = withHidden(hiddenRef.current, id);
    }
    current.removePanel(panel);
    sync();
    scheduleSave();
  };

  const overview = () => {
    const current = apiRef.current;
    if (current?.hasMaximizedGroup()) current.exitMaximizedGroup();
  };
  const reset = () => {
    const current = apiRef.current;
    if (!current) return;
    resetting.current = true;
    resetEpoch.current++;
    clearTimeout(saveTimer.current);
    clearDockLayout(key);
    current.clear();
    for (const id of Object.keys(blocks)) store.delete(id);
    hiddenRef.current = [];
    restoreHints.current.clear();
    setBlocks({});
    setMounted([]);
    setGeneration((g) => g + 1); // remount view content: reset drops preview state too
    buildDefault(current);
    resetting.current = false;
    sync();
  };

  useEffect(() => {
    if (api && requested) open(requested);
  }, [api, requested, open]);

  const [components] = useState(() => makeComponents(store));
  const [tab] = useState(() => makeTab(actions));
  const [headerActions] = useState(() => makeHeaderActions(embedded, actions));

  return (
    <PreviewContext.Provider value={{ open, openBlock }}>
      <div className={`workspace-v2 ${embedded ? "embedded" : "full"}`}>
        <Launcher onOpen={open} state={(name) => launcherState(name, snap)} />
        <div
          className="dock-shell"
          role="region"
          aria-label={t("dock.region")}
          onKeyDown={(e) => onTabKeyDown(e, reveal)}
        >
          <DockviewReact
            {...dockviewOptions(embedded)}
            components={components}
            defaultTabComponent={tab}
            rightHeaderActionsComponent={headerActions}
            watermarkComponent={Watermark}
            onReady={onReady}
          />
        </div>
      </div>
      <StatusBar
        saved={saved}
        open={snap.open.length}
        onOverview={overview}
        onReset={reset}
      />
      {mounted.map((name) => {
        const Content = views[name];
        return createPortal(
          <Content />,
          store.get(name),
          `${generation}-${name}`,
        );
      })}
      {Object.entries(blocks).map(([id, block]) =>
        createPortal(
          <BlockDetail block={block} />,
          store.get(id),
          `${generation}-${id}`,
        ),
      )}
    </PreviewContext.Provider>
  );
}
