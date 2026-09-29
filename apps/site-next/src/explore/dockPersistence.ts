// Layout persistence for the dockview desktop workspace (DockviewWorkspace.tsx).
//
// Stored document: { schema: "rougechain-dockview", version: 1, layout, hidden }
//   layout — dockview's own SerializedDockview (api.toJSON()), validated here before
//            api.fromJSON() ever sees it;
//   hidden — singleton views the user hid (restorable from the launcher).
// Keys are new and versioned; the Trellis-era keys (rougechain-poc-*-layout-v1/v2) are never read,
// written or removed. Only layout geometry, view ids and captured Block Detail params are stored:
// no preview inputs, wallet data or anything sensitive.
import type { BlockPreview } from "./PreviewContext";
import { workspaceViews, type WorkspaceView } from "./model";

export const DOCK_LAYOUT_SCHEMA = "rougechain-dockview";
export const DOCK_LAYOUT_VERSION = 1;
export const BLOCK_DETAIL = "BlockDetail";
/** Stored documents larger than this are discarded (quota guard). */
export const MAX_LAYOUT_BYTES = 256 * 1024;
/** Upper bound on persisted Block Detail windows. */
export const MAX_BLOCK_DETAILS = 50;
const MAX_DEPTH = 30;

export const dockLayoutKey = (embedded = false) =>
  embedded
    ? "rougechain-dockview-embed-layout-v1"
    : "rougechain-dockview-workspace-layout-v1";

export const blockPanelId = (hash: string) => `block-${hash}`;

