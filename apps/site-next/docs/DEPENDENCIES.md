# Dependencies

Verified 2026-09-29. Exact resolved versions are committed in package-lock.json.

## Trellis

- Official starting point: https://trellisui.com/
- The official site links https://github.com/DanFessler/trellis.
- React adapter: `@danfessler/trellis-react`, pinned **0.3.0**.
- Core: `@danfessler/trellis`, pinned **0.3.0**.
- Official instructions: https://github.com/DanFessler/trellis/blob/main/docs/quick-start-react.md and https://github.com/DanFessler/trellis/blob/main/docs/react-api.md.
- Integration: `Workspace`, singleton `ViewType`, `Split`, `View`; import `@danfessler/trellis/style.css`. React peer dependency >=18.3; selected React 19 satisfies it.
- Lazy desktop homepage and full workspace. Shared previews use a host callback context; phones, Simple view and error recovery use the functional CompactWorkspace.
- License: custom three-tier license, **not MIT**. Non-commercial use is free; commercial organizations with <=10 developers require applicable active GitHub sponsorship; larger organizations require enterprise licensing. Official terms: https://github.com/DanFessler/trellis/blob/main/LICENSE.md.
- User approved Trellis for this internal design demo. No sponsorship was purchased and no production license entitlement is asserted. Lead developer must resolve commercial licensing before production adoption.

## Core stack

Node >=20.19, npm workspaces; Vite 7, React 19, TypeScript 5.9, React Router 7, Tailwind 4, Framer Motion 12, Lucide React, TanStack Query 5. These preserve the requested Vite/React architecture; version alignment with the production application remains lead-developer work because its dependency manifest was outside the source-reference allowlist.

Space Grotesk and IBM Plex Mono are self-hosted through Fontsource (OFL font licenses in distributed packages). No external font request is necessary.

Vitest, Testing Library, jsdom, ESLint, TypeScript and Prettier provide verification and readable source. Vitest was upgraded from 3 to patched 4 after npm audit identified GHSA-82fw-gwwq-j7x9. No blockchain SDK, wallet provider, signing library or transaction client is installed.

## V2 official API verification

Rechecked official `docs/react-api.md`, `docs/core-api.md` and `docs/hiding.md` from DanFessler/trellis on 2026-09-29, then checked installed 0.3.0 declarations. No fork, undocumented engine-state access, replacement docking engine or new dependency was added.

- `WorkspaceProvider`, `useOptionalWorkspace`, `useWorkspaceState`: launcher outside workspace and snapshot-derived open/hidden/focused labels.
- `open(type, {reuse:'type', placement:'tab'})` plus singleton ViewTypes: open/focus/reveal hidden apps. Official `open` restores hidden singleton panels; no manual remount is used.
- `useView().hide()`: retain view state; the built-in panel menu hides an entire panel.
- `navigation.toggle(view.id)` and `navigation.overview()`: maximize/restore and overview. Floating panels cannot maximize, so that accessory is disabled while floating.
- `open('BlockDetail', {id, params, reuse:predicate, placement:{into:panelId}})`: keyed block instances, no singleton adaptation needed.
- Native menu dock/move/tab/float; `floating:'overlay'` only in full workspace, `false` in homepage embed.
- `storageKey`, `version:2`, `reset()`: separate V2 document persistence and recovery. Local storage availability is checked for truthful auto-save labeling.

The custom launcher is React UI over these APIs, not a replacement window manager. Compact mode implements a separate session-only tab presentation of the same preview components, intentionally without simulated docking geometry.
