# RougeChain frontend — approved reference and developer handoff

Approved next-generation RougeChain frontend visual and architecture reference. **This is not the production frontend monorepo or production blockchain logic.** The lead developer is building the production monorepo separately.

**DESIGN / ARCHITECTURE REFERENCE ONLY** — [Open approved preview](https://rougechain-design-poc-545a5a1.netlify.app/)

Canonical handoff source: `main` · Lead-developer handoff baseline merge: `1b32621fa65f4edf5bc9f5ea19ebf25224236c28`

Frozen visual baseline: `poc/frontend-v2.1` · Approved design SHA: `545a5a190178e049c9d73993632a8857100b5292`

Start with [HANDOFF_INDEX](docs/HANDOFF_INDEX.md), then [approved reference](docs/APPROVED_REFERENCE.md) and [target monorepo](docs/FRONTEND_MONOREPO_TARGET.md). Developers should use `main` as the canonical handoff source; the historical POC branches remain preserved for provenance.

> The approved POC establishes the design system for the entire RougeChain platform, not only the marketing site, Explorer, and Swap. Every existing active RougeChain frontend—including Wallet, Bridge, Messenger, Mail, Validators, developer surfaces, Documentation, and all remaining active internal pages—is expected to migrate to the new shared visual system as it moves into the production frontend monorepo and target subdomain architecture.

> The subdomain split and visual redesign are part of the same migration objective. The intended production outcome is not the existing interfaces moved unchanged to new domains; it is the existing functionality migrated into focused applications that share the approved RougeChain design system, global navigation, configuration, wallet-provider architecture, and ecosystem identity.

## Review routes

| Routes                                                                                                                 | Review purpose                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/`                                                                                                                    | Marketing, motion, global Apps, embedded workspace                               |
| `/workspace`                                                                                                           | Full interactive Trellis workspace                                               |
| `/explorer`, `/explorer/blocks`, `/explorer/transactions`, `/explorer/tokens`, `/explorer/nfts`, `/explorer/contracts` | Read-only data and Explorer design states                                        |
| `/swap`, `/swap/pools`, `/swap/positions`                                                                              | Synthetic exchange and liquidity design                                          |
| `/design-system`                                                                                                       | Tokens and shared component specimens                                            |
| `/architecture`                                                                                                        | POC architecture illustration; handoff docs define final production requirements |

## Run and validate

Node >=20.19; npm workspaces. From repository root:

```sh
npm install
npm run dev
npm run build
npm run lint
npm test
npm run format:check
npm audit
```

Local preview: http://127.0.0.1:5173. Static build: `apps/showcase/dist`.

## What exists here

```text
apps/showcase/             One Vite + React + TypeScript reference SPA
packages/brand/            Shared tokens
packages/ui/               Primitives and RougeAppShell reference
packages/chain-readonly/   Restricted public GET adapter and saved snapshot
docs/                     Production blueprint, migration matrices and QA
```

The POC reads only public stats, validators and recent blocks. “Live API” means a successful read, not consensus health. Unavailable reads show an explicitly labeled snapshot or stale result. All wallet connection state, Swap quotes and transactional previews are synthetic. No real wallet connection, private keys, signing or chain writes are implemented.

## Delivery boundaries

The approved Netlify site is public and separate from production; no production domain is attached. It remains pinned to the approved design build. Handoff documentation does not require redeploying it. GitHub pushes do not automatically publish this manually deployed site.

V1, V2, V2.1 and the historical handoff branch remain preserved for provenance. `main` is the canonical merged handoff, not a production migration. Do not copy the POC SPA rewrite as production cross-host redirects. See [QA](docs/QA.md) for current validation and [dependencies](docs/DEPENDENCIES.md) for Trellis licensing.
