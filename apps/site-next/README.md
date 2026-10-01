# site-next — the new RougeChain frontend

Anders' approved design (massiveideaslabs/rougechain-frontend-poc, approved reference
https://rougechain-design-poc-545a5a1.netlify.app/), brought into this monorepo as-is so the real
product can be built into it. Until it reaches feature parity with `apps/web`, rougechain.io keeps
serving `apps/web`; this app deploys to a separate preview site.

- `src/` — his showcase app (homepage, Explorer, Swap, workspace, design system).
- `../../packages/brand`, `ui`, `chain-readonly` — his shared packages.
- `docs/` — his handoff docs (start with `docs/HANDOFF_INDEX.md`). They describe the target
  architecture; note the POC-only parts (DemoWalletProvider, synthetic quotes/transactions) are
  NOT to be kept — real features come from `apps/web` / shared code.

Commands (from the repo root): `npm run dev:next`, `npm run build:next`, `npm run test:next`.

Stack: React 19, Vite 7, Tailwind 4, React Router 7 — newer than `apps/web` (React 18, Tailwind 3,
Router 6) in the same npm workspace. `vite.config.ts` (`resolve.dedupe`) and `vitest.config.ts`
(aliases) keep exactly one React 19 in this app's bundle and tests.

Window workspace: Anders' POC used Trellis for the draggable window workspace; it was removed on
2026-09-29 because of its commercial licence ($100/month studio sponsorship + attribution) and
rebuilt on **dockview** (`dockview-react`, MIT, free core only — no `dockview-enterprise`).
`src/explore/DockviewWorkspace.tsx` reimplements his behaviour (see
`docs/TRELLIS_WORKSPACE_ARCHITECTURE.md`): default Network / Explorer / Ecosystem panes, launcher
open/focus/restore, hide that keeps view state, keyed Block Detail windows grouped with Explorer,
maximize/overview, a "…" panel menu (move to new column, float/dock, open full app, hide),
floating only in the full /workspace, and validated layout persistence
(`src/explore/dockPersistence.ts`, keys `rougechain-dockview-{embed,workspace}-layout-v1`, reset via
"Reset workspace"). It is lazy-loaded on desktop (>= 900px) only; phones, "Simple view" and any
load/render error use the tabbed `CompactWorkspace`. The explorer build (`VITE_APP_MODE=explorer`)
does not include it. Theme: `src/explore/dockview-theme.css` (brand tokens, matched to the
approved POC).
