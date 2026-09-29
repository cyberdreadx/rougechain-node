# Required domain ownership

These are target production responsibilities, not a claim that hosts have been provisioned. Existing internal applications must leave the marketing-host SPA. Each moves with the approved design system, not unchanged legacy styling.

| Host                     | Owner / responsibilities                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rougechain.io            | Marketing: homepage, technology, security, ecosystem, community/Regenerate, team, legal/privacy, marketing workspace; full `/workspace` may remain here |
| explorer.rougechain.io   | Overview, blocks/details, transactions/details, addresses, tokens/details, NFTs, contracts/details, search and network information                      |
| wallet.rougechain.io     | Wallet assets/details, send/receive, history, account management and wallet settings; dedicated provider/vault migration planning                       |
| swap.rougechain.io       | Swap, Pools/Detail, Positions, liquidity and likely Buy pending ownership review; Liquidity is not a separate app                                       |
| bridge.rougechain.io     | Bridge, supported assets, transfer activity/history and finality/recovery                                                                               |
| messenger.rougechain.io  | Encrypted messaging and app-local settings                                                                                                              |
| mail.rougechain.io       | Encrypted mail and app-local settings                                                                                                                   |
| validators.rougechain.io | Overview/list/detail, staking/delegation, genesis information and validator/node participation                                                          |
| build.rougechain.io      | Developer Portal, SDK/API/WASM, MCP/Agents, Run a Node, onboarding and examples                                                                         |
| docs.rougechain.io       | Technical documentation on an appropriate platform, with shared design language                                                                         |

`/node` technical installation/onboarding belongs to Build; validator participation belongs to Validators. Link across hosts instead of duplicating operational state.

`/status`: PRODUCTION DECISION REQUIRED between optional `status.rougechain.io` and `explorer.rougechain.io/network`. `/settings`: PRODUCTION DECISION REQUIRED after categorizing legacy preferences; generally make settings app-local. `/buy`: verify Swap ownership and production provider requirements. `/genesis-validators`: Validators owner, proposed `/genesis` path subject to final naming.

Qwalla stays at `qwalla.io`. Rougee (`www.rougee.app`), qWave (`music.rougee.app`) and the wallet-extension store listing remain external destinations. Arcade remains a future placeholder, with no invented host. Docs and Build are project/developer navigation destinations, not additions to global Apps. Marketing must not retain production internal-dApp execution just to preserve the old giant SPA.
