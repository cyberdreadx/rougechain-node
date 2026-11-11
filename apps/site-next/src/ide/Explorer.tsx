/**
 * File explorer for the IDE workspace (Remix / VS Code style): collapsible folders, new file and
 * folder, rename, delete, upload and download, from the toolbar, a right-click menu, the "…"
 * button on each row, or the keyboard (F2 rename, Delete).
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import { buildTree, isFolder, join, MAX_FILE_BYTES, nameProblem, parentOf, type TreeNode, type Workspace } from "./workspace";

type Draft = { kind: "file" | "folder"; dir: string } | { kind: "rename"; path: string };

interface Menu {
  x: number;
  y: number;
  /** "" is the workspace root. */
  path: string;
  folder: boolean;
}

export function FileGlyph({ path }: { path: string }) {
  const ext = path.split(".").pop() ?? "";
  const kind = ext === "rs" ? "rs" : ext === "toml" ? "toml" : ext === "wasm" ? "wasm" : ext === "md" ? "md" : "txt";
  return (
    <span className={`ide-glyph ${kind}`} aria-hidden="true">
      {kind === "rs" ? "rs" : kind === "toml" ? "{}" : kind === "wasm" ? "wa" : kind === "md" ? "M↓" : "·"}
    </span>
  );
}

export function Explorer({
  ws,
  name,
  active,
  isEdited,
  isTemplateWorkspace,
  artifact,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onDownload,
  onReset,
  onArtifact,
  onError,
}: {
  ws: Workspace;
  /** Workspace folder name (the template's directory). */
  name: string;
  active: string | null;
  isEdited: (path: string) => boolean;
  /** True while the workspace is still exactly the template (nothing to reset). */
  isTemplateWorkspace: boolean;
  artifact: string;
  onOpen: (path: string) => void;
  onCreate: (path: string, folder: boolean, content?: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  onDownload: (path: string) => void;
  onReset: () => void;
  onArtifact: () => void;
  onError: (message: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>(active ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const uploadDir = useRef("");
  const tree = buildTree(ws);

  useEffect(() => {
    if (active) setSelected(active);
  }, [active]);

  /** Folder that new items go into: the selected folder, or the selected file's folder. */
  const targetDir = (path = selected) => (path === "" || isFolder(ws, path) ? path : parentOf(path));

  function startNew(kind: "file" | "folder", dir = targetDir()) {
    setMenu(null);
    setCollapsed((c) => {
      const next = new Set(c);
      for (let d = dir; ; d = parentOf(d)) {
        next.delete(d);
        if (!d) break;
      }
      return next;
    });
    setDraft({ kind, dir });
  }

  function commit(value: string, blur = false) {
    if (!draft) return;
    const fail = (problem: string) => {
      onError(problem);
      // Leaving the field with a bad name cancels; Enter keeps it open to fix.
      if (blur) setDraft(null);
    };
    const d = draft;
    if (d.kind === "rename") {
      const dir = parentOf(d.path);
      const to = join(dir, value.trim());
      if (to === d.path || !value.trim()) return setDraft(null);
      const problem = nameProblem(ws, dir, value, d.path);
      if (problem) return fail(problem);
      setDraft(null);
      onRename(d.path, to);
      setSelected(to);
      return;
    }
    if (!value.trim()) return setDraft(null);
    const problem = nameProblem(ws, d.dir, value);
    if (problem) return fail(problem);
    const path = join(d.dir, value.trim());
    setDraft(null);
    onCreate(path, d.kind === "folder");
    setSelected(path);
  }

  function remove(path: string) {
    setMenu(null);
    const folder = isFolder(ws, path);
    const ok = window.confirm(folder ? `Delete the folder ${path} and everything in it?` : `Delete ${path}?`);
    if (ok) onDelete(path);
  }

  function openMenu(e: MouseEvent, path: string, folder: boolean) {
    e.preventDefault();
    e.stopPropagation();
    setSelected(path);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Mouse: at the pointer. Keyboard (ContextMenu key) or the "…" button: under the row.
    const x = e.clientX || r.right - 8;
    const y = e.clientY || r.bottom;
    setMenu({ x: Math.min(x, window.innerWidth - 210), y: Math.min(y, window.innerHeight - 260), path, folder });
  }

  function onRowKey(e: KeyboardEvent, path: string) {
    if (e.key === "F2") {
      e.preventDefault();
      setDraft({ kind: "rename", path });
    } else if (e.key === "Delete") {
      e.preventDefault();
      remove(path);
    }
  }

  async function onUpload(list: FileList | null) {
    if (!list) return;
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_BYTES) {
        onError(`${f.name} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
        continue;
      }
      const problem = nameProblem(ws, uploadDir.current, f.name);
      if (problem) {
        onError(problem);
        continue;
      }
      onCreate(join(uploadDir.current, f.name), false, await f.text());
    }
    if (upload.current) upload.current.value = "";
  }

  function startUpload(dir = targetDir()) {
    setMenu(null);
    uploadDir.current = dir;
    upload.current?.click();
  }

  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  function draftRow(dir: string, depth: number): ReactNode {
    if (!draft || draft.kind === "rename" || draft.dir !== dir) return null;
    return (
      <li role="none">
        <div className="ide-tree-row editing" style={{ "--depth": depth } as CSSProperties}>
          {draft.kind === "folder" ? <Icon name="folder" /> : <FileGlyph path="new.rs" />}
          <NameInput label={draft.kind === "folder" ? "New folder name" : "New file name"} initial="" onCommit={commit} onCancel={() => setDraft(null)} />
        </div>
      </li>
    );
  }

  function rows(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((n) => {
      const renaming = draft?.kind === "rename" && draft.path === n.path;
      const open = !collapsed.has(n.path);
      const row = renaming ? (
        <div className="ide-tree-row editing" style={{ "--depth": depth } as CSSProperties}>
          {n.folder ? <Icon name="folder" /> : <FileGlyph path={n.path} />}
          <NameInput label={`Rename ${n.name}`} initial={n.name} onCommit={commit} onCancel={() => setDraft(null)} />
        </div>
      ) : (
        <div className={`ide-tree-item${selected === n.path ? " selected" : ""}`}>
          <button
            type="button"
            className={`ide-tree-row${active === n.path ? " on" : ""}`}
            style={{ "--depth": depth } as CSSProperties}
            aria-expanded={n.folder ? open : undefined}
            onClick={() => {
              setSelected(n.path);
              if (n.folder) toggle(n.path);
              else onOpen(n.path);
            }}
            onContextMenu={(e) => openMenu(e, n.path, n.folder)}
            onKeyDown={(e) => onRowKey(e, n.path)}
          >
            {n.folder ? (
              <>
                <Icon name={open ? "chevron" : "chevronRight"} />
                <Icon name="folder" />
              </>
            ) : (
              <FileGlyph path={n.path} />
            )}
            <span className="ide-tree-name">{n.name}</span>
            {!n.folder && isEdited(n.path) ? <span className="ide-dot" aria-label="edited" /> : null}
          </button>
          <button type="button" className="ide-tree-more" aria-label={`Actions for ${n.name}`} title="Actions" onClick={(e) => openMenu(e, n.path, n.folder)}>
            <Icon name="more" />
          </button>
        </div>
      );
      return (
        <li key={n.path} role="treeitem" aria-expanded={n.folder ? open : undefined} aria-selected={selected === n.path} aria-label={n.name}>
          {row}
          {n.folder && open && (
            <ul role="group">
              {draftRow(n.path, depth + 1)}
              {rows(n.children, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  const rootOpen = !collapsed.has("");

  return (
    <div className="ide-explorer">
      <div className="ide-explorer-tools" role="toolbar" aria-label="File actions">
        <button type="button" className="ide-icon-btn" title="New file" aria-label="New file" onClick={() => startNew("file")}>
          <Icon name="filePlus" />
        </button>
        <button type="button" className="ide-icon-btn" title="New folder" aria-label="New folder" onClick={() => startNew("folder")}>
          <Icon name="folderPlus" />
        </button>
        <button type="button" className="ide-icon-btn" title="Upload files (.rs, .toml, .md…)" aria-label="Upload files" onClick={() => startUpload()}>
          <Icon name="upload" />
        </button>
        <span className="ide-tabs-fill" />
        <button type="button" className="ide-icon-btn" title="Reset workspace to the template" aria-label="Reset workspace" disabled={isTemplateWorkspace} onClick={() => window.confirm(`Reset ${name} to the original template? Your changes in this workspace are lost.`) && onReset()}>
          <Icon name="reset" />
        </button>
        <input ref={upload} type="file" multiple hidden accept=".rs,.toml,.md,.txt,.json,.lock" onChange={(e) => void onUpload(e.target.files)} />
      </div>

      <ul className="ide-tree" role="tree" aria-label="Workspace files" onContextMenu={(e) => e.target === e.currentTarget && openMenu(e, "", true)}>
        <li role="treeitem" aria-expanded={rootOpen} aria-selected={selected === ""} aria-label={name}>
          <div className={`ide-tree-item${selected === "" ? " selected" : ""}`}>
            <button
              type="button"
              className="ide-tree-row root"
              style={{ "--depth": 0 } as CSSProperties}
              aria-expanded={rootOpen}
              onClick={() => {
                setSelected("");
                toggle("");
              }}
              onContextMenu={(e) => openMenu(e, "", true)}
            >
              <Icon name={rootOpen ? "chevron" : "chevronRight"} />
              <Icon name="folder" />
              <span className="ide-tree-name">{name}</span>
            </button>
            <button type="button" className="ide-tree-more" aria-label={`Actions for ${name}`} title="Actions" onClick={(e) => openMenu(e, "", true)}>
              <Icon name="more" />
            </button>
          </div>
          {rootOpen && (
            <ul role="group">
              {draftRow("", 1)}
              {rows(tree, 1)}
              <li role="none">
                <button type="button" className="ide-tree-row" style={{ "--depth": 1 } as CSSProperties} onClick={onArtifact} title="Prebuilt release build — open Build">
                  <FileGlyph path={artifact} /> <span className="ide-tree-name">{artifact}</span>
                  <span className="ide-chip">prebuilt</span>
                </button>
              </li>
            </ul>
          )}
        </li>
      </ul>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)}>
        {menu.folder && (
          <>
            <MenuItem icon="filePlus" label="New file" onClick={() => startNew("file", menu.path)} />
            <MenuItem icon="folderPlus" label="New folder" onClick={() => startNew("folder", menu.path)} />
            <MenuItem icon="upload" label="Upload files" onClick={() => startUpload(menu.path)} />
          </>
        )}
        {!menu.folder && <MenuItem icon="download" label="Download" onClick={() => (setMenu(null), onDownload(menu.path))} />}
        {menu.path !== "" && (
          <>
            <MenuItem icon="pencil" label="Rename" hint="F2" onClick={() => (setMenu(null), setDraft({ kind: "rename", path: menu.path }))} />
            <MenuItem icon="trash" label="Delete" hint="Del" danger onClick={() => remove(menu.path)} />
          </>
        )}
        {menu.path === "" && <MenuItem icon="reset" label="Reset to template" disabled={isTemplateWorkspace} onClick={() => (setMenu(null), window.confirm(`Reset ${name} to the original template? Your changes in this workspace are lost.`) && onReset())} />}
      </ContextMenu>}
    </div>
  );
}

function NameInput({ label, initial, onCommit, onCancel }: { label: string; initial: string; onCommit: (v: string, blur?: boolean) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, like an editor does.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={ref}
      className="ide-tree-input mono"
      aria-label={label}
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => {
        if (!done.current) onCommit(e.currentTarget.value, true);
      }}
    />
  );
}

function ContextMenu({ menu, onClose, children }: { menu: Menu; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="ide-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }}
    >
      {children}
    </div>
  );
}

function MenuItem({ icon, label, hint, danger, disabled, onClick }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; hint?: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={danger ? "danger" : undefined} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
      {hint ? <kbd>{hint}</kbd> : null}
    </button>
  );
}
