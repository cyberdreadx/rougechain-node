# Lead-developer handoff

Start with [HANDOFF_INDEX](HANDOFF_INDEX.md). Approved reference: [545a5a190178e049c9d73993632a8857100b5292](https://rougechain-design-poc-545a5a1.netlify.app/), branch `poc/frontend-v2.1`. Handoff branch: `poc/lead-dev-handoff`.

> The approved POC establishes the design system for the entire RougeChain platform, not only the marketing site, Explorer, and Swap. Every existing active RougeChain frontend—including Wallet, Bridge, Messenger, Mail, Validators, developer surfaces, Documentation, and all remaining active internal pages—is expected to migrate to the new shared visual system as it moves into the production frontend monorepo and target subdomain architecture.

> The subdomain split and visual redesign are part of the same migration objective. The intended production outcome is not the existing interfaces moved unchanged to new domains; it is the existing functionality migrated into focused applications that share the approved RougeChain design system, global navigation, configuration, wallet-provider architecture, and ecosystem identity.

Production monorepo implementation belongs in the lead developer's separate repository. This POC remains frozen as a visual/interaction reference; comments and documentation clarify adoption boundaries. The reference preview is public, manually deployed and unchanged by this handoff.

Use [POC_TO_PRODUCTION_MAP](POC_TO_PRODUCTION_MAP.md) to avoid porting synthetic wallet/quote/transaction logic. [QA](QA.md) records current checks; production checklists are requirements, not completed claims. V1/V2/V2.1 branches and PRs remain preserved; the new handoff draft PR targets main and must not be merged automatically.

The lead developer should use this package as the approved visual/architecture reference while implementing the new production frontend monorepo, migrating each existing application to its designated subdomain and applying the shared RougeChain design system across the entire platform.
