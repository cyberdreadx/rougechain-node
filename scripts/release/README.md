# Release tooling — signed release manifests

A node release is described by one **manifest** per network (`releases/manifest-mainnet.json`,
`releases/manifest-testnet.json`) and authenticated by two **detached signatures** over the exact
bytes of that file:

| File | What |
|---|---|
| `manifest-<network>.json` | the release: version; name/URL/mirrors/sha256/size of the node binary, the `rougechain` CLI, the genesis file and (optional) the installer/updater script; activation heights |
| `manifest-<network>.json.ed25519.sig` | Ed25519 signature (base64 of 64 bytes) — checked by `scripts/install-validator.sh` (installer and updater) with stock OpenSSL 3 |
| `manifest-<network>.json.mldsa65.sig` | ML-DSA-65 signature (base64 of 3309 bytes) — checked on nodes by `rougechain release verify` (CLI ≥ 1.2.0), by `verify-manifest.mjs`, and by OpenSSL ≥ 3.5 |

A release is valid only with **both** signatures. Public keys live in `releases/keys/`; the
private keys live only in a passphrase-encrypted file on the release owner's machine. Schema and
by-hand verification: [`docs/running-a-node/releases.md`](../../docs/running-a-node/releases.md).

## Tools

Node.js ≥ 20. One pinned dependency (`@noble/post-quantum`, for ML-DSA-65); Ed25519, scrypt and
AES-GCM come from `node:crypto`.

```bash
cd scripts/release && npm ci
```

| Script | Where it runs | What it does |
|---|---|---|
| `keygen.mjs` | owner's machine, once | generates both key pairs; private keys go into an encrypted key file (scrypt N=2^17 + AES-256-GCM), never plaintext |
| `embed-installer-key.mjs` | owner's machine, once | writes both public keys (Ed25519 and ML-DSA-65) into `scripts/install-validator.sh` |
| `make-manifest.mjs` | build host | builds a manifest from the node binary, the CLI, the genesis file and the installer/updater script (sha256, size) and release facts; validates it; refuses to overwrite silently |
| `sign-manifest.mjs` | owner's machine | shows the manifest, asks you to type the version, decrypts the key file, writes both `.sig` files. Works offline |
| `verify-manifest.mjs` | anywhere, CI | schema + both signatures + (optionally) binary/CLI/genesis/installer hashes + the keys embedded in the installer. Exit 0 verified, 1 invalid, 2 unsigned |
| `test-installer.sh` | dev machine with Docker | end-to-end installer tests (see below) |
| `test-updater.sh` | dev machine with Docker | end-to-end auto-updater tests, mutation check, optional real-node run (see below) |

Every script has `--help`.

## One-time setup (release owner, on your own machine — not the server)

```bash
git clone <this repo> && cd <repo>/scripts/release && npm ci

# 1. Generate the keys. You are asked for a passphrase (min. 12 characters) twice.
node keygen.mjs --out ~/rougechain-release-keys.json --pub-dir ../../releases/keys

# 2. Put both public keys (Ed25519 + ML-DSA-65) into the installer.
node embed-installer-key.mjs

# 3. Record both fingerprints (keygen printed them; `node sign-manifest.mjs --key … --show-public`
#    prints them again) in releases/keys/README.md and docs/running-a-node/releases.md.

# 4. Sign the current manifests (see "Every release", steps 3-4), then commit:
#    releases/keys/release-ed25519.pub.pem, releases/keys/release-mldsa65.pub,
#    scripts/install-validator.sh, releases/manifest-*.json.*.sig, the two docs.
```

Back up `~/rougechain-release-keys.json` offline (it is encrypted; the passphrase is not in it).
Without the file **or** without the passphrase you cannot sign releases any more, and nodes installed
with the current installer will accept nothing else. Never copy the key file to a server, into the
repository, or into a chat.

