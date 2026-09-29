# Frontend architecture

The required production architecture is now specified in [FRONTEND_MONOREPO_TARGET](FRONTEND_MONOREPO_TARGET.md), [DOMAIN_MIGRATION](DOMAIN_MIGRATION.md) and [SHARED_PACKAGES](SHARED_PACKAGES.md). These supersede earlier optional-host wording. [APPROVED_REFERENCE](APPROVED_REFERENCE.md) records the final five-group Apps taxonomy.

The implemented POC remains one Vite SPA with 13 routes, packages/brand, packages/ui (including RougeAppShell), and packages/chain-readonly. A single QueryClient/NetworkProvider shares bounded public reads; DemoWalletProvider demonstrates a single-origin synthetic UX only. No new production packages/apps are created here.

For data/origin boundaries see [CONFIG_CONTRACT](CONFIG_CONTRACT.md) and [WALLET_PROVIDER_ARCHITECTURE](WALLET_PROVIDER_ARCHITECTURE.md); for workspace lifecycle see [TRELLIS_WORKSPACE_ARCHITECTURE](TRELLIS_WORKSPACE_ARCHITECTURE.md). Start the complete handoff at [HANDOFF_INDEX](HANDOFF_INDEX.md).