export interface StoredDockLayout {
  schema: typeof DOCK_LAYOUT_SCHEMA;
  version: typeof DOCK_LAYOUT_VERSION;
  /** dockview SerializedDockview. Typed loosely here so this module stays dockview-free. */
  layout: DockLayoutJSON;
  hidden: WorkspaceView[];
}
export interface DockLayoutJSON {
  grid: {
    root: unknown;
    width: number;
    height: number;
    orientation: string;
  };
  panels: Record<string, unknown>;
  activeGroup?: string;
  floatingGroups?: unknown[];
  popoutGroups?: unknown[];
  edgeGroups?: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export const isWorkspaceView = (v: unknown): v is WorkspaceView =>
  workspaceViews.includes(v as WorkspaceView);

export function isBlockPreview(p: unknown): p is BlockPreview {
  return (
    isObj(p) &&
    typeof p.hash === "string" &&
    p.hash.length > 0 &&
    p.hash.length <= 256 &&
    typeof p.provenance === "string" &&
    isFiniteNum(p.height) &&
    isFiniteNum(p.transactions) &&
    isFiniteNum(p.timestamp) &&
    !Number.isNaN(new Date(p.timestamp).getTime())
  );
}

/** A dockview group record: { id, views: panelIds, activeView? }. Collects referenced panel ids. */
function validGroup(data: unknown, refs: string[]): boolean {
  if (!isObj(data) || typeof data.id !== "string") return false;
  if (
    !Array.isArray(data.views) ||
    !data.views.every((v) => typeof v === "string")
  )
    return false;
  if (
    data.activeView !== undefined &&
    !(data.views as string[]).includes(data.activeView as string)
  )
    return false;
  refs.push(...(data.views as string[]));
  return true;
}
/** A dockview grid node: leaf (a group) or branch (a split of child nodes). */
function validNode(node: unknown, refs: string[], depth = 0): boolean {
  if (!isObj(node) || depth > MAX_DEPTH) return false;
  if (node.size !== undefined && !(isFiniteNum(node.size) && node.size >= 0))
    return false;
  if (node.type === "leaf") return validGroup(node.data, refs);
  if (node.type === "branch")
    return (
      Array.isArray(node.data) &&
      node.data.every((child) => validNode(child, refs, depth + 1))
    );
  return false;
}
function validBox(box: unknown): boolean {
  return (
    isObj(box) &&
    Object.values(box).every((v) => v === undefined || isFiniteNum(v))
  );
}

/**
 * Validates a parsed stored document. Returns it (typed) when it is safe to hand to dockview's
 * fromJSON, or null when it must be discarded. Rejects: wrong schema/version, malformed grid
 * trees, unknown components, duplicate singletons (a singleton id that is not its own view name,
 * a panel referenced by two groups, or a view both open and hidden), panels without a group,
 * invalid Block Detail params, popout/edge groups, and floating groups when floating is off.
 */
export function validateDockLayout(
  doc: unknown,
  { allowFloating }: { allowFloating: boolean },
): StoredDockLayout | null {
  if (
    !isObj(doc) ||
    doc.schema !== DOCK_LAYOUT_SCHEMA ||
    doc.version !== DOCK_LAYOUT_VERSION ||
    !isObj(doc.layout) ||
    !Array.isArray(doc.hidden)
  )
    return null;
  const layout = doc.layout;
  const grid = layout.grid;
  if (
    !isObj(grid) ||
    !["HORIZONTAL", "VERTICAL"].includes(grid.orientation as string) ||
    !isFiniteNum(grid.width) ||
    !isFiniteNum(grid.height) ||
    !isObj(layout.panels)
  )
    return null;
  const refs: string[] = [];
  if (!validNode(grid.root, refs)) return null;

  const floating = layout.floatingGroups ?? [];
  if (!Array.isArray(floating)) return null;
  if (floating.length > 0 && !allowFloating) return null;
  for (const f of floating) {
    if (!isObj(f) || !validBox(f.position)) return null;
    if (f.data !== undefined) {
      if (!validGroup(f.data, refs)) return null;
    } else if (!isObj(f.grid) || !validNode(f.grid.root, refs)) return null;
  }
  if (
    (layout.popoutGroups !== undefined &&
      !(
        Array.isArray(layout.popoutGroups) && layout.popoutGroups.length === 0
      )) ||
    (layout.edgeGroups !== undefined &&
      !(
        isObj(layout.edgeGroups) && Object.keys(layout.edgeGroups).length === 0
      ))
  )
    return null;

  const panelIds = Object.keys(layout.panels);
  let blocks = 0;
  for (const id of panelIds) {
    const panel = layout.panels[id];
    if (!isObj(panel) || panel.id !== id) return null;
    const component = panel.contentComponent;
    if (component === BLOCK_DETAIL) {
      if (
        !isBlockPreview(panel.params) ||
        id !== blockPanelId(panel.params.hash)
      )
        return null;
      blocks++;
    } else if (!isWorkspaceView(component) || id !== component) {
      // Singleton panels are keyed by their view name, so a second record of the same view
      // necessarily has a different id and is rejected here.
      return null;
    }
  }
  if (blocks > MAX_BLOCK_DETAILS) return null;
  // Every panel appears in exactly one group, and every group entry is a known panel.
  if (
    refs.length !== panelIds.length ||
    new Set(refs).size !== refs.length ||
    refs.some((r) => !(r in (layout.panels as Obj)))
  )
    return null;

  const hidden = doc.hidden;
  if (
    !hidden.every(isWorkspaceView) ||
    new Set(hidden).size !== hidden.length ||
    hidden.some((h) => panelIds.includes(h))
  )
    return null;
  return doc as unknown as StoredDockLayout;
}

/** Reads and validates the stored layout; invalid or unreadable documents are removed. */
export function loadDockLayout(
  key: string,
  opts: { allowFloating: boolean },
): StoredDockLayout | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null; // Storage unavailable: start from the default layout.
  }
  if (!raw) return null;
  let doc: StoredDockLayout | null = null;
  try {
    if (raw.length <= MAX_LAYOUT_BYTES)
      doc = validateDockLayout(JSON.parse(raw), opts);
  } catch {
    doc = null;
  }
  if (!doc) clearDockLayout(key);
  return doc;
}

export function saveDockLayout(
  key: string,
  layout: DockLayoutJSON,
  hidden: WorkspaceView[],
): boolean {
  const doc: StoredDockLayout = {
    schema: DOCK_LAYOUT_SCHEMA,
    version: DOCK_LAYOUT_VERSION,
    layout,
    hidden,
  };
  try {
    const raw = JSON.stringify(doc);
    if (raw.length > MAX_LAYOUT_BYTES) return false;
    window.localStorage.setItem(key, raw);
    return true;
  } catch {
    return false; // Quota exceeded or storage blocked: the layout simply is not saved.
  }
}

export function clearDockLayout(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}

export function storageAvailable(): boolean {
  try {
    window.localStorage.setItem("rougechain-dockview-storage-check", "1");
    window.localStorage.removeItem("rougechain-dockview-storage-check");
    return true;
  } catch {
    return false;
  }
}