From the moment the public keys are committed, `verify-manifest.mjs` (and CI) treat a manifest
without signatures as **invalid**.

## Every release

**1. Build** (build host) — the existing reproducible build (two clean builds, byte-identical) of
the node (`quantum-vault-daemon`) **and the CLI** (`rougechain`, package `quantum-vault-cli`) from the
same commit. Place both in the release directory under unique names:

```bash
R=/srv/rougechain-releases
sudo install -m 0644 <built quantum-vault-daemon> $R/quantum-vault-daemon-<tag>-<commit>
sudo install -m 0644 <built rougechain>           $R/rougechain-<commit>
```

**1b. The updater artifact.** Nodes with [auto-update](../../docs/running-a-node/auto-update.md)
replace their installed updater **only** with the script named in a signed manifest, so every
release names one: `scripts/install-validator.sh` as it is at the release commit, published under
a name that contains its version and the first 8 hex digits of its sha256 (immutable: a changed
script gets a new name).

```bash
I=scripts/install-validator.sh
node scripts/release/verify-manifest.mjs --quiet --check-installer "$I" releases/manifest-mainnet.json   # both embedded keys = releases/keys/
IN=install-validator-$(sed -n 's/^INSTALLER_VERSION="\(.*\)"$/\1/p' "$I")-$(sha256sum "$I" | cut -c 1-8).sh
sudo install -m 0644 "$I" /srv/rougechain-releases/$IN
```

- Bump `INSTALLER_VERSION` in the script whenever its behaviour changes (PATCH for fixes, MINOR for
  features). Nodes never replace their updater with an older version; an equal version with other
  bytes replaces it.
- After the manifest is made (step 2) **do not edit the script on the release branch** — the
  manifest pins its bytes. (`main` may move on later: nodes take the updater from the manifest's
  URLs, not from `main`.)
- A node starts an update with the updater that an earlier release installed. Before it installs
  anything else it replaces itself with the script this release names (if that is newer, or the
  same version with other bytes) and continues as that script. So new updater behaviour reaches
  nodes with the release that carries it. `--min-installer-version` is the guard for the rest: an
  updater or installer older than it — and unable to update itself from this manifest — refuses
  the release instead of installing it wrongly.

**2. Make the manifests** (build host, on a release branch):

```bash
git rm -q --ignore-unmatch releases/manifest-*.sig          # old signatures do not apply to a new manifest
V=1.7.0
B=/srv/rougechain-releases/quantum-vault-daemon-<tag>-<commit>
C=/srv/rougechain-releases/rougechain-<commit>
GH=https://github.com/cyberdreadx/rougechain-node/releases/download/v$V     # mirror: GitHub release assets (step 9)
RAW=https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main

node scripts/release/make-manifest.mjs --force --network mainnet --version $V \
  --binary "$B" --binary-mirror "$GH/$(basename "$B")" \
  --cli "$C"    --cli-mirror    "$GH/$(basename "$C")" \
  --installer "$I" --installer-mirror "$GH/$IN" \
  --genesis core/daemon/genesis-mainnet.json \
  --genesis-mirror "$GH/genesis-mainnet.json" --genesis-mirror "$RAW/core/daemon/genesis-mainnet.json" \
  --source-commit <commit> --public-commit <public commit, if already synced> \
  --mandatory --upgrade-before-height <H> \
  --activation <name>=<height> [--activation …] \
  --notes-url https://docs.rougechain.io/running-a-node/<upgrade-note>.html

node scripts/release/make-manifest.mjs --force --network testnet --version $V \
  --binary "$B" --binary-mirror "$GH/$(basename "$B")" \
  --cli "$C"    --cli-mirror    "$GH/$(basename "$C")" \
  --installer "$I" --installer-mirror "$GH/$IN" \
  --no-genesis --source-commit <commit> \
  --activation <name>=<height> [--activation …]

git add releases/ && git commit -m "release: node $V manifests (unsigned)" && git push
```

