# Wallet-provider architecture — documentation only

**DemoWalletProvider is POC ONLY — DO NOT PORT.** No production provider, private-key storage, signing or transaction execution is implemented here. The production objective is one consistent connection model across independently deployed applications.

```mermaid
flowchart TB
  E[RougeChain Browser Wallet] --> P[@rougechain/wallet-provider]
  Q[Qwalla] --> P
  W[Authoritative web-wallet origin · candidate] -. security review .-> P
  P --> A[Explorer · Swap · Bridge · Validators · Messenger · Mail]
```

Provider candidates do not imply verified transport/capability support. The lead developer/security team must select and validate extension, Qwalla and any authoritative wallet-origin model.

Conceptual contract, not implemented API:

```ts
connect()
disconnect()
account
network
sign(...)             // explicit origin/account/network-scoped user authorization
sendTransaction(...)  // reviewed simulation, confirmation and execution boundary
```

Specify capability discovery, absent/locked providers, consent, account/network change events, disconnect/revocation, user rejection, cancellation, timeout and stale state. DApps may share UX/contracts but must independently obtain permitted access; being on a related subdomain does not grant signing permission. Cross-origin transport must validate origins/messages and never expose raw secrets.

## Legacy vault is a migration blocker

**localStorage is origin-scoped. Shared wallet-provider interface ≠ shared raw private-key storage.** Moving `rougechain.io/wallet` to `wallet.rougechain.io` does not move its encrypted local vault. SessionStorage is also origin-scoped; the POC's same-tab route persistence proves only single-origin demo UX.

Do not use shared cookies containing keys, query parameters, raw cross-domain private-key movement or localStorage hacks. The security team must inventory legacy vault/encryption formats, recovery and key-sensitive Messenger/Mail state; review migration threat model, user education, old-origin availability, failure recovery and rollback. Do not redirect/decommission the old origin before this is solved.

The POC stores only a connected boolean, fixed synthetic address and demo source in `rougechain-poc-demo-wallet-v1`. No balances, permissions, keys or authentication are represented. Production connected state must be reconciled with provider events, not trusted from that shape of browser storage.
