import type { ReactNode } from "react";

export type IconName =
  | "files" | "build" | "deploy" | "chain" | "book" | "plus" | "folder" | "chevron" | "chevronDown" | "play" | "check"
  | "zoomIn" | "zoomOut" | "x" | "trash" | "terminal" | "globe" | "layoutSide" | "layoutBottom" | "github"
  | "filePlus" | "folderPlus" | "upload" | "download" | "pencil" | "more" | "reset" | "chevronRight";

const ICONS: Record<IconName, ReactNode> = {
  filePlus: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14h6" />
    </>
  ),
  folderPlus: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  reset: <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />,
  chevronRight: <path d="M10 7l5 5-5 5" />,
  files: (
    <>
      <path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
      <path d="M15 3v4h4M3 8v11a2 2 0 0 0 2 2h9" />
    </>
  ),
  build: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.4-.4-2.6z" />,
  deploy: (
    <>
      <path d="M12 3l8 9-8 9-8-9z" />
      <path d="M12 8v8M9 13l3 3 3-3" />
    </>
  ),
  chain: (
    <>
      <path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z" />
      <path d="M12 21.5V12M20.5 7.25L12 12 3.5 7.25" />
    </>
  ),
  book: (
    <>
      <path d="M4 4.5h5.5A2.5 2.5 0 0 1 12 7v13a2 2 0 0 0-2-2H4z" />
      <path d="M20 4.5h-5.5A2.5 2.5 0 0 0 12 7v13a2 2 0 0 1 2-2h6z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  chevronDown: <path d="M7 10l5 5 5-5" />,
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5M8 11h6M11 8v6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5M8 11h6" />
    </>
  ),
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />,
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15H17" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.5 5.2 3.5 8.5s-1 6.1-3.5 8.5c-2.5-2.4-3.5-5.2-3.5-8.5s1-6.1 3.5-8.5z" />
    </>
  ),
  layoutSide: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M9 4.5v15" />
    </>
  ),
  layoutBottom: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 14.5h18" />
    </>
  ),
  github: (
    <path d="M9 19c-4.5 1.4-4.5-2.5-6.5-3m13 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C7 2.8 5.9 3.1 5.9 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.5 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ide-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