- The published file names are the manifest's `name` fields: the binary keeps the basename of
  `--binary`; the CLI is published as `rougechain-<source commit>` unless you pass `--cli-name`
  (so `--cli` may point at a file simply called `rougechain`). Primary URLs default to
  `https://api.rougechain.io/releases/<name>`.
- `--binary-mirror`, `--cli-mirror` and `--genesis-mirror` are repeatable; mirrors are tried in the
  order given, after the primary. If no `--genesis-mirror` is given, the genesis file's mirror is
  the public repository's raw file.
- `--no-cli` makes a release without the CLI (`"cli": null`); the installer then tells operators
  to build it from source. Ship the CLI: nodes verify the ML-DSA-65 signature of the **next**
  release with the CLI this release installs (`rougechain release verify`, CLI ≥ 1.2.0).
- `--installer` is optional for the tool (a manifest without it is valid, as the 1.6.0 ones are),
  but a release without it cannot bring the updater to a node, or update the updater.
  `make-manifest` names the entry `install-validator-<version>-<sha256[0:8]>.sh` — the `$IN` above —
  and refuses a script with a placeholder key or a version below `--min-installer-version`.
- List the network's full activation schedule (`core/daemon/src/upgrades.rs`), not only the new heights.
- **The activations are checked on every node.** After an update, the updater compares each
  `--activation name=height` with `upgrade_schedule` in the restarted node's `GET /api/stats` and
  **rolls the release back** on any difference (a name the node does not report, another height).
  Before signing, run the release binary once and compare (the one name nodes do not report is
  `canonical_ledger_fork`; the updater skips exactly that name):

  ```bash
  curl -s localhost:<port>/api/stats | jq .upgrade_schedule       # the binary being released
  jq -c '.activations[]' releases/manifest-mainnet.json
  ```
- `--mandatory --upgrade-before-height <H>`: nodes install a mandatory release within minutes of
  seeing it, and at once when their chain is within 10 blocks of `H`. Without `--mandatory` a
  release is optional: nodes install it at a per-host random time within 6 hours.
- The mirror URLs are signed as part of the manifest **before** the GitHub release exists; that is
  fine — a mirror is only used when the primary fails, and whatever it serves must match the signed
  sha256. The version in the URL (`v$V`) must be the tag you create in step 9.

**3. Get the manifests onto your machine** — `git pull` the release branch (or `scp` the two
manifest files). Before signing, check the binary sha256 in the manifest against your build
record, not just against the server.

**4. Sign** (your machine; no network needed):

```bash
cd scripts/release
node sign-manifest.mjs --key ~/rougechain-release-keys.json ../../releases/manifest-mainnet.json
node sign-manifest.mjs --key ~/rougechain-release-keys.json ../../releases/manifest-testnet.json
node verify-manifest.mjs ../../releases/manifest-mainnet.json     # VERIFIED
node verify-manifest.mjs ../../releases/manifest-testnet.json     # VERIFIED
```

Each `sign-manifest` run prints the release, asks you to type its version, then asks for the
passphrase and writes `<manifest>.ed25519.sig` and `<manifest>.mldsa65.sig`.

**5. Put the `.sig` files back** — commit the four `.sig` files to the release branch and push
(or `scp` them next to the manifests on the build host).

**6. Verify on the build host**, against the real files — gate on the exit code:

```bash
git pull
for net in mainnet testnet; do
  node scripts/release/verify-manifest.mjs --network $net --binary "$B" --cli "$C" \
    --installer "$I" --check-installer "$I" releases/manifest-$net.json || exit 1
  # the check nodes make: the CLI of this release verifies the ML-DSA-65 signature
  "$C" release verify --manifest releases/manifest-$net.json --sig releases/manifest-$net.json.mldsa65.sig \
    --pubkey releases/keys/release-mldsa65.pub || exit 1
done
node scripts/release/verify-manifest.mjs --genesis core/daemon/genesis-mainnet.json releases/manifest-mainnet.json || exit 1
```

