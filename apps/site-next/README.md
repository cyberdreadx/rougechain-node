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

Trellis (the draggable window workspace in Anders' POC) was removed on 2026-09-29 to avoid its
commercial licence ($100/month studio sponsorship + attribution). The homepage "Explore" section and
/workspace use the tabbed CompactWorkspace (same content). Restore from git history if sponsored.
