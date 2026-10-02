# Automatic updates

A node installed with [`install-validator.sh`](releases.md) keeps itself up to date: a systemd
timer looks for a newer **signed release** every hour, installs it, restarts the node, checks that
it is healthy, and puts the previous release back if it is not.

- It installs **only signed releases** — a manifest signed by the release keys, and files whose
  sha256 matches that manifest. It never builds anything and never runs code from `main`.
- You stay in control: `MODE=notify` only tells you about a release, `PIN_VERSION` holds the node
  on one release, `MODE=off` (or `AUTO_UPDATE=0` at install time) turns it off.

```bash
rougechain-update status                 # installed / newest release, last result, next check
sudo rougechain-update check             # look now; change nothing
sudo rougechain-update run --now         # install a newer release now (no waiting)
journalctl -t rougechain-update          # everything the updater did, and why
```

On testnet add `--network testnet` (timer `rougechain-update-testnet.timer`).

## What is installed

| | |
|---|---|
| `/usr/local/bin/rougechain-update` | the command (a two-line wrapper) |
| `/usr/local/lib/rougechain/install-validator.sh` | the updater: the installer script itself, run as `install-validator.sh updater …` — one code path for installing and updating |
| `/etc/systemd/system/rougechain-update.timer` | hourly, at a minute that is fixed per host (`RandomizedDelaySec=30min`, `FixedRandomDelay`), `Persistent` |
| `/etc/systemd/system/rougechain-update.service` | `Type=oneshot`, runs `rougechain-update run --network mainnet` as root |
| `/etc/rougechain/<network>/update.conf` | your settings (below) |
| `/var/lib/rougechain-updater/<network>/state` | what the updater remembers: last check, pending release, failed releases. Owned by root — the node's user cannot write it |

The updater runs as root because it replaces files in `/usr/local/bin` and restarts the service.
What it downloads is data to it: manifests and API answers are read with `jq` and every value is
validated before use; nothing downloaded is executed before its sha256 has matched a signed
manifest; the ML-DSA-65 verifier and the `--version` probe of a new binary run as the unprivileged
`rougechain` user. Release sources must be `https://`.

## Trust model