**7. Publish** to `https://api.rougechain.io/releases/` (nginx serves `/srv/rougechain-releases/`).
Signatures first, manifest last, so a manifest is never served without its signature:

```bash
R=/srv/rougechain-releases        # the binary, the CLI and the updater script are already there (steps 1, 1b)
sudo install -m 0644 core/daemon/genesis-mainnet.json $R/genesis-mainnet.json
for net in mainnet testnet; do
  sudo install -m 0644 releases/manifest-$net.json.ed25519.sig releases/manifest-$net.json.mldsa65.sig $R/
  sudo install -m 0644 releases/manifest-$net.json $R/manifest-$net.json
done
```

Then check what is actually served:

```bash
T=$(mktemp -d) && for f in manifest-mainnet.json manifest-mainnet.json.ed25519.sig manifest-mainnet.json.mldsa65.sig; do
  curl -fsS -o $T/$f https://api.rougechain.io/releases/$f || exit 1; done
node scripts/release/verify-manifest.mjs --binary "$B" --cli "$C" $T/manifest-mainnet.json     # VERIFIED
bash scripts/install-validator.sh --dry-run        # downloads + verifies exactly as an operator's install would
```

(`--dry-run` needs `curl`, `openssl` and `jq` on the machine it runs on and changes nothing. It
downloads from the primary URLs; the mirrors are checked in step 9.)

**From this moment nodes with auto-update install the release by themselves** — within about an
hour (their timer), plus the per-host delay. Publish only what you have verified; to stop a
rollout, publish a higher version (nodes never go back to a lower one).

**8. Merge and sync** — merge the release branch to `main`, then run the public sync
(`rougechain-node`). The public repository is the installer's mirror
(`raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases/`), and it is where
operators download `install-validator.sh` from, so the release is not complete until the sync is.

**9. Create the GitHub release (mirror for the files)** — on the **public** repository, after the
sync, create release `v<version>` and attach exactly these files, under exactly the names in the
manifest:

| Asset | From |
|---|---|
| `quantum-vault-daemon-<tag>-<commit>` | `binary.name` — the node binary |
| `rougechain-<commit>` | `cli.name` — the CLI |
| `genesis-mainnet.json` | `core/daemon/genesis-mainnet.json` |
| `install-validator-<version>-<sha8>.sh` | `installer.name` — the updater script (`$R/$IN` from step 1b) |

```bash
# asset names are the files' basenames, so $B and $C must be named as in step 1
gh release create v$V --repo cyberdreadx/rougechain-node --target main --title "Node $V" \
  --notes "Signed release $V. Verify: https://docs.rougechain.io/running-a-node/releases.html" \
  "$B" "$C" core/daemon/genesis-mainnet.json "/srv/rougechain-releases/$IN"
```

The **manifests and signatures are not release assets**: their mirror is the repository's raw
files (`raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases/`), which the sync in
step 8 updates. Release assets are the mirror for the files above only. GitHub answers an
asset URL with a redirect; the installer follows it and still requires size and sha256 to match the
signed manifest. Check every mirror URL in the manifest once:

```bash
for f in binary cli genesis installer; do
  for u in $(jq -r ".$f.mirrors[]" releases/manifest-mainnet.json); do
    echo "$(jq -r ".$f.sha256" releases/manifest-mainnet.json)  -" > /tmp/want
    curl -fsSL "$u" | sha256sum -c /tmp/want > /dev/null && echo "OK   $u" || echo "FAIL $u"
  done
done
```

**10. Announce** — upgrade note under `docs/running-a-node/`, `docs/running-a-node/upgrade-schedule.md`,
and `apps/*/public/status/releases.json`.

## Versions

