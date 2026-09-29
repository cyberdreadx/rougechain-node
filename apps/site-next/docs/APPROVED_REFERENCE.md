# Approved reference

| Item                     | Value                                              |
| ------------------------ | -------------------------------------------------- |
| Repository               | massiveideaslabs/rougechain-frontend-poc           |
| Canonical handoff branch | main                                               |
| Handoff baseline merge   | `1b32621fa65f4edf5bc9f5ea19ebf25224236c28`         |
| Frozen design branch     | poc/frontend-v2.1                                  |
| Frozen design SHA        | `545a5a190178e049c9d73993632a8857100b5292`         |
| Public preview           | https://rougechain-design-poc-545a5a1.netlify.app/ |

**DESIGN / ARCHITECTURE REFERENCE ONLY.** Use `main` as the canonical developer handoff. The frozen v2.1 SHA remains the approved visual/interaction baseline represented by the hosted preview. Production need not copy every POC line; material design or architecture departures should be intentional and reviewed.

> The approved POC establishes the design system for the entire RougeChain platform, not only the marketing site, Explorer, and Swap. Every existing active RougeChain frontend—including Wallet, Bridge, Messenger, Mail, Validators, developer surfaces, Documentation, and all remaining active internal pages—is expected to migrate to the new shared visual system as it moves into the production frontend monorepo and target subdomain architecture.

> The subdomain split and visual redesign are part of the same migration objective. The intended production outcome is not the existing interfaces moved unchanged to new domains; it is the existing functionality migrated into focused applications that share the approved RougeChain design system, global navigation, configuration, wallet-provider architecture, and ecosystem identity.

Approved: marketing, typography, palette, spacing, restrained effects, UI language, AppSwitcher, dApp shell, local navigation, wallet/account UX concept, Explorer, Swap, Trellis/workspace, responsive system, app taxonomy and subdomain direction. Production feature parity, security and operational readiness are not established by this approval.

## Frozen global Apps taxonomy

| Hold                   | Trade  | Play                 | Talk      | Explore    |
| ---------------------- | ------ | -------------------- | --------- | ---------- |
| Qwalla Mobile Wallet ↗ | Swap   | Rougee ↗             | Messenger | Explorer   |
| Web Wallet             | Bridge | qWave ↗              | Mail      | Validators |
| Wallet Extension ↗     |        | Arcade — Coming soon |           |            |

Order is Hold → Trade → Play → Talk → Explore. Qwalla links to https://qwalla.io; Rougee to https://www.rougee.app; qWave to https://music.rougee.app; Wallet Extension to the [official Chrome listing](https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj). Arcade is non-interactive. Preserve registry IDs independently of translated display labels.

The handoff request's section 9 repeats an earlier taxonomy. The exact approved SHA, explicit design freeze and later user approvals resolve that inconsistency in favor of this table. No menu change is made in this pass.

Developer Portal, Docs, SDK, MCP, Run a Node, Regenerate, Community, Network Status and Liquidity are not global Apps. Marketing navigation answers “What can I learn?”; Apps answers “What applications can I use?”; the workspace launcher answers “What surfaces/tools can I open?” and may include Build, Security and Network.

The frozen `/architecture` UI still calls hosts proposed. In this handoff the internal-dApp host split is a required production objective; only provisioned status and implementation details remain undecided. Documentation clarifies this without changing approved UI.
