# Node #2 public API (api2.rougechain.io)

Why: the shielded wallet confirms the pool against three machines the project runs (owner
decision 2026-10-18). Node #2 had no public https origin. This adds one, read-only, allow-listed.

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
