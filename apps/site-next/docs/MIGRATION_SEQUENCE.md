# Production migration sequence

Planning specification only. The lead developer owns implementation in the separate production monorepo.

| Phase                           | Deliverable and gate                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 Shared foundation            | brand, ui, app-shell, ecosystem-registry, network-config, i18n; canonical tokens/common strings, dependency boundaries and CI                                                  |
| P2 Marketing + Docs             | Approved marketing and Docs visual foundations; Docs retains suitable runtime, gets consistent theme; legal/community/content ownership; workspace licensing before production |
| P3 Explorer                     | First primarily read-only independent app; validate shell, Apps, data schemas, CORS, deep links/redirects and complete Explorer design                                         |
| P4 Validators reads             | Overview/list/detail/genesis/participation; no staking shortcut before provider review                                                                                         |
| P5 Developer Portal             | Build onboarding, SDK/API/WASM/MCP/node content and Docs linking                                                                                                               |
| P6 Wallet-provider architecture | Security-reviewed contract, permissions/capabilities, origin/network/account events and recovery before transaction-capable migration                                          |
| P7 Swap                         | Provider, valid quotes, simulation, price impact, signing/rejection, stale state and errors; Buy ownership resolved                                                            |
| P8 Bridge                       | Separate asset/network/finality/recovery and security review, beyond ordinary Swap execution                                                                                   |
| P9 Wallet                       | Only after legacy origin/vault migration, recovery and rollback are solved                                                                                                     |
| P10 Messenger + Mail            | Preserve encrypted identity, keys, history, delivery and access semantics; deliberate stateful migration                                                                       |

Transactional Validators follows P6 and its own signing/confirmation acceptance, even though read-only pages ship in P4. Status/settings ownership must be resolved before their assigned migration. No phase permits ad hoc cross-origin key handling.

## Every app phase includes

1. Inventory existing functionality, routes, translations and state dependencies.
2. Move functionality into the correct separate monorepo app.
3. Apply approved shared design system to all active screens/states.
4. Integrate AppShell and correct local navigation.
5. Integrate ecosystem registry/global Apps.
6. Integrate centralized configuration and i18n.
7. Integrate reviewed provider layer where required.
8. Validate functional parity, accessibility, responsive layouts and failures.
9. Deploy/verify dedicated target host with rollback.
10. Validate direct links, refresh, parameters/query, locale/network and assets.
11. Redirect legacy paths only after destination stability and applicable vault gates.
12. Retire legacy design dependencies only once no unmigrated screens depend on them.

Track content/design/security/operations owners and evidence per phase. Partial migration must not be declared platform completion. Full-platform acceptance requires every active page, including Docs, to belong to the approved system.
