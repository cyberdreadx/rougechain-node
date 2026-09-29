# Environment-aware configuration contract

Centralize configuration in network-config or an equivalent shared boundary. Do not scatter hard-coded domain/network strings across nine apps. Exact env-var syntax is a lead-developer choice.

| Concept                                                                                  | Required contract                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Chain ID, network name                                                                   | Explicit supported identifiers, display labels and unknown-network behavior                                                        |
| API base, RPC, WebSocket                                                                 | Validated per-environment URLs, transport policy, timeouts and schema versions; production RPC/WS values are not provided here     |
| Marketing, Explorer, Wallet, Swap, Bridge, Messenger, Mail, Validators, Build, Docs URLs | Environment-resolved destinations from the required host map; disabled/unavailable hosts must not silently fall back to production |
| Qwalla, Wallet Extension, Rougee, qWave                                                  | Reviewed external destinations; Arcade has no URL until approved                                                                   |
| Locale and feature flags                                                                 | Shared supported-locale/fallback convention; flags never confer signing authorization                                              |

Validate at startup/build: supported network, protocol/host allowlist, required values and consistent chain/endpoint selection. Browser configuration is public; never put credentials, signing keys or provider secrets in client env vars. Preview/staging must not accidentally enable production writes.

Registry resolves safe destinations from configuration. POC `appHref` workspace fallbacks and proposedHost strings are not the production routing contract. Unknown values should fail clearly rather than guess a network/host.

POC exception: the read-only adapter intentionally fixes `https://api.rougechain.io` and allows only `/api/stats`, `/api/validators`, `/api/blocks?limit=8`, GET, omitted credentials, rejected redirects and bounded timeout. Its snapshot/live/stale labels must remain truthful. Production chain-client should retain explicit validated reads and introduce separately reviewed provider-authorized writes, not loosen this wrapper to arbitrary requests.
