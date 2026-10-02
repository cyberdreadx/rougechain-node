# Auto-deploy (retired)

> **Retired.** The git-pull "auto-deploy" cron job (`scripts/auto-deploy.sh`: `git pull` →
> `cargo build` → `systemctl restart` whenever `main` changed) is no longer a supported way to run
> a node. It built and ran whatever was on `main` — no release, no signature — and restarted the
> node at arbitrary times.
>
> Use **[Automatic updates](auto-update.md)** instead: nodes installed with
> [`install-validator.sh`](releases.md) upgrade themselves from **signed releases** only, health-check
> the node after the restart and roll back if the check fails.

## If a node still runs the old cron job

Remove it, then move the node to signed releases:

```bash
crontab -l | grep -v auto-deploy | crontab -            # stop the cron job
sudo rm -f /etc/sudoers.d/rougechain-deploy             # the passwordless-restart rule it used
```

- A validator or full node on mainnet or testnet: follow
  [Nodes installed from source](releases.md#nodes-installed-from-source) — it keeps the node's
  `node-keys.json` and data and replaces the source build with a signed release and the
  auto-updater.
- A development node that must follow `main`: update it by hand (`git pull`, build, restart) when
  you choose to. Do not automate it on a machine that holds a staked key.
