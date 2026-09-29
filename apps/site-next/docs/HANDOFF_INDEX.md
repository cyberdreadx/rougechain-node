# Lead-developer handoff

Read in this order. Requirements describe future production work, not completed migrations. The frozen POC remains a single-origin design reference.

1. [APPROVED_REFERENCE.md](APPROVED_REFERENCE.md) — Approval, frozen baseline and final taxonomy.
2. [FRONTEND_MONOREPO_TARGET.md](FRONTEND_MONOREPO_TARGET.md) — Independent apps and shared package architecture.
3. [EXISTING_FRONTEND_SURFACE_AUDIT.md](EXISTING_FRONTEND_SURFACE_AUDIT.md) — Known surfaces, evidence limits and ownership.
4. [DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md) — Required host responsibilities.
5. [ROUTE_MIGRATION_MATRIX.md](ROUTE_MIGRATION_MATRIX.md) — Route, design, redirect and security mapping.
6. [DESIGN_MIGRATION_MATRIX.md](DESIGN_MIGRATION_MATRIX.md) — Whole-platform design coverage and specialized work.
7. [POC_TO_PRODUCTION_MAP.md](POC_TO_PRODUCTION_MAP.md) — Adopt / adapt / design reference / POC only.
8. [SHARED_PACKAGES.md](SHARED_PACKAGES.md) — Canonical package responsibilities.
9. [WALLET_PROVIDER_ARCHITECTURE.md](WALLET_PROVIDER_ARCHITECTURE.md) — Provider contract and origin/vault constraints.
10. [TRELLIS_WORKSPACE_ARCHITECTURE.md](TRELLIS_WORKSPACE_ARCHITECTURE.md) — Workspace lifecycle and licensing.
11. [CONFIG_CONTRACT.md](CONFIG_CONTRACT.md) — Central environment-aware configuration.
12. [DEPLOYMENT_BOUNDARIES.md](DEPLOYMENT_BOUNDARIES.md) — Independent builds, origins and rollback.
13. [MIGRATION_SEQUENCE.md](MIGRATION_SEQUENCE.md) — Phases with parity and design gates.
14. [PRODUCTION_ACCEPTANCE_CHECKLIST.md](PRODUCTION_ACCEPTANCE_CHECKLIST.md) — Per-app and platform completion gates.

Supporting references: [design system](DESIGN_SYSTEM.md), [per-app design coverage](DESIGN_COVERAGE_CHECKLISTS.md), [dependencies and licensing](DEPENDENCIES.md), [current QA](QA.md). QA_V1.md, QA_V2.md and QA_V2_1.md are historical records, not current deployment claims.

## Decisions to close before production

`/buy` ownership/fiat-provider requirements; `/status` utility host vs Explorer network page; `/settings` app/account ownership; legacy encrypted-vault migration; exact provider capabilities/transport and permissions; final genesis route spelling; docs platform/theme integration; production API/RPC/WebSocket values and origin policy; Trellis commercial entitlement. External Play products need an owner-agreed brand/integration scope; Arcade has no production route or launch date yet.

The brief's older Use/Trade/Explore list conflicts with its explicit approved SHA and freeze requirement. Preserve Hold/Trade/Play/Talk/Explore from the approved reference; do not revert the user's later-approved taxonomy.
