# RougeChain design system

The network is futuristic. The interface can be quiet.

## Principles

One notable visual treatment per object. Lead with hierarchy and typography. Reserve surfaces for tasks, not every idea. Marketing has space; applications have precision. Brand tokens live in `packages/brand/tokens.css`, reusable primitives in `packages/ui`, and composition rules in `apps/showcase/src/style.css`.

## Color roles

| Role                 | Token       | Value   |
| -------------------- | ----------- | ------- |
| Canvas               | `--bg`      | #07060C |
| Panel                | `--surface` | #100D18 |
| Raised control       | `--raised`  | #181420 |
| Hairline             | `--border`  | #2C2636 |
| Primary text         | `--ink`     | #F5F1FA |
| Secondary text       | `--muted`   | #A69EAF |
| Brand red            | `--red`     | #F34459 |
| Brand magenta        | `--magenta` | #D843A6 |
| Brand violet / focus | `--violet`  | #A481F8 |
| Verified live API    | `--live`    | #69D9BF |
| Snapshot / caution   | `--warning` | #E5BB78 |
| Error                | `--error`   | #FF8394 |

The red → magenta → violet spectrum appears in the hero headline and restrained brand artwork. Teal is only an operational status color. Every status includes a word, not color alone. “Live API” means a successful recent read; it is not a consensus-health assertion. The hero conservatively says “MAINNET.”

## Type, spacing, surfaces

Self-hosted Space Grotesk 400/500/600 for display and UI; IBM Plex Mono 400 for identifiers, small labels and technical snippets. Mono is deliberately limited. Body 15px, supporting 13–14px, app data 11–13px, display 43–96px responsive. Base spacing 8px, with 4px subdivisions. Max content width 1280px; desktop gutters 48px, phone gutters 20px. Marketing section rhythm 110px / 72px on phones.

Use 16px corners for a composed marketing feature, 8–12px on application forms, 6px buttons, and almost no rounding on table rows. Hairline borders and surface contrast supply depth. No generic colorful drop shadows. The hero lattice is static SVG; no WebGL, glow stack, pointer tracking, or perpetual movement.

## Primitives and patterns

`Button`, `TextLink`, `Section`, `Surface`, `Status`, `Metric`, `CodeBlock`, `Dialog`, `DemoBadge`, `EmptyState` are shared. Marketing/App headers, network controls, copyable hashes, and token selection demonstrate compositions. Native select, input, dialog and details retain platform accessibility.

Inspect `/design-system` for palette, type, button variants, input examples, data density, seven status specimens, surfaces and a working modal. Inspect `/swap` for default, loading quote, high impact, insufficient balance, unavailable and review examples.

## Motion and accessibility

A 500ms, 12px hero entrance; 180ms control feedback. Homepage eyebrows/headings and pillar/team cards reveal once with a 500ms, 20px fade-and-rise; cards stagger by 70ms (maximum 140ms). The hero lattice responds from the first page-scroll pixel, rotating 0–100 degrees and scaling 1–1.08 over the first 600px, with no autonomous looping or smoothing drift. The logo and product previews remain stationary. Reduced motion disables both additions; observers and animations clean up on navigation/preference changes. Trellis movement follows the user. `prefers-reduced-motion` disables decorative animation and smooth scrolling; Framer Motion and Trellis also honor the preference. Reduced transparency makes modal backdrop opaque. Focus rings are visible. A skip link precedes navigation. Mobile tabs support Left/Right/Home/End; the active tab uses roving tabindex. Native modal supplies focus containment, Escape, and focus restoration.

## Responsive behavior

Explicit review targets: 320, 375, 768, 1024, 1440, 1728px. Below 900px Explore is a tabbed shell using the same shared preview components and launcher. Desktop adds docking, resize, focus, persistence, reset and a Simple view alternative. Explorer blocks become compact two-column records on phones; transaction specimens scroll within their own region. Swap becomes one column. No page-wide horizontal scroll is intended.

## DO NOT

- No jelly logos, perpetual shimmer, scanning beams or decorative continuous animation.
- No default card wall, universal glass, rainbow icons or excessive pills.
- No glow on every container, animated borders, or hover lift everywhere.
- No decorative teal or unsupported “healthy chain” claims.
- No synthetic numbers presented as live data.
- No migration that casually shares key material between origins.

## V2 ecosystem patterns

`/design-system` now includes the global Apps switcher, shared Explorer shell and local navigation, a proposed-host label, the grouped workspace launcher and a Wallet preview panel. `/architecture` presents the registry topology and ownership boundaries. Existing V1 tokens, typography, hero and approved marketing copy remain the foundation.

Global switcher: grouped text links, explicit Preview/Demo/External labels, keyboard focus entry and containment, Escape dismissal and focus return. At narrow widths it includes the current application's local links. Each instance has a unique controlled-panel id.

Workspace: three default panes, a labeled launcher with Not opened/Open/Focused/Hidden states, explicit focus/hide accessories, and native panel menus. Preview controls cannot perform real effects. Compact tabs support arrow/Home/End navigation; previews remain mounted when hidden during the visit. Status uses wording as well as color.

## V2.1 wallet and final taxonomy

Apps groups user-facing applications in Hold/Trade/Play/Talk/Explore, in that order. Hold contains Qwalla Mobile Wallet, Web Wallet and Wallet Extension. Play contains external Rougee and qWave links plus a non-interactive Arcade / Coming soon placeholder. Mobile groups stack in the same order. Developer resources and Community remain marketing/project navigation; Network and Liquidity remain utilities. The workspace may still expose Build and Security. Do not duplicate one taxonomy everywhere.

Connect Wallet is the single global utility control. Connected account state displays a Demo prefix and a synthetic shortened address; mobile shows Connect/Demo with an accessible full label. The provider chooser and account menu reuse native Dialog keyboard containment, Escape dismissal and explicit trigger focus return. Use restrained outlines and typography rather than extra glows or status badges.

`/design-system` demonstrates disconnected/connected state specimens, the live WalletControl, provider chooser, account actions, shared Explorer shell and Wallet workspace panel. All interactive specimens consume the real POC context; connecting a specimen updates the header too. Static state specimens are labeled non-interactive examples.

Account identity is global product state; transaction capability belongs to the wallet provider implementation. A demo-connected state must never enable Send, Receive, Swap, Bridge, messaging or staking. Unknown balances stay em dashes. Native dialogs are centered after CSS reset and scroll internally on small screens.

## Platform-wide adoption and Docs

This system applies to every active RougeChain frontend, including Wallet, Bridge, Messenger, Mail, Validators, Build, Docs, status and legal/community pages. Use the three [design modes](FRONTEND_MONOREPO_TARGET.md): editorial Marketing, operational Application, and reading-first Documentation. Docs may consume runtime-neutral CSS variables, fonts/assets and generated theme configuration; it must adopt shared identity without sacrificing technical readability. See [DESIGN_MIGRATION_MATRIX](DESIGN_MIGRATION_MATRIX.md) for specialized screen coverage and [DESIGN_COVERAGE_CHECKLISTS](DESIGN_COVERAGE_CHECKLISTS.md) for per-app gates.
