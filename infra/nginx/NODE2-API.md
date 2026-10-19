# Node #2 public API (api2.rougechain.io)

Why: the shielded wallet confirms the pool against three machines the project runs (owner
decision 2026-10-18). Node #2 had no public https origin. This adds one, allow-listed: the wallet's reads plus the V2-only submit route.

1. DNS (Hostinger → rougechain.io → DNS): `A  api2  95.217.128.167`.
2. On node #2 as root:

```sh
apt-get update && apt-get install -y nginx certbot
ufw allow 80/tcp && ufw allow 443/tcp
systemctl stop nginx
certbot certonly --standalone -d api2.rougechain.io --agree-tos -m <owner email> --no-eff-email \
  --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
cat > /etc/nginx/sites-available/api2-rougechain   # paste infra/nginx/api2-rougechain, then Ctrl-D
ln -sf /etc/nginx/sites-available/api2-rougechain /etc/nginx/sites-enabled/api2-rougechain
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl start nginx
```

3. Check from anywhere: `curl https://api2.rougechain.io/api/health` → same chain_id/height as api.rougechain.io;
   `curl -o /dev/null -w '%{http_code}' https://api2.rougechain.io/api/stats` → 404.

Port 5100 stays as ufw has it (primary only). Renewal: certbot's timer stops/starts nginx via the saved hooks.
Rollback: `rm /etc/nginx/sites-enabled/api2-rougechain && systemctl reload nginx && ufw delete allow 80/tcp && ufw delete allow 443/tcp`.

## Node #3 (api3.rougechain.io, 178.104.228.9)

Same steps and the same file with `api2` replaced by `api3` (installed 2026-10-18). ufw on node #3:
22, 80, 443 from anywhere; 5100 only from the primary 62.72.24.192.

## Shield submit route

`POST /api/shield-v2/submit` (node release with the route; older nodes answer 404). The node admits
`shield_v2`, `shielded_transfer_v2` and `unshield_v2` only, refuses them before the activation height,
and forwards an accepted one to its peers. Check after installing the new config:

```sh
curl -s -X POST -H 'content-type: application/json' -d '{"version":1,"tx_type":"transfer","from_pub_key":"","nonce":0,"payload":{},"fee":0,"sig":""}' https://api2.rougechain.io/api/shield-v2/submit
# → {"success":false,"error":"this route accepts shielded pool V2 transactions only"}
curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' https://api2.rougechain.io/api/tx/broadcast   # → 404
```

## Testnet nodes (testnet2 / testnet3)

Node #2 and node #3 each also run a testnet node next to the mainnet one, so the shielded wallet
has three testnet nodes too. Both machines run Ubuntu 26.04, which installer 2.1.0 does not list,
so the install uses a copy of the signed installer with only `ubuntu:26.04` added to the OS check
(the updater it installs is the signed file from the manifest, not that copy).

```
# on node #2 (node #3: NODE_NAME=nbg1-node3-testnet, PUBLIC_URL=http://178.104.228.9:5101)
NETWORK=testnet VALIDATOR=0 HOST=0.0.0.0 NODE_NAME=hel1-node2-testnet \
  PUBLIC_URL=http://95.217.128.167:5101 bash /root/install-validator-2604.sh
ufw allow from 62.72.24.192 to any port 5101 proto tcp
```

The primary's testnet node pushes new blocks to both through
`/etc/systemd/system/quantum-vault-testnet.service.d/zz-peers.conf`
(`Environment=QV_PEERS=http://95.217.128.167:5101,http://178.104.228.9:5101`).

Public origin: DNS A records `testnet2` → 95.217.128.167 and `testnet3` → 178.104.228.9, a
certificate for each (same certbot command as above with the new name), and
`infra/nginx/testnet2-rougechain` installed as `/etc/nginx/sites-available/testnet2-rougechain`
(on node #3 with "testnet2" replaced by "testnet3") and linked into `sites-enabled`.

Check: `curl https://testnet2.rougechain.io/api/health` → `rougechain-devnet-1` at the same height
as `https://testnet.rougechain.io/api/health`.
