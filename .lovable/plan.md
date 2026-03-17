
## Overview

The user wants a **separate, standalone mobile app** called **"Qwalla"** — a native mobile wallet app built with Capacitor that uses the RougeChain SDK (`@rougechain/sdk`) for all blockchain interactions (XRGE/RougeCoin, DEX swaps, NFTs, bridge, messenger, mail).

This is a **new Lovable project**, not changes to this one. The Qwalla project would be its own repo in Lovable.

However, since we're operating inside THIS project, the plan covers what Qwalla would look like — and I'll create the foundation here so it can be exported to its own GitHub repo.

---

## What "Qwalla" Is

A mobile-first wallet app for RougeChain. Think of it like MetaMask for RougeChain — clean, minimal, native feel. Key screens:

```
Qwalla
├── Onboarding (create/import wallet)
├── Home (balance, quick actions)
├── Assets (token list with USD values)
├── Send / Receive
├── Swap (DEX)
├── History (transactions)
└── Settings (backup, security, network)
```

---

## Important Clarification

Lovable creates one project per repo. To make **Qwalla** a separate app:

1. I build the Qwalla app **in this project** (replacing or alongside current code), OR
2. You **create a new Lovable project** called "Qwalla" and I build it there

**Recommendation:** Create a brand new Lovable project called "Qwalla" — keeping RougeChain Explorer separate from the Qwalla wallet app. This gives you two clean repos.

Let me ask which approach you prefer before I draft the full plan.

---

## Build Plan (for the new Qwalla project)

### 1. Project scaffold
- Fresh React + Vite + Tailwind + TypeScript project
- Install `@rougechain/sdk` as the core dependency
- Install Capacitor: `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`
- Configure `capacitor.config.ts` with appId `io.qwalla.app`

### 2. Design system
- Dark mobile-first theme (blacks, deep purples, quantum teal — consistent with RougeChain branding)
- Mobile-safe viewport handling (safe areas for notch/home bar)
- Touch-optimized: large tap targets, swipe gestures

### 3. Screens & pages

| Screen | Features |
|--------|----------|
| **Onboard** | Create new wallet (ML-DSA-65 keygen), import via seed phrase / key export |
| **Home** | XRGE balance card, USD value, quick Send/Receive/Swap buttons |
| **Assets** | All token balances, tap to see detail + price chart |
| **Send** | Address input (QR scan), amount, fee estimate, confirm |
| **Receive** | QR code of wallet address, copy button |
| **Swap** | Token pair selector, amount, quote from SDK DEX, execute |
| **History** | Transaction list, filter by type |
| **Settings** | Display name, password/biometric lock, backup keys, network toggle |

### 4. SDK integration points
- `Wallet.generate()` / `Wallet.fromKeys()` — key management
- `rc.getBalance()` — balance display
- `rc.transfer()` — send tokens
- `rc.dex.quote()` + `rc.dex.swap()` — swap screen
- `rc.faucet()` — testnet faucet
- Secure key storage in device keychain via Capacitor Preferences plugin

### 5. Capacitor native setup
- `capacitor.config.ts` pointing to live sandbox URL for hot-reload
- appId: `io.qwalla.app`
- appName: `Qwalla`
- iOS + Android support
- `@capacitor/preferences` for secure key storage (replaces localStorage)

### 6. Export & build instructions
After the Lovable project is built:
1. Export to GitHub via Lovable's "Export to GitHub" button
2. `git clone` the repo locally
3. `npx cap add ios && npx cap add android`
4. `npm run build && npx cap sync`
5. `npx cap run ios` (Mac + Xcode) or `npx cap run android` (Android Studio)

---

## Next Step

Since Qwalla needs to be its **own separate repository**, please:

**Create a new Lovable project** named "Qwalla" and open it — then I'll build the full native app there from scratch with the RougeChain SDK integrated.

Alternatively, if you'd like me to build it right here in this project (and you'll split the repo later), I can start immediately.
