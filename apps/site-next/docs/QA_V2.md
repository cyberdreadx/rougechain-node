# V2 QA and safety record

Review date: 2026-09-29. Browser: Codex in-app Chromium. Node 26.9.0; npm 11.19.1. V1 evidence is preserved in QA_V1.md and the V1 branch.

## Automated gates

- `npm run build`: TypeScript and production Vite build pass.
- `npm run lint`: pass.
- `npm test`: 62 tests across seven files pass.
- `npm run format:check`: pass.
- `npm audit --json`: zero vulnerabilities, saved at `artifacts/v2/npm-audit.json`.

Tests cover registry uniqueness and safe destinations; global menu on marketing, Explorer and Swap; Escape/focus return; shared shell/local navigation/proposed host; reloadable workspace query; singleton compact launch, hide/restore with retained Mail state, reset and keyboard navigation; dynamic block details; five Explorer sections and two Swap sections; malformed/mismatched persisted layouts, duplicate singletons, invalid detail data and unavailable storage. V1 read-only adapter, failed/stale request, Swap no-fetch/blocked-state and clipboard tests remain green. The actual engine is tested in the browser; no mocked docking engine is used to substantiate native capabilities.

## Responsive review

All 13 routes at exact CSS widths 320, 375, 768, 1024, 1440, 1728: **78/78** have document scroll width equal to viewport width. Measured evidence: `artifacts/v2/responsive-checks.json`. Fixed a non-wrapping workspace data control row and a Transactions heading overflow at 320px. Tables and local navigation scroll within their containers.

Reviewed grouped desktop/mobile Apps, app shell, local navigation, proposed-host label, workspace launcher and preview density, architecture topology, Explorer sections and Swap specimens. Screenshots are local and ignored under `artifacts/v2/`; the review gallery lists final captures.

## Native browser interactions

- Default desktop workspace opens Network, Explorer and Ecosystem.
- Repeated Wallet launch creates one tab. Hide changes launcher state to Hidden; re-open restores it.
- Mail Sent selection survives hide/restore without a remount; preview form state intentionally resets on page reload.
- Hidden layout survives reload. Divider keyboard resize changed Network from 320px to 342px; 342px persisted after a settled reload. Tab grouping, native floating/redocking and reset tested.
- Block #200 opens a keyed Block Detail tab beside Explorer, with full hash, timestamp, transaction count and captured provenance. Focus expands the panel across the workspace canvas; Overview restores the composition. No detail request is made.
- Full workspace exposes Float/Dock in native menus. Homepage disables floating while keeping launcher, tab, focus, hide/restore and reset.
- Mobile Apps includes the current product's local routes and all global groups. Escape returns focus to Apps. Preview link opens `/workspace?open=wallet`.
- Compact/Simple/error fallback shares preview content and retains hidden views during the mount. Compact arrangement is session-only, explicitly labeled.

## External destinations

Official reference footer and published marketing bundle establish Documentation `https://docs.rougechain.io/`, Qwalla `https://qwalla.io`, source `https://github.com/cyberdreadx/rougechain-node`, Whitepaper `https://rougechain.io/RougeChain-Whitepaper.pdf`, X `https://x.com/rougecoin`, and Discord `https://discord.gg/Fn6CCrx8jP`. Docs, Qwalla and PDF returned 200; PDF has application/pdf content type. GitHub metadata confirms public source. Discord redirected to the expected discord.com invite. X uses the official published reference, not a guessed handle. No external authentication or joining was performed.

## Safety and delivery boundary

Only remote is the private POC origin. V1 starts and ends at `feb5fca2e90cbf5ac3fc11141ed74cc5a314cfdd`; its branch and PR #1 are preserved. V2 uses a new branch and new draft PR to main; no merge.

No production RougeChain source was modified, cloned or added as a remote. V2 source checks used approved public documentation, repository metadata and the published public frontend. No blockchain scripts, backend implementation or production repository scan ran.

Only executable application transport remains the fixed-host GET adapter for stats, validators and eight recent blocks. No wallet connection, private-key access, signing, transaction broadcast, message send, staking, bridging or value movement exists. Transactions, token/NFT/contract, pool and position specimens are synthetic. No production API, DNS, deployment, CORS or auth configuration changed.

Netlify status was checked once in V2 and remains unauthenticated. PREVIEW_NOT_DEPLOYED. Local preview stays available; no site or account was changed.

## Practical limits

This is not a complete cross-browser/assistive-technology audit. Reduced motion is implemented but not separately OS-emulated in V2. Desktop layouts persist; compact state and preview form inputs are intentionally not persisted across page reloads. Production wallet origin migration, data contracts, quote/liquidity execution, key-sensitive apps, deployment ownership and Trellis commercial licensing require separate production work.
