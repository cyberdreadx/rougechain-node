/**
 * IDE workspaces: one per template, a flat map of path → text plus the empty folders the user made.
 * Stored in this browser only. A workspace that was never touched is the template itself.
 */
import type { Template } from "./templates";

export interface Workspace {
  files: Record<string, string>;
  /** Folders with no files in them yet (folders holding files are implied by the paths). */
  folders: string[];
}

export interface TreeNode {
  name: string;
  path: string;
  folder: boolean;
  children: TreeNode[];
}

const KEY = "rougechain-ide-workspaces-v1";
/** Earlier versions saved only edits to template files, keyed "templateId/path". */
const LEGACY_EDITS_KEY = "rougechain-ide-edits-v1";

export const MAX_FILE_BYTES = 256 * 1024;

export function loadWorkspaces(): Record<string, Workspace> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, Workspace>;
  } catch {
    return {};
  }
}

export function saveWorkspaces(all: Record<string, Workspace>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable or full: the workspace lives for this visit only */
  }
}

function legacyEdits(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(LEGACY_EDITS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function fromTemplate(t: Template): Workspace {
  const old = legacyEdits();
  const files: Record<string, string> = {};
  for (const f of t.files) files[f.path] = old[`${t.id}/${f.path}`] ?? f.content;
  return { files, folders: [] };
}

/** The file a workspace opens with: its lib.rs if it still has one. */
export function mainFile(ws: Workspace): string | undefined {
  const paths = Object.keys(ws.files);
  return paths.find((p) => p === "src/lib.rs") ?? paths.find((p) => p.endsWith(".rs")) ?? paths[0];
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function allFolders(ws: Workspace): Set<string> {
  const out = new Set<string>();
  const add = (p: string) => {
    for (let d = p; d; d = parentOf(d)) out.add(d);
  };
  for (const p of Object.keys(ws.files)) add(parentOf(p));
  for (const f of ws.folders) add(f);
  return out;
}

export function exists(ws: Workspace, path: string): boolean {
  return path in ws.files || allFolders(ws).has(path);
}

export function isFolder(ws: Workspace, path: string): boolean {
  return allFolders(ws).has(path);
}

/** A problem with a new name for something inside `dir`, or null if it is fine. */
export function nameProblem(ws: Workspace, dir: string, name: string, current?: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > 80) return "Keep names under 80 characters.";
  if (!/^[A-Za-z0-9._-]+$/.test(n)) return "Use letters, digits, dot, dash or underscore.";
  if (n === "." || n === "..") return "That name is reserved.";
  const path = join(dir, n);
  if (path !== current && exists(ws, path)) return `${n} already exists here.`;
  return null;
}

export function addFile(ws: Workspace, path: string, content = ""): Workspace {
  return { files: { ...ws.files, [path]: content }, folders: ws.folders.filter((f) => f !== parentOf(path)) };
}

export function addFolder(ws: Workspace, path: string): Workspace {
  return { files: ws.files, folders: [...ws.folders.filter((f) => f !== path), path] };
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const moveTo = (p: string, from: string, to: string) => (p === from ? to : `${to}${p.slice(from.length)}`);

export function renamePath(ws: Workspace, from: string, to: string): Workspace {
  const files: Record<string, string> = {};
  for (const [p, c] of Object.entries(ws.files)) files[under(p, from) ? moveTo(p, from, to) : p] = c;
  return { files, folders: ws.folders.map((f) => (under(f, from) ? moveTo(f, from, to) : f)) };
}

export function deletePath(ws: Workspace, path: string): Workspace {
  const files: Record<string, string> = {};
  for (const [p, c] of Object.entries(ws.files)) if (!under(p, path)) files[p] = c;
  const folders = ws.folders.filter((f) => !under(f, path));
  // Keep the parent folder visible when its last item goes.
  const parent = parentOf(path);
  if (parent && !Object.keys(files).some((p) => under(p, parent)) && !folders.some((f) => under(f, parent))) folders.push(parent);
  return { files, folders };
}

/** Rename a path inside a list of open tabs (files under a renamed folder move with it). */
export function renameIn(paths: string[], from: string, to: string): string[] {
  return paths.map((p) => (under(p, from) ? moveTo(p, from, to) : p));
}

export function removeIn(paths: string[], path: string): string[] {
  return paths.filter((p) => !under(p, path));
}

/** Nested tree, folders first, then by name. */
export function buildTree(ws: Workspace): TreeNode[] {
  const root: TreeNode = { name: "", path: "", folder: true, children: [] };
  const nodes = new Map<string, TreeNode>([["", root]]);
  const folder = (path: string): TreeNode => {
    const hit = nodes.get(path);
    if (hit) return hit;
    const node: TreeNode = { name: path.split("/").pop()!, path, folder: true, children: [] };
    nodes.set(path, node);
    folder(parentOf(path)).children.push(node);
    return node;
  };
  for (const f of allFolders(ws)) folder(f);
  for (const p of Object.keys(ws.files)) folder(parentOf(p)).children.push({ name: p.split("/").pop()!, path: p, folder: false, children: [] });
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}
