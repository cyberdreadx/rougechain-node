# QA and safety record

Review date: 2026-09-29. Browser: Codex in-app Chromium. Node: 26.9.0; npm: 11.19.1. The project requires Node >=20.19; Node 20 itself was not separately tested.

## Gates

- `npm install`: succeeded. Initial Vitest advisory resolved by upgrading to 4.1.11.
- `npm run dev`: working at http://127.0.0.1:5173 (local sandbox required permission to bind the port).
- `npm run build`: TypeScript check and Vite production build pass.
- `npm run lint`: passes.
- `npm test`: 40 tests across four files pass.
- `npm run format:check`: run at final handoff.
- `npm audit`: zero vulnerabilities after the patched test runner installation; final verification recorded with the handoff.

The initial install reports deprecated ESLint 9 and jsdom's whatwg-encoding dependency. They are development-only, pinned by the lockfile, and did not prevent verification. npm 11 also reported install-script approval notices for esbuild/fsevents; the actual Vite production build passed. No production runtime audit findings remain.

## Responsive and visual review

All four routes tested at exact CSS widths **320, 375, 768, 1024, 1440, 1728**: 24/24 combinations have document scroll width equal to viewport width. `artifacts/responsive-checks.json` contains the measured values. Final captures compensate for the app zoom and record the measured CSS viewport in `artifacts/capture-sizes.json`.

Reviewed: typography, header/navigation, hero composition, static lower sections, portrait grid, Trellis content density, phone tabs, Explorer row adaptation, table-local scrolling, Swap forms and native review modal. No page-wide overflow, repeated glow effects, global animated backgrounds, excessive pills or rainbow icon system. Desktop and app views share typography, colors and controls.

Captures are local and ignored, in `artifacts/`:

- `1440-home-hero.jpg`
- `1440-home-trellis.jpg`
- `1440-home-lower.jpg`
- `375-home-hero.jpg`
- `375-home-explore.jpg`
- `1440-explorer.jpg`
- `375-explorer.jpg`
- `1440-swap.jpg`
- `375-swap.jpg`
- `1440-design-system.jpg`
- Supplementary full-page design-system capture.

## Interaction verification

- Trellis mounts on approach to the Explore section, separate from hero-critical code.
- Keyboard resize on a divider changed the Network pane width; the changed width persisted after reload. Reset restored the curated composition. Double-click focus enlarged Network. The panel menu docked Network into Explorer; Reset restored five separate panes.
- Simple view exposes the same five conceptual areas; error-boundary test renders all five when the lazy workspace fails.
- Phone tabs change shared content; Home and arrow keys restore/change focus and active selection.
- Live/Snapshot selection updates source labels and disables snapshot refresh.
- Explorer local filter produces an explicit empty state; copy shows “Hash copied.” OS clipboard contents were not used as the assertion because the browser tool exposes a separate clipboard surface. Unit tests verify exact copied content and denial fallback.
- Native Swap dialog opens, Escape closes, and focus returns to Review swap. All warning/loading/unavailable/insufficient-balance scenarios are covered in component tests; review is disabled when appropriate.
- Swap component interactions perform zero fetches. The surrounding shared provider only uses the separately tested GET boundary.
- Reduced motion/transparency are implemented in CSS, Framer Motion, and Trellis. A separate OS-level preference emulation session was not available through this browser surface.

## Test coverage

Required routes render; mobile tab keyboard behavior; Trellis boundary; explicit snapshot selection; stale cached data; clipboard success/failure; Swap token changes/review and blocked states; invalid quote amounts and duplicate tokens; fixed-host allowlisted GET requests; rejection of POST/PUT/PATCH/DELETE and unapproved endpoints before fetch; HTTP and response-shape failures; invalid/incompatible/unavailable layout storage.

## Safety verification

Only remote: `origin` → `https://github.com/massiveideaslabs/rougechain-frontend-poc.git`. Production repository was never cloned, branched, modified, pushed, or attached as a remote. No Cargo, node/validator/relayer, bridge or blockchain script was run.

Only executable network transport in application source: the fixed-host `readOnlyGet`, using literal GET, no credentials, no request body, no redirects and an eight-second timeout. No wallet provider, key loader, signing dependency, transaction broadcast, bridge client or write method exists. The SDK command is presentation text only; that SDK is not installed.

Production reference reads were limited to `src/data/team.ts`, `src/components/Footer.tsx`, `src/assets/xrge-logo.webp`, and `src/assets/qwalla-app.jpg` via individual authenticated GitHub API calls. Public team portraits were downloaded from exact paths named in the approved roster. No backend implementation or recursive production repository search was accessed.

No production RougeChain deployment, Netlify project, DNS, API, CORS or authentication configuration was modified. Netlify CLI reported unauthenticated. No draft deploy was attempted against an unknown existing site.

## Practical limitations

Local browser QA is not a complete cross-browser or assistive-technology audit. Search covers only the fetched recent blocks. Validators are the returned roster count, not asserted active consensus membership. Transactions and Swap are explicitly synthetic. Full production API contracts, wallet migration and Trellis commercial licensing remain lead-developer decisions.