**The trust anchor is the pair of release keys** (Ed25519 and ML-DSA-65; fingerprints in
[Signed releases](releases.md#signatures)). Both public keys are embedded in the installer/updater
script. The private keys are offline on the release owner's machine; the servers that host
releases do not have them.

| Step | Check |
|---|---|
| Manifest | **Ed25519** signature over the manifest file, verified with OpenSSL against the embedded key. Always. |
| Manifest | **ML-DSA-65** signature, verified with the installed `rougechain release verify` (CLI ≥ 1.2.0) against the embedded key. Whenever that CLI is installed; if it fails, the release is refused. The signature file must be present and well-formed in any case. |
| Node binary, CLI, genesis | size and sha256 from the signed manifest |
| The updater itself | replaced **only** by the script whose sha256 is in a signed manifest (the optional `installer` entry) — never by an older one |
| Version | must be higher than the installed one: an old signed manifest cannot be replayed, a stale mirror cannot roll a node back |

A release server or a mirror that is compromised can therefore withhold a release, but it cannot
make a node install anything the release owner did not sign.

**ML-DSA-65 on a node whose CLI cannot verify it yet.** The CLI shipped with node 1.6.0 has no
`release verify`. Such a node updates on the Ed25519 signature alone; as soon as the new release's
CLI is in place — and *before* the node is restarted — the updater verifies the ML-DSA-65
signature with it and undoes the installation if it does not verify. That second check uses a
program delivered by the release being checked, so it catches mistakes, not an attacker who can
forge Ed25519. From the first release whose CLI has `release verify`, every later manifest is
verified with a CLI that an **earlier** verified release installed, before anything is downloaded.

### Where the updater comes from (bootstrap)

The updater is a root program that runs unattended, so the bytes that become it must have a known
origin. There are exactly three cases:

1. **The release names it.** Releases from 1.6.1 on carry an `installer` entry in the signed
   manifest (name, URL, sha256, size). The installer downloads that file, checks the sha256, and
   installs it as the updater — whichever way the installer itself was started. This chains to the
   release keys.
2. **The release does not name it (1.6.0), and you ran the installer from a file**
   (`sudo bash install-validator.sh`). That file becomes the updater. It is trusted exactly as much
   as you already trusted it by running it as root — it is *not* covered by a release signature.
   `rougechain-update status` says so (`from: installer file run by the operator`). The first
   update to a release that names an updater replaces it with the signed one.
3. **The release does not name it, and the installer was piped** (`curl … | sudo bash`). A piped
   script cannot read its own bytes, and downloading "the installer" a second time could yield
   different bytes that nobody verified. **No updater is installed**; the installer says so and
   tells you what to do: re-run the same command once a release with a signed updater is out, or
   download the installer to a file and run that.

Nodes installed before auto-update existed (installer 2.0.0) have no updater either: re-run the
installer once.

## What a run does

1. **Ask every source** (`api.rougechain.io/releases` and the GitHub mirror, or
   `RELEASE_BASE_URLS`) for `manifest-<network>.json` and both signature files. Verify each copy.
2. **Take the newest valid one.** A source that is down, stale, or serving something that does not
   verify is reported and ignored. A release that is not newer than the installed one is ignored.
3. **Decide** (`MODE`, `PIN_VERSION`, releases that failed before, the delay window — below).
4. If the release names a newer updater: verify it, replace the updater, continue as the new one.
5. **Download** the binary and the CLI (primary URL, then mirrors) and check size + sha256. Nothing
   on the node has changed up to here; a failure is just retried at the next run.
6. On a validator: **wait if it is about to propose a block** (below).
7. **Swap** the files in. The previous binary and CLI stay as `<file>.prev`.
8. **Restart** the service — only if the node binary changed and the service was running.
9. **Health check.** If it fails: **roll back**.

The unit file, `node-keys.json`, chain data and `node.env` are never touched. A release that
changes the genesis file is refused (that is a different chain; do it by hand).

### When (timing)

| Release | When it is installed |
|---|---|
| **Optional** (`"mandatory": false`) | after a delay that is random but **fixed per host**, up to `OPTIONAL_DELAY_MAX_SECS` (6 h) after the node first saw the release — so the network's nodes do not all restart together |
| **Mandatory**, upgrade height far away | within `MANDATORY_DELAY_MAX_SECS` (10 min) of first seeing it, again at a per-host offset |
| **Mandatory**, chain within `DEADLINE_MARGIN_BLOCKS` (10) of `upgrade_before_height`, or already past it | immediately: no delay, no proposer deferral |

`rougechain-update run --now` skips the delay. `rougechain-update status` shows a pending release
and the time it is scheduled for.

**Validators.** If the node produces blocks (`--mine`), is the designated proposer of the next
block (`designated_proposer_next` in `/api/stats` is its own key) and has pending transactions
(`rougechain_mempool_size` in `/metrics`), it is about to produce a block. The updater waits —
at most `PROPOSER_DEFER_MAX_SECS` (5 min), then restarts anyway — unless the upgrade height is
near. A restart takes a few seconds; on a network with one designated proposer that is a few
seconds without blocks.

### The health check

After the restart the updater requires, using only the node's public API:

1. `GET /api/health` answers within `HEALTH_START_TIMEOUT_SECS` (2 min);
2. `/api/health` and `/api/stats` report the **chain id** of the release;
3. `/api/stats` → `upgrade_schedule` has **every activation of the manifest at the manifest's
   height** (the one exception is `canonical_ledger_fork`, which nodes do not report);
4. within `HEALTH_DEADLINE_SECS` (5 min) the node **agrees with a reference node and is not behind
   it**. Reference nodes are the node's own `--peers` plus `REFERENCE_URLS`.
   - *Agrees*: at the lower of the two tips, `c = min(local height, reference height)`, both nodes
     have block `c` — its **hash** must be the same (`GET /api/block/c`). When both are at the same
     height, the **state roots** in `/api/stats` must be equal too. A difference has to be seen
     twice in a row to count.
   - *Not behind*: `reference height − local height ≤ HEALTH_MAX_LAG_BLOCKS` (2). A node that was
     still syncing before the update passes if it has advanced since.
   - *An idle chain* (RougeChain produces blocks only when there are transactions) needs nothing
     special: both nodes simply sit at the same height, and block and state root are compared
     there.

**A reference node that cannot be reached is not a reason to roll back.** If no reference could be
compared with for the whole deadline, the node passes on checks 1–3 plus "its height did not go
backwards", and the result is logged as `UNVERIFIED against a reference node`. A reference node
that reports another chain id is ignored. If two references disagree with each other, agreeing
with one of them is enough (and the disagreement is logged).

### Rollback

When a check fails — or a file cannot be written, or the new binary does not even run
(`--version`), or the ML-DSA-65 signature turns out not to verify — the updater:

1. puts the previous binary, CLI and install record back (the failed files are kept as
   `<file>.failed`);
2. restarts the service and waits for the API;
3. records the release as **failed** — it is **not tried again** at the next run (no restart loop);
   a **newer** release is tried;
4. exits non-zero and logs `UPDATE FAILED` / `ROLLING BACK` / `ROLLBACK:` lines with the reason.

| `rougechain-update run` exit code | Meaning |
|---|---|
| `0` | nothing to do, installed, scheduled for later, or notify-only |
| `1` | could not check (no source reachable, nothing validly signed) or refused (settings, genesis change, …). Nothing was changed |
| `3` | the update failed and the previous release was restored |
| `4` | …and the node did **not** answer after the rollback, or a file could not be put back — look at it now (`journalctl -u rougechain-validator -n 100`) |

After fixing the cause: `sudo rougechain-update run --retry-failed`. The systemd unit shows the
failure (`systemctl status rougechain-update`), and `rougechain-update status` names the failed
release and the reason.

A rollback restores programs, not data. If a release ever changes the on-disk format in a way the
previous binary cannot read, its notes will say so.

## Settings: `/etc/rougechain/<network>/update.conf`

Plain `KEY=VALUE` lines; the file is read, never executed. Written once by the installer — your
changes survive re-runs and updates. Something the updater does not understand is reported, and
the safe reading is used (a bad `MODE` or `PIN_VERSION` installs nothing).

| Setting | Default | |
|---|---|---|
| `MODE` | `auto` | `auto` install signed releases · `notify` only report them · `off` do nothing |
| `PIN_VERSION` | empty | stay on exactly this release (e.g. `1.6.1`); nothing newer is installed while it is set, and the updater says so at every run |
| `OPTIONAL_DELAY_MAX_SECS` | `21600` | upper bound of the per-host delay for optional releases |
| `MANDATORY_DELAY_MAX_SECS` | `600` | …for mandatory releases |
| `DEADLINE_MARGIN_BLOCKS` | `10` | this close to `upgrade_before_height`: install immediately |
| `PROPOSER_DEFER_MAX_SECS` | `300` | longest wait for a proposing validator (`0` = never wait) |
| `HEALTH_START_TIMEOUT_SECS` | `120` | time for the API to answer after a restart |
| `HEALTH_DEADLINE_SECS` | `300` | time to agree with a reference node |
| `HEALTH_MAX_LAG_BLOCKS` | `2` | allowed distance behind the reference |
| `REFERENCE_URLS` | empty | extra reference nodes, e.g. `https://node.example.com/api` (space-separated) |
| `RELEASE_BASE_URLS` | empty | where manifests are fetched (space-separated). Empty = `https://api.rougechain.io/releases` and the GitHub mirror |

`rougechain-update status`:

```text
RougeChain auto-update — mainnet
  mode               auto   (/etc/rougechain/mainnet/update.conf)
  pinned version     none
  installed release  1.6.1
  latest seen        1.6.1
  last check         2026-10-02 12:17:03 UTC
  last result        up to date (1.6.1)
  last update        2026-10-02 09:17:41 UTC — 1.6.0 -> 1.6.1: healthy: agrees with https://api.rougechain.io/api (…)
  failed releases    none
  timer              rougechain-update.timer: enabled
  next check         Fri 2026-10-02 13:17:00 UTC
  updater            v2.1.0  (/usr/local/lib/rougechain/install-validator.sh; from: signed release 1.6.1)
```

## Turning it off, pinning, removing

```bash
# notify only: releases are reported in the journal and in `status`, nothing is installed
sudo sed -i 's/^MODE=.*/MODE=notify/' /etc/rougechain/mainnet/update.conf

# off — either of
sudo sed -i 's/^MODE=.*/MODE=off/' /etc/rougechain/mainnet/update.conf
sudo systemctl disable --now rougechain-update.timer

# at install time (also on a re-run): AUTO_UPDATE=0 sets MODE=off and disables the timer
curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh | sudo AUTO_UPDATE=0 bash

# back on
sudo sed -i 's/^MODE=.*/MODE=auto/' /etc/rougechain/mainnet/update.conf
sudo systemctl enable --now rougechain-update.timer

# remove the updater completely (the node keeps running; upgrade by re-running the installer
# with AUTO_UPDATE=0 — a re-run without it would set the timer up again unless update.conf says MODE=off)
sudo systemctl disable --now rougechain-update.timer
sudo sed -i 's/^MODE=.*/MODE=off/' /etc/rougechain/mainnet/update.conf
sudo rm -f /etc/systemd/system/rougechain-update.timer /etc/systemd/system/rougechain-update.service \
  /usr/local/bin/rougechain-update && sudo systemctl daemon-reload
```

Re-running the installer **without** `AUTO_UPDATE` keeps your `update.conf` as it is — an opt-out
stays an opt-out. With auto-update off (or pinned) **you** are responsible for installing mandatory
releases before their upgrade height.

## At a mandatory upgrade (fork)

A mandatory release has `"mandatory": true` and an `upgrade_before_height`. Every node must run it
before the chain reaches that height; a node that does not stops following the chain there.

- `MODE=auto`: the node installs it within about an hour of publication (the timer) plus at most
  10 minutes, and immediately once the chain is within 10 blocks of the height.
- `MODE=notify` / `PIN_VERSION` / a release that **failed** on this node: the updater does not
  install it and repeats, at every run, that a mandatory release is waiting and at which height.
  Watch the journal, or `rougechain-update status` (`latest seen … (mandatory, before block N)`).
- If the update fails its health check **before** the upgrade height, the node goes back to the
  previous release and keeps working until that height — you have until then to find out why
  (`journalctl -t rougechain-update`).
- Whatever the mode, the check to make yourself before the height is the one in each upgrade note:
  `/api/stats` → `upgrade_schedule` shows the new activation.

## Not covered

- Nodes built from source, Docker nodes and Windows nodes: upgrade them as before.
- Changes to the systemd unit or to installer settings (`VALIDATOR`, `PUBLIC_URL`, ports): re-run
  the installer.
- The old git-pull "auto-deploy" script is retired: it built and ran whatever was on `main`.
