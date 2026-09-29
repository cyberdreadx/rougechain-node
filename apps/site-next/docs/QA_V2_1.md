# Historical V2.1 QA and safety record

Date: 2026-09-29. V1 and V2 records remain in QA_V1.md and QA_V2.md.

## Automated coverage

The suite now includes exact eight-app taxonomy, exclusion of Build/Community/resources/Liquidity/Network Status from global Apps, shared Connect Wallet, both mock source choices, route-to-route identity continuity, session restore/clear, invalid persisted identity, unavailable storage, account copy, safe Explorer notice, focus return, Wallet preview identity and disabled capabilities. Boundary tests intercept fetch and window.rougechain/window.ethereum access during demo connection and assert zero calls/access. Persisted state is asserted to contain only the canonical demo fields.

Existing read-only adapter, routing, workspace model, persistence, compact lifecycle, Swap and clipboard tests remain required. Native browser QA covers chooser/account Escape, focus restoration, route/reload continuity, disconnect propagation and all six requested widths. Final gate results and capture paths are recorded below after verification.

## Safety boundary

No production RougeChain source modified. No real wallet provider connected. No private keys or recovery phrases loaded. No signing capability or blockchain write operation implemented. No DNS or production deployment changed. Only the existing allowlisted public GET adapter makes executable application requests. Wallet demo code contains no fetch, provider lookup, key loader, permission request or signing method.

The sole demo persistence key is rougechain-poc-demo-wallet-v1 in sessionStorage. Only connected boolean, fixed synthetic address and demo source are persisted. Disconnect removes it. This is single-origin UX proof; it does not implement cross-origin provider continuity. All transaction-shaped controls remain disabled or V2 design-only review controls.

Trellis implementation and its V2 dependency versions are preserved. Existing geometry/hidden-view persistence uses separate V2 keys. No production resources or previous PRs are touched. Local preview remains the delivery surface; no deployment is performed in this revision.

## Final V2.1 results

- `npm run build`: TypeScript and Vite production build pass. Vite emits a non-failing 500 kB chunk-size advisory (main JS approximately 504 kB, 159 kB gzip); Trellis remains a separate lazy chunk. Production bundle tuning is not part of this architecture revision.
- `npm run lint`: pass.
- `npm test`: 72 tests across eight files pass.
- `npm run format:check`: pass.
- `npm audit --json`: zero vulnerabilities; evidence in artifacts/v2.1/npm-audit.json.

All 13 unchanged routes at 320, 375, 768, 1024, 1440 and 1728 CSS pixels: 78/78 connected-state checks show no document overflow and find the shared identity control. Four principal shells at the same six widths: 24/24 disconnected checks pass after disconnect/reload. Chooser and account dialog bounds fit all six viewports (12/12). Measurements are saved in responsive-checks.json, disconnected-header-checks.json and dialog-bounds.json under artifacts/v2.1.

Browser verified: extension preview, Qwalla preview/source label, same identity through Apps navigation into Explorer and Swap, account Open Wallet action into Workspace, shared Wallet preview with em-dash balances, native hide/restore, account Explorer notice without lookup, disconnect, reload persistence/clearing, keyboard activation, Escape and trigger focus return. Mobile Apps contains current-product local links and exactly eight global apps; separate Project navigation exposes Build/Community and wallet-state text. The accepted V2 Trellis implementation is unchanged; its full lifecycle coverage remains in QA_V2.md.

Visual corrections: smaller three-column Apps menu, compact Connect/Demo state at narrow widths, centered and bounded native dialogs, and controlled cancel handling that avoids a second close callback. The homepage whitepaper link now uses the already verified canonical PDF constant. No marketing redesign was introduced.

Local screenshots and a review gallery are in artifacts/v2.1/review.html. Captures cover desktop and mobile menus, chooser/account states, connected app headers, workspace Wallet, architecture provider flow and design-system specimens. This is Chromium review, not a full cross-browser or assistive-technology audit.