`version` is `MAJOR.MINOR.PATCH`, per network, and must **increase** with every release: the
installer refuses to install a release older than the one already installed (protection against
a replayed old manifest), unless the operator sets `ALLOW_DOWNGRADE=1`.

- MINOR — a release that carries a new consensus activation (a mandatory upgrade)
- PATCH — everything else (fixes, API changes, no new activation height)
- MAJOR — reserved for a new chain or an incompatible data format

`1.6.0` is the first release with a manifest (TOKEN_MINTING + CONTRACT_NFT_ROYALTY, mainnet 235).

`min_installer_version` is the oldest `install-validator.sh` (`INSTALLER_VERSION`) that can install
the release; raise it (`--min-installer-version`) only when a release needs a newer installer.

## Auto-update: the first release with an updater (1.6.1)

Nodes installed from the 1.6.0 manifests have **no updater from a signed source**: 1.6.0 has no
`installer` entry, so a piped install (`curl … | sudo bash`) sets up no updater at all, and nodes
installed with installer 2.0.0 predate it. Nothing on those nodes runs by itself, so no release can
reach them automatically. What gets them onto auto-update:

1. **Publish 1.6.1 with `--installer`** (steps 1b–9), built with a CLI ≥ 1.2.0. It may carry the
   same node binary as 1.6.0 (then the node is not even restarted) — keep `--mandatory
   --upgrade-before-height` and the activation list exactly as in 1.6.0 if the fork height has not
   passed.
2. **Ask operators to re-run the one-line installer once.** That run installs 1.6.1, takes the
   updater from its signed manifest, and enables the timer. From then on releases arrive by
   themselves.

Until 1.6.1 is published, a piped install prints "AUTO-UPDATE WAS NOT INSTALLED" and what to do.

## If the key file or passphrase is lost, or the key is compromised

Generate new keys (`keygen.mjs` into a new file, remove the old public keys from `releases/keys/`
first), run `embed-installer-key.mjs --rotate`, re-sign the manifests, publish, sync, and announce
the new fingerprints through a channel that does not depend on the old key. Operators must
download the new installer; nothing on their nodes trusts the old key after that.

With auto-update there is a second path for a **planned** rotation (old key not compromised):
publish one release, signed with the **old** keys, whose `installer` entry is the script with the
**new** keys embedded. Nodes verify that manifest with the old keys, replace their updater with
the new script, and trust the new keys from the next release on. If the old key is compromised
this path is not safe — its holder can do the same; nodes with auto-update on would have to be
told out-of-band to re-run the new installer (and to set `MODE=off` in the meantime).

## Tests

```bash
cd scripts/release
npm test                                    # tooling: round trip + tamper/wrong-key/garbage/schema cases
./test-installer.sh                         # installer in Docker: ubuntu:24.04, debian:12, ubuntu:22.04
REAL_BINARY=<node binary> REAL_CLI=<rougechain binary> ./test-installer.sh    # + the real binaries

(cd ../../core && cargo build -p quantum-vault-cli)      # a CLI with `release verify` for the next suite
./test-updater.sh                           # auto-updater in Docker, same three images
./test-updater.sh --mutations               # the suite must FAIL with each safeguard removed
REAL_BINARY=<node binary> REAL_CLI=<its rougechain CLI> ./test-updater.sh     # + a real node, updated and health-checked against mainnet (read-only)
```

`test-updater.sh` runs the installed updater against fake node binaries that serve the node API
with a chosen defect, a fake reference node and a stand-in for `systemctl` (there is no systemd in
a container), so that restart, health check and rollback really happen. What is **not** covered by
either suite is a run under real systemd (the timer firing, the unit's sandbox options); the
units are only checked with `systemd-analyze verify`.

The tests generate their own throw-away keys in a temp directory. They never read or write
`releases/keys/`, and the installer accepts a test key only when **both**
`ROUGECHAIN_INSTALLER_TEST=1` and `ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=<pem>` are set (it prints a
warning banner and stamps the unit's description).
