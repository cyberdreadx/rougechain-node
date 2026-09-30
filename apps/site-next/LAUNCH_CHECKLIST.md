# rougechain.io launch checklist: apps/web → apps/site-next

Switching rougechain.io from `apps/web` (React 18) to `apps/site-next` (React 19, Anders' design) on the
**same origin**. Nothing may be lost: routes, assets, the service worker, SEO and social previews.

Legend: **done** = in site-next and tested · **in progress (other area)** = being built in parallel
on another branch · **gap** = not yet planned, owner must decide.

## 1. Routes (apps/web `src/App.tsx` → site-next)

| apps/web route | Owner | site-next status | Notes |
| --- | --- | --- | --- |
| `/` | shell | done | New marketing home (`Home.tsx`). |
| `/wallet` | wallet | done | `src/wallet/WalletPage.tsx`. |
| `/settings` | wallet | done | `src/wallet/SettingsPage.tsx`. |
| `/blockchain` | explorer | done | Explorer overview (also `/explorer`). |
| `/transactions` | explorer | done | |
| `/block/:height` | explorer | done | |
| `/tx/:hash` | explorer | done | |
| `/address/:pubkey` | explorer | done | |
| `/tokens`, `/token/:symbol` | explorer | done | |
| `/nfts`, `/nfts/:collectionId` | explorer | done | |
| `/contracts`, `/contract/:addr` | explorer | done | Not duplicated by pages. |
| `/swap` | swap | in progress (other area) | Design preview exists; the real swap is being built. |
| `/pools`, `/pool/:poolId` | swap | in progress (other area) | site-next has `/swap/pools`; the legacy paths must be kept or redirected. |
| `/buy` | swap | in progress (other area) | |
| `/bridge` | bridge | in progress (other area) | Explorer's bridge activity is at `/explorer/bridge`. |
| `/messenger` | messenger | in progress (other area) | |
| `/mail` | messenger | in progress (other area) | |
| `/validators` | pages | done | List, stats, proposer, finality, your stake, **stake + unstake** (review → sign, core `pqc-validators`: `POST /v2/stake`, `/v2/unstake`), node-keys.json explainer. |
| `/genesis-validators` | pages | done | apps/web copy, minus its internal "EDIT" placeholder notes. |
| `/node` | pages | done | Live node dashboard (same probes as apps/web: API, localhost:5100–5104, discovered peers) + commands. The 3-D network globe is not ported (gap, see §6). |
| `/agents` | pages | done | MCP page; tools list identical. |
| `/status` | pages | done | `/stats`, `/validators`, `/peers` + `public/status/releases.json`. |
| `/regenerate` | pages | done | Mission, treasury (mainnet), projects, proposal form (Netlify Forms), **community votes** (core `regen-votes`, review → sign). |
| `/privacy` | pages | done | Legal text verbatim (a test diffs it against apps/web). |
| `*` (404) | shell | done | `App.tsx` catch-all. |

Before the switch: every row must be **done**. Re-run `src/pages/launch.test.ts`: its sitemap and OG-route
tests fail if a listed path is not a site-next route (paths in `IN_PROGRESS` are allowed until then — empty that list at launch).

## 2. Public assets (`apps/site-next/public`)

Every file in `apps/web/public` is present (test: `launch.test.ts` › public/ parity). Byte-identical copies:
favicon.ico/webp, apple-touch-icon.png, `icons/`, og-image.png, robots.txt, `stark-prover.wasm` + `prover.html`
(shielded features: core `stark-prover` fetches `/stark-prover.wasm`), `status/releases.json` (facts shown on
`/status`: edit and redeploy), `store-assets/` (Chrome Web Store listing screenshots; nothing in the repo links
to them, kept so any external link still resolves), `placeholder.svg` (unused scaffold leftover, kept, 1 KB),
whitepaper PDF, `team/`.

Deliberately different (allow-listed in the test, with reasons):

- `sw.js` — the retirement worker (§3).
- `sitemap.xml` — regenerated for site-next routes (apps/web's listed `/staking`, which never existed).
- `manifest.json` — same names and icons; theme/background colours are the brand `#07060c`.
- `_redirects` — same single SPA rule, with comments.

## 3. Service worker — decision: retire it (kill switch)

apps/web registers `/sw.js` (cache `rougechain-v3`: network-first HTML, cache-first static files). site-next
serves a `/sw.js` that **unregisters itself** and **site-next never registers a worker**.

Why this is safer than a continuing network-first worker:

- site-next has no offline feature, so a worker only adds risk: the old one serves non-hashed files
  (`/status/releases.json`, `/manifest.json`, images) stale-while-revalidate, and falls back to apps/web's cached
  shell (whose hashed bundles no longer exist) when offline.
- A retirement worker is a one-way, idempotent clean-up: `install` → `skipWaiting`; `activate` → delete every
  Cache Storage entry, then `registration.unregister()` (even if the cache clean-up throws). It has **no fetch
  handler**, so while it still controls an open tab every request goes to the network. It never force-reloads
  tabs (a reload could interrupt a wallet signature). Nothing in site-next or core uses Cache Storage.
- PWA install (manifest) does not need a service worker in current browsers.

Tested in `launch.test.ts` (fake ServiceWorkerGlobalScope). `apps/site-next/netlify.toml` serves `/sw.js` with
`Cache-Control: no-cache`. Keep `public/sw.js` deployed for at least several months after the switch.

## 4. SEO / head

`index.html` has every meta name/property and link rel apps/web has (canonical, theme-color, manifest, icons,
OG, Twitter), the same JSON-LD graph, and the Netlify Forms detection shells (`email-signup`,
`regenerate-proposal`) — all checked by `launch.test.ts`. Not copied on purpose: apps/web's viewport
`maximum-scale=1, user-scalable=no` (blocks pinch-zoom).

`vite.config.ts` `siteMeta` (extended; logic in `src/pages/site-head.ts`) sets title, description, canonical and
OG/Twitter title/description/URL per build: main → rougechain.io; `VITE_APP_MODE=explorer` →
explorer.rougechain.io; `VITE_NETWORK_LOCK=testnet` → "RougeChain Testnet", canonical testnet.rougechain.io.

Per-route previews: `npm run build` now runs `scripts/gen-og.mjs` (1200×630 PNGs with the brand fonts →
`dist/og/<slug>.png`) and `scripts/prerender-og.mjs` (route shells such as `dist/validators.html` with that route's
meta; host read from the built canonical). Routes are in `scripts/og-routes.mjs`; the explorer build has its own
set. `/status` is not prerendered (a `status.html` would compete with the `public/status/` directory).

## 5. Environment

site-next reads `VITE_*` from the process environment (Netlify UI) and `apps/site-next/.env*`; apps/web read
`.env*` from the repo root (`envDir`). Before switching, copy every `VITE_*` variable of the rougechain.io Netlify
site (API URLs, `VITE_NETWORK_LOCK`, keys) to the build, and confirm the testnet site sets
`VITE_NETWORK_LOCK=testnet`.

## 6. Known gaps (pages area)

- `/node`: apps/web's 3-D `GlobalNetworkGlobe` is not ported (a large three.js dependency); the live node cards and
  summary are.
- `/validators`: apps/web's "~12% Est. APY" and "10 XRGE block reward" tiles are **not** shown: they contradict the
  Genesis page ("validating earns almost nothing, no emission"). Owner to confirm.
- `/validators`: apps/web had no unstake UI; site-next adds it (core `unstake`, `POST /v2/unstake`).
- `/validators`: apps/web's "Select Proposer" demo button called the same `GET /selection` as the proposer card;
  the card shows it (refreshes each block), no separate button.
- `/node` and `/validators` copy corrected to the real rule (the node's `node-keys.json` key must be the staked key)
  instead of apps/web's "your wallet becomes a validator".
- i18n: apps/web ships ES/ZH/JA; site-next pages are English only (strings in `src/pages/strings.ts`).

## 7. Netlify switch (rougechain.io)

1. All §1 rows done; all gates green on `main`: `npm run test:next`, `tsc`, `eslint`, `npm run build:next`,
   `VITE_APP_MODE=explorer npm run build:next`, `VITE_NETWORK_LOCK=testnet npm run build:next`, root `npm test`.
2. Deploy site-next to a Netlify **preview** of the rougechain.io site (branch deploy) with the production env vars;
   smoke-test on a phone and desktop: wallet unlock, send, stake review (cancel before signing), vote review, swap,
   bridge, messenger, mail, explorer detail pages, `/status`, OG preview of `/validators` (e.g. a card validator).
3. Test the SW retirement: open the live apps/web site once (installs `rougechain-v3`), then open the preview on the
   same origin (or `netlify dev` with both builds) and confirm in DevTools › Application that the worker unregisters
   and Cache Storage is empty.
4. Switch: in the repo-root `netlify.toml` set `command = "npm run build:next"` and
   `publish = "apps/site-next/dist"`, keep its headers and add `/sw.js` `Cache-Control: no-cache` (as in
   `apps/site-next/netlify.toml`). Merge → production deploy.
5. Same for the testnet site (with `VITE_NETWORK_LOCK=testnet`) and, when ready, explorer.rougechain.io
   (`VITE_APP_MODE=explorer`).
6. After deploy: check `/sitemap.xml`, `/robots.txt`, `/manifest.json`, `/stark-prover.wasm`, `/status/releases.json`,
   `/og/validators.png`, `view-source:` of `/regenerate` (route meta), a Netlify Forms test submission.

**Rollback:** Netlify › Deploys › publish the last apps/web deploy (instant), then revert the `netlify.toml` change.
Visitors who got the retirement worker simply have no worker; apps/web re-registers its own `/sw.js` on the next
visit, so rollback needs no extra step.
