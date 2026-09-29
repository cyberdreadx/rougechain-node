# Shared platform packages

| Package                        | POC starting point                            | Production responsibility / boundary                                                                                                                  |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| @rougechain/brand              | packages/brand, Fontsource assets             | Colors, typography, spacing, radii, borders, surfaces, motion/accessibility conventions; runtime-neutral exports for Docs                             |
| @rougechain/ui                 | packages/ui and reviewed style.css primitives | Buttons, inputs/selects, dialogs/tooltips, status/network indicators, tables, code blocks, empty/loading/error states, copy/address/hash displays     |
| @rougechain/app-shell          | RougeAppShell + Shell.tsx                     | Brand/current app identity, Apps, network, Docs, wallet/account slots, responsive local/mobile navigation                                             |
| @rougechain/ecosystem-registry | ecosystem/apps.ts                             | Stable app IDs, approved groups/order, capabilities, environment-resolved destinations; distinguish app/resource/community/utility                    |
| @rougechain/network-config     | Currently scattered registry/API constants    | Validated chain/network/API/RPC/WebSocket and host configuration; no secret client env vars                                                           |
| @rougechain/chain-client       | chain-readonly + Network.tsx                  | Typed validated reads; separate provider-authorized write interface and explicit network selection                                                    |
| @rougechain/wallet-provider    | WalletControl UX concept only                 | Reviewed connect/disconnect/account/network/capabilities, signing/transaction authorization; never raw key distribution                               |
| @rougechain/i18n               | No production i18n implementation in POC      | Preserve existing production languages; common shell/wallet/network strings once, app namespaces for specialized copy, locale fallback and formatting |

Dependencies should flow from apps toward small packages. Brand should not depend on app routing; registry should not import Wallet execution; UI should not initialize a provider. Use versioned contracts and affected-app CI rather than requiring one deployment artifact.

App-owned specialized UI: ExplorerBlockTable/ExplorerTransactionDetail, SwapQuote/SwapTokenInput/PoolPosition, BridgeTransferProgress, ConversationThread, MailMessageView and ValidatorStakeForm. Compose shared primitives underneath; do not put every product component in shared UI.

All apps retain distinct local route/navigation trees. Explorer: Overview, Blocks, Transactions, Tokens, NFTs, Contracts. Swap: Swap, Pools, Positions. Shared AppSwitcher chooses another app; it does not replace local navigation. Global/common translations belong to one source while product terminology stays namespaced.
