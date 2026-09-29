# Trellis: interactive ecosystem workspace

Trellis is an interactive ecosystem workspace, not a decorative dashboard grid. Approved capabilities: programmatic opening, focus/overview, dock/tab, hide/restore, keyed block details, view/layout persistence, optional full-workspace floating, shared app previews and launcher.

| Surface                      | Production intent                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Embedded marketing workspace | Remains within rougechain.io, restrained; floating disabled                                |
| Full workspace               | May remain rougechain.io/workspace; overlay floating permitted; no automatic new subdomain |
| Compact/mobile/simple view   | Same preview content with accessible tabs/launcher, no pretend docking geometry            |

Implementation pointers: `explore/WorkspaceExperience.tsx`, `TrellisWorkspace.tsx`, `CompactWorkspace.tsx`, `model.ts`, `PreviewContext.tsx`, `BlockDetail.tsx`. Native Trellis 0.3.0 APIs implement the window lifecycle; the custom launcher is not a replacement window manager.

Default Network/Explorer/Ecosystem panes; singleton open reuses/focuses/restores hidden views. Hide preserves mounted input state; preview inputs are not serialized on reload. Block Detail instances are keyed by hash with captured block/provenance params, grouped with Explorer. These captures are not fresh reads.

Desktop layout/open/hidden/navigation state uses separate validated version-2 localStorage keys for embed/full workspace; malformed trees, duplicate singletons and invalid detail params are rejected. V1 keys remain untouched. Compact state persists only for the current mount. Below 900px, Simple view, lazy fallback and error recovery use CompactWorkspace. Production persistence must define schema versioning, sensitive-data exclusion, quotas, migration/reset and recovery before adding real product state.

## Licensing gate

**Trellis commercial licensing must be resolved before production use.** The existing internal demo approval does not establish commercial entitlement. See [DEPENDENCIES](DEPENDENCIES.md) and the official license referenced there; the lead developer must verify applicable current terms. No sponsorship/license purchase is made by this handoff.

Production workspace previews may link/open full apps; do not make the marketing workspace a second owner of signing, encrypted messages or transaction state. Wallet/provider boundaries apply to any future actionable view.
