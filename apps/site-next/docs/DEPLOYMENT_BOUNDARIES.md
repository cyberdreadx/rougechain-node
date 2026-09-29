# Deployment boundaries

| Build owner                | Deployment target        |
| -------------------------- | ------------------------ |
| apps/marketing             | rougechain.io            |
| apps/explorer              | explorer.rougechain.io   |
| apps/wallet                | wallet.rougechain.io     |
| apps/swap                  | swap.rougechain.io       |
| apps/bridge                | bridge.rougechain.io     |
| apps/messenger             | messenger.rougechain.io  |
| apps/mail                  | mail.rougechain.io       |
| apps/validators            | validators.rougechain.io |
| apps/build                 | build.rougechain.io      |
| Existing/chosen Docs stack | docs.rougechain.io       |

Status has no mandatory standalone deployment until ownership is decided. Qwalla and Play destinations remain externally owned. This plan creates no production DNS or deployment.

Each app needs its own artifact, environment, origin policy, release health checks, observability and rollback. Shared-package changes trigger affected builds/tests, not a single forced all-app bundle. Define version compatibility and rollout order for shell/provider changes. Scope CSP/connect-src/frame permissions, CORS, cookie/session behavior and provider origin allowlists to each deployment; validate from the actual new origin.

Use app-local SPA fallbacks only where needed, preserve genuine asset/unknown-route errors, and separately implement legacy cross-host redirects after acceptance. Do not copy the POC catch-all redirect to the marketing production host and mask migrated routes.

## Approved POC deployment

Public reference: https://rougechain-design-poc-545a5a1.netlify.app/ at approved SHA `545a5a190178e049c9d73993632a8857100b5292`. Isolated Netlify site ID `6560731d-6071-4cc3-9231-b8a4d3277987`; approved deploy ID `6abbf95ba65d6d5e58c3d6bf`. Static output `apps/showcase/dist`; public access was explicitly approved. No production domain is attached. This was a manual upload, not Git auto-deploy. Handoff work leaves it unchanged.
