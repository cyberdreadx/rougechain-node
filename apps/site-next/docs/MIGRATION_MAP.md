# Migration map

The complete current migration specification is [ROUTE_MIGRATION_MATRIX](ROUTE_MIGRATION_MATRIX.md), supported by [surface inventory](EXISTING_FRONTEND_SURFACE_AUDIT.md), [design migration](DESIGN_MIGRATION_MATRIX.md) and [migration sequence](MIGRATION_SEQUENCE.md).

Internal subdomain separation and whole-platform visual migration are required together. Current route knowledge is supplied by the brief; no production router audit is claimed. `/status`, `/settings` and `/buy` retain explicit production decisions. Legacy wallet-origin/vault migration must be solved before Wallet redirects. No redirect or production implementation is performed in this repository.
