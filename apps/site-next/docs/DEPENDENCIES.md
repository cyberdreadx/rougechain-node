# Dependencies

Verified 2026-09-29. Exact resolved versions are committed in package-lock.json.

## dockview (window workspace)

- Package: `dockview-react` pinned **8.3.1** (the React adapter; it pulls in `dockview` and
  `dockview-core` 8.3.1, both hoisted in package-lock.json). Added to `apps/site-next` only;
  `apps/web`'s resolved versions are unchanged.
- Licence: **MIT** (verified in the installed packages' `package.json` and `LICENCE.md`,
  "Copyright (c) 2021 mathuo"). Source: https://github.com/dockview/dockview.
- React peer range `^16.8 || ^17 || ^18 || ^19`; runs on this app's React 19.
- Why: free replacement for Trellis (commercial licence) with the same primitives — docking,
  tabs, split resize, drag and drop, floating groups, maximize, JSON serialization.
- Only the free MIT core is used. dockview 8 also ships paid modules in the separate
  `dockview-enterprise` package (keyboard navigation/docking, smart guides, layout history, pinned
  tabs, multi-row tabs, advanced overflow, auto-hide edge groups, DnD compass). None is installed or
  enabled; tab keyboard support (Enter/Space, arrows, Home/End) is implemented in
  `DockviewWorkspace.tsx`. Do not add `dockview-enterprise` without a licence decision.
- Loaded lazily (desktop only) with its stylesheet `dockview-react/dist/styles/dockview.css`,
  themed by `src/explore/dockview-theme.css`. Listed in `vite.config.ts` `resolve.dedupe` and the
  vitest `server.deps.inline` list.

## Trellis (removed)

Anders' POC used `@danfessler/trellis` / `@danfessler/trellis-react` 0.3.0 (custom three-tier
licence, not MIT; commercial use needs a paid GitHub sponsorship or enterprise licence). Removed on
2026-09-29 and replaced by dockview above. No Trellis source was copied into the dockview
implementation; only Anders' own integration code (launcher, views, previews, model) is reused.

## Core stack

Node >=20.19, npm workspaces; Vite 7, React 19, TypeScript 5.9, React Router 7, Tailwind 4, Framer Motion 12, Lucide React, TanStack Query 5. These preserve the requested Vite/React architecture; version alignment with the production application remains lead-developer work because its dependency manifest was outside the source-reference allowlist.

Space Grotesk and IBM Plex Mono are self-hosted through Fontsource (OFL font licenses in distributed packages). No external font request is necessary.

Vitest, Testing Library, jsdom, ESLint, TypeScript and Prettier provide verification and readable source. Vitest was upgraded from 3 to patched 4 after npm audit identified GHSA-82fw-gwwq-j7x9. No blockchain SDK, wallet provider, signing library or transaction client is installed.

## V2 official API verification (historical, Trellis)

Kept for reference; describes the removed Trellis integration.


Rechecked official `docs/react-api.md`, `docs/core-api.md` and `docs/hiding.md` from DanFessler/trellis on 2026-09-29, then checked installed 0.3.0 declarations. No fork, undocumented engine-state access, replacement docking engine or new dependency was added.

- `WorkspaceProvider`, `useOptionalWorkspace`, `useWorkspaceState`: launcher outside workspace and snapshot-derived open/hidden/focused labels.
- `open(type, {reuse:'type', placement:'tab'})` plus singleton ViewTypes: open/focus/reveal hidden apps. Official `open` restores hidden singleton panels; no manual remount is used.
- `useView().hide()`: retain view state; the built-in panel menu hides an entire panel.
- `navigation.toggle(view.id)` and `navigation.overview()`: maximize/restore and overview. Floating panels cannot maximize, so that accessory is disabled while floating.
- `open('BlockDetail', {id, params, reuse:predicate, placement:{into:panelId}})`: keyed block instances, no singleton adaptation needed.
- Native menu dock/move/tab/float; `floating:'overlay'` only in full workspace, `false` in homepage embed.
- `storageKey`, `version:2`, `reset()`: separate V2 document persistence and recovery. Local storage availability is checked for truthful auto-save labeling.

The custom launcher is React UI over these APIs, not a replacement window manager. Compact mode implements a separate session-only tab presentation of the same preview components, intentionally without simulated docking geometry.
