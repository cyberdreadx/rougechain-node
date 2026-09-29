import { apps } from "../ecosystem/apps";
export const workspaceViews = [
  "Network",
  "Explorer",
  "Ecosystem",
  "Wallet",
  "Swap",
  "Bridge",
  "Messenger",
  "Mail",
  "Validators",
  "Build",
  "Security",
] as const;
export type WorkspaceView = (typeof workspaceViews)[number];
export const defaultViews: WorkspaceView[] = [
  "Network",
  "Explorer",
  "Ecosystem",
];
export const launcherGroups = [
  { name: "Network", views: ["Network", "Explorer", "Validators", "Security"] },
  { name: "Use", views: ["Wallet", "Messenger", "Mail", "Ecosystem"] },
  { name: "Trade", views: ["Swap", "Bridge"] },
  { name: "Build", views: ["Build"] },
] as const;
export function resolveWorkspaceView(
  id: string | null,
): WorkspaceView | undefined {
  const name = apps.find((a) => a.id === id)?.workspaceView;
  return workspaceViews.find((v) => v === name || v.toLowerCase() === id);
}
export const workspaceKey = (embedded = false) =>
  embedded
    ? "rougechain-poc-embed-layout-v2"
    : "rougechain-poc-workspace-layout-v2";
export function prepareV2Layout(key: string) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const doc = JSON.parse(raw);
    if (
      doc.schema !== 1 ||
      doc.version !== 2 ||
      !doc.views ||
      typeof doc.views !== "object" ||
      Array.isArray(doc.views) ||
      !(doc.root === null || typeof doc.root === "object")
    )
      throw Error("Invalid layout");
    const validNode = (
      node: Record<string, unknown> | null,
      depth = 0,
    ): boolean => {
      if (node === null) return true;
      if (
        !node ||
        typeof node !== "object" ||
        typeof node.id !== "string" ||
        depth > 30
      )
        return false;
      if (node.kind === "panel")
        return (
          Array.isArray(node.views) &&
          node.views.every((id) => typeof id === "string" && doc.views[id]) &&
          typeof node.selected === "string"
        );
      if (node.kind === "split")
        return (
          ["x", "y"].includes(String(node.axis)) &&
          Array.isArray(node.children) &&
          node.children.every((n) => validNode(n, depth + 1)) &&
          Array.isArray(node.weights) &&
          node.weights.every(
            (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
          )
        );
      if (node.kind === "stage")
        return (
          !node.child ||
          validNode(node.child as Record<string, unknown>, depth + 1)
        );
      return false;
    };
    if (
      !validNode(doc.root) ||
      !Array.isArray(doc.floating) ||
      !Array.isArray(doc.hidden) ||
      doc.floating.some(
        (f: { panel: Record<string, unknown> }) => !validNode(f?.panel),
      ) ||
      doc.hidden.some(
        (h: { panel: Record<string, unknown> }) => !validNode(h?.panel),
      )
    )
      throw Error("Invalid tree");
    for (const record of Object.values(doc.views) as {
      type: string;
      params?: Record<string, unknown>;
    }[]) {
      if (record.type === "BlockDetail") {
        const p = record.params;
        if (
          !p ||
          typeof p.hash !== "string" ||
          typeof p.provenance !== "string" ||
          typeof p.height !== "number" ||
          typeof p.transactions !== "number" ||
          typeof p.timestamp !== "number" ||
          !Number.isFinite(p.timestamp) ||
          Number.isNaN(new Date(p.timestamp).getTime())
        )
          throw Error("Invalid block");
      }
    }
    const types = Object.values(doc.views).map(
      (v) => (v as { type?: string })?.type,
    );
    if (
      types.some(
        (t) =>
          t !== "BlockDetail" && !workspaceViews.includes(t as WorkspaceView),
      ) ||
      workspaceViews.some((t) => types.filter((v) => v === t).length > 1)
    )
      throw Error("Invalid views");
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* Optional storage. */
    }
  }
}
