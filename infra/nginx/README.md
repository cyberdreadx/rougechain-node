# nginx reverse-proxy configs

Version-controlled copies of the production nginx vhosts on the **api box** (`srv421059`).
These are **not** auto-deployed — `/etc/nginx` is not tracked — so on a box rebuild you
restore them from here. They are checked in so the CORS/WebSocket setup is recoverable
and reviewable, not just living as `.bak.<timestamp>` files next to the originals.

## Files

| File | Public host | Proxies to | Notes |
|------|-------------|-----------|-------|
| `api-rougechain` | `api.rougechain.io` | `127.0.0.1:5100` (mainnet daemon) | wildcard CORS + dedicated `/api/ws` |
| `testnet.rougechain.io` | `testnet.rougechain.io` | `127.0.0.1:5101` (testnet daemon) | wildcard CORS + `/ws` and `/api/ws` |

## Why wildcard CORS

Both send `Access-Control-Allow-Origin: *`. This is deliberate: the API has **no**
cookie/session/ambient-credential auth — every state-changing tx is signed client-side
with the wallet's ML-DSA-65 key — so an origin allowlist protects nothing a plain `curl`
can't already reach. Wildcard is what public chain RPCs (Infura/Alchemy) do and is
required for third-party dApps and localhost dev servers.

Implementation detail: `proxy_hide_header Access-Control-Allow-Origin` strips the daemon's
own `CorsLayer` header first, then `add_header ... always` emits the wildcard. Two ACAO
values on one response makes browsers reject it, hence the strip. **Never** add
`Access-Control-Allow-Credentials: true` — browsers reject that paired with `*`. The
`QV_CORS_ORIGINS` env on the daemon units is therefore inert (nginx overrides it).

The `/api/ws` (and testnet `/ws`) blocks carry the WebSocket upgrade headers and long
timeouts, and must precede the `/api/` block so the OPTIONS short-circuit there doesn't
swallow the upgrade (nginx longest-prefix match).

## Restore procedure (on a fresh box)

```bash
# TLS certs must exist first (certbot) at the paths referenced in each file.
sudo cp infra/nginx/api-rougechain          /etc/nginx/sites-available/api-rougechain
sudo cp infra/nginx/testnet.rougechain.io   /etc/nginx/sites-available/testnet.rougechain.io
sudo ln -sf /etc/nginx/sites-available/api-rougechain        /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/testnet.rougechain.io /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Keeping these in sync

If you edit the live config, copy it back here in the same change:

```bash
sudo cp /etc/nginx/sites-available/api-rougechain infra/nginx/api-rougechain
sudo chown $(id -u):$(id -g) infra/nginx/api-rougechain
```

