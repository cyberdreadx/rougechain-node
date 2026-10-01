// Pure window-lifecycle rules for the dockview workspace, kept free of dockview so they can be
// unit-tested. DockviewWorkspace.tsx turns these decisions into dockview API calls.
import { blockPanelId } from "./dockPersistence";
import type { WorkspaceView } from "./model";

export interface WorkspaceSnapshot {
  /** Ids of the panels currently in the dock (docked or floating). */
  open: readonly string[];
  /** Singleton views that were hidden (content kept mounted, restorable). */
  hidden: readonly WorkspaceView[];
  /** Id of the active (focused) panel. */
  active?: string;
}

export type LauncherState = "Not opened" | "Hidden" | "Focused" | "Open";

/** Launcher label for a singleton view. */
export function launcherState(
  name: WorkspaceView,
  snap: WorkspaceSnapshot,
): LauncherState {
  if (snap.hidden.includes(name)) return "Hidden";
  if (!snap.open.includes(name)) return "Not opened";
  return snap.active === name ? "Focused" : "Open";
}

/**
 * What opening a singleton view from the launcher (or a preview link) does:
 * - already in the dock → focus it (never a duplicate);
 * - hidden → restore it (same mounted content, so its state is kept);
 * - otherwise → add it as a new tab.
 */
export type OpenPlan = "focus" | "restore" | "add";
export function planOpen(
  name: WorkspaceView,
  snap: WorkspaceSnapshot,
): OpenPlan {
  if (snap.open.includes(name)) return "focus";
  if (snap.hidden.includes(name)) return "restore";
  return "add";
}

/** Block Detail windows are keyed by block hash: re-opening the same block focuses it. */
export function planOpenBlock(
  hash: string,
  snap: WorkspaceSnapshot,
): { id: string; plan: "focus" | "add"; groupWith?: "Explorer" } {
  const id = blockPanelId(hash);
  if (snap.open.includes(id)) return { id, plan: "focus" };
  return {
    id,
    plan: "add",
    groupWith: snap.open.includes("Explorer") ? "Explorer" : undefined,
  };
}

export const withHidden = (
  hidden: readonly WorkspaceView[],
  name: WorkspaceView,
) => (hidden.includes(name) ? [...hidden] : [...hidden, name]);
export const withoutHidden = (
  hidden: readonly WorkspaceView[],
  name: WorkspaceView,
) => hidden.filter((h) => h !== name);

/** Default layout: Network | Explorer | Ecosystem, weighted 1 : 1.4 : 1 like the approved design. */
export const defaultLayout: { view: WorkspaceView; weight: number }[] = [
  { view: "Network", weight: 1 },
  { view: "Explorer", weight: 1.4 },
  { view: "Ecosystem", weight: 1 },
];

/** Floating is only offered in the full /workspace, never in the homepage embed. */
export const floatingAllowed = (embedded: boolean) => !embedded;
