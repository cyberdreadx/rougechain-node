# Signed releases

Node releases are published as a prebuilt `quantum-vault-daemon` binary and the `rougechain` CLI
(Linux x86_64), described by a **signed release manifest**. The installer, the
[automatic updater](auto-update.md) and anyone verifying by hand check the same thing:
the manifest's signatures, then each file's sha256 and size against the manifest.


## Where releases are published

| What | Primary | Mirror |
|---|---|---|
| Manifest + signatures | `https://api.rougechain.io/releases/manifest-<network>.json` (+ `.ed25519.sig`, `.mldsa65.sig`) | `https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases/` |
| Node binary | `binary.url` in the manifest (`https://api.rougechain.io/releases/<name>`) | `binary.mirrors`: asset of the GitHub release `v<version>` |
| `rougechain` CLI | `cli.url` in the manifest | `cli.mirrors`: asset of the GitHub release `v<version>` |
| Genesis file | `genesis.url` in the manifest | `genesis.mirrors`: GitHub release asset, and `core/daemon/` in the public repository |
| Installer / updater script (releases from 1.6.1) | `installer.url` in the manifest | `installer.mirrors`: asset of the GitHub release `v<version>` |
| Public keys | [`releases/keys/`](https://github.com/cyberdreadx/rougechain-node/tree/main/releases/keys) in the public repository | — |

`<network>` is `mainnet` or `testnet`. GitHub release assets are at
`https://github.com/cyberdreadx/rougechain-node/releases/download/v<version>/<name>` (GitHub answers
with a redirect to the file). The manifest and its signatures are mirrored as files of the
repository, not as release assets. A mirror cannot weaken anything: a file from any source is
used only if the manifest's signature verifies and the file's sha256 matches the manifest.

## The manifest (`schema: 1`)

```json
{
  "schema": 1,
  "network": "mainnet",
  "chain_id": "rougechain-mainnet-1",
  "version": "1.6.0",
  "released": "2026-10-01",
  "source_commit": "03613ef",
  "public_commit": "e048bf1",
  "binary": {
    "name": "quantum-vault-daemon-mint-royalty-03613ef",
    "url": "https://api.rougechain.io/releases/quantum-vault-daemon-mint-royalty-03613ef",
    "mirrors": ["https://github.com/cyberdreadx/rougechain-node/releases/download/v1.6.0/quantum-vault-daemon-mint-royalty-03613ef"],
    "sha256": "673bf7b1a469b7f9937b17228faab1e81ae48fb2a90aa32b2fd1b7fcc9cc2984",
    "size": 28463856
  },
  "cli": { "name": "rougechain-03613ef", "url": "…", "mirrors": ["…"], "sha256": "…", "size": 0 },
  "genesis": { "name": "genesis-mainnet.json", "url": "…", "mirrors": ["…"], "sha256": "…", "size": 4460 },
  "installer": { "name": "install-validator-2.1.0-1a2b3c4d.sh", "url": "…", "mirrors": ["…"], "sha256": "…", "size": 0 },
  "mandatory": true,
  "upgrade_before_height": 235,
  "activations": [ { "name": "token_minting", "height": 235 }, { "name": "contract_nft_royalty", "height": 235 } ],
  "notes_url": "https://docs.rougechain.io/running-a-node/mandatory-upgrade-2026-10.html",
  "min_installer_version": "2.0.0"
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | integer | Manifest format version. `1`. |
| `network` | string | `mainnet` or `testnet`. |
| `chain_id` | string | `rougechain-mainnet-1` or `rougechain-devnet-1`; must match `network`. |
| `version` | string | Node release version, `MAJOR.MINOR.PATCH`. Increases with every release of a network. MINOR = a release with a new consensus activation; PATCH = everything else. |
| `released` | string | ISO date (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`). |
| `source_commit` | string | Git commit the binary was built from. |
| `public_commit` | string or null | The commit of the public `rougechain-node` repository that contains that source. |
| `binary` | object | The node (`quantum-vault-daemon`): `name`, `url` (primary), `mirrors` (array of URLs, tried in order after `url`), `sha256` (lowercase hex), `size` (bytes). |
| `cli` | object or null | Same shape as `binary`, for the `rougechain` CLI built from the same commit. `null` when a release ships no CLI. |
| `genesis` | object or null | Same shape as `binary`, for the genesis file the node is started with. `null` when the network runs on default parameters (testnet). |
| `installer` | object, **optional** | Same shape as `binary`, for `install-validator.sh` — the script nodes keep as their [updater](auto-update.md). A node replaces its updater only with the file named here. The field is either absent or a complete entry (never `null`). The 1.6.0 manifests were signed before it existed and do not have it. |
| `mandatory` | boolean | `true` if every node of the network must install this release. |
| `upgrade_before_height` | integer or null | Install before this block height (the first activation the release introduces). |
| `activations` | array | The network's upgrade schedule carried by this binary: `{ "name", "height" }`. Names are the `upgrade_schedule` fields of `GET /api/stats`. |
| `notes_url` | string or null | Release / upgrade notes. |
| `min_installer_version` | string | Oldest `install-validator.sh` that can install this release. |

The example is abridged (`…`).

All URLs are `https://`. Unknown fields are not allowed in schema 1; `installer` is the one
optional field (an addition that old installers ignore, so the schema number did not change). The current manifests list the
full schedule in `activations` (mainnet: 49, 90, 100, 150, 150, 160, 170, 190, 235, 235) — see the
[upgrade schedule](upgrade-schedule.md).

## Signatures

The signed object is the **manifest file itself**: both signatures are over its exact bytes
(no canonicalisation — a manifest that is re-formatted no longer verifies).

| File | Algorithm | Encoding |
|---|---|---|
| `manifest-<network>.json.ed25519.sig` | Ed25519 (RFC 8032) | base64 of the raw 64-byte signature |
| `manifest-<network>.json.mldsa65.sig` | ML-DSA-65 (FIPS 204), empty context | base64 of the raw 3309-byte signature |

A release must carry **both**, and the installer and updater refuse a manifest without a
well-formed copy of each. They always verify the Ed25519 signature (stock OpenSSL 3.0 of Ubuntu
22.04/24.04 and Debian 12). They verify the ML-DSA-65 signature with the installed `rougechain` CLI
— `rougechain release verify`, CLI ≥ 1.2.0 — whenever one is installed, and refuse the release if it
does not verify; details in [Automatic updates — trust model](auto-update.md#trust-model). The
release tooling and CI check both, and OpenSSL 3.5 or newer can check ML-DSA-65 by hand.

Public keys: `releases/keys/release-ed25519.pub.pem` (PEM) and `releases/keys/release-mldsa65.pub`
(hex of the raw 1952-byte key). The private keys are held offline by the release owner; they are
not on the release server.

| Key | Fingerprint (SHA-256 of the raw public key) |
|---|---|
| Ed25519 | `79bf33d554ee6d39e5819d94a04d941da9b0e4aeef42eb1106289c5030d4a040` |
| ML-DSA-65 | `ac4497980205f2ccbd810048bcd5ffd819d82400730cfbead41157cc56781b3c` |

## Verify a release by hand

```bash
NET=mainnet
BASE=https://api.rougechain.io/releases
KEYS=https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases/keys

curl -fsSLO $BASE/manifest-$NET.json
curl -fsSLO $BASE/manifest-$NET.json.ed25519.sig
curl -fsSLO $KEYS/release-ed25519.pub.pem

# 1. The key is the one you expect (compare with the fingerprint table above)
openssl pkey -pubin -in release-ed25519.pub.pem -outform DER | tail -c 32 | sha256sum

# 2. The manifest is signed by that key  →  "Signature Verified Successfully"
base64 -d manifest-$NET.json.ed25519.sig > manifest.sig.bin
openssl pkeyutl -verify -pubin -inkey release-ed25519.pub.pem -rawin \
  -in manifest-$NET.json -sigfile manifest.sig.bin

# 3. The files are the ones the manifest describes  →  "OK" and "size OK" for each
for f in binary cli; do                      # drop "cli" if the manifest has "cli": null
  name=$(jq -r .$f.name manifest-$NET.json)
  curl -fL -o "$name" "$(jq -r .$f.url manifest-$NET.json)"     # or one of .$f.mirrors[]
  echo "$(jq -r .$f.sha256 manifest-$NET.json)  $name" | sha256sum -c
  test "$(stat -c %s "$name")" = "$(jq -r .$f.size manifest-$NET.json)" && echo "size OK"
done
```

Get the public key from the Git repository (or from a copy you saved earlier), not from the same
server that serves the manifest.

**ML-DSA-65 signature** — with the `rougechain` CLI (≥ 1.2.0; offline, no wallet or node needed):

```bash
curl -fsSLO $BASE/manifest-$NET.json.mldsa65.sig
curl -fsSLO $KEYS/release-mldsa65.pub
rougechain release verify --manifest manifest-$NET.json --sig manifest-$NET.json.mldsa65.sig --pubkey release-mldsa65.pub
# VERIFIED: ML-DSA-65 signature of manifest-mainnet.json (release key ac449798…)     exit 0
# exit 1 = the signature does not verify, exit 2 = a file is missing or malformed
```

The fingerprint it prints is the SHA-256 of the raw public key — compare it with the table above.

or with OpenSSL ≥ 3.5 (e.g. Debian 13):

```bash
curl -fsSLO $BASE/manifest-$NET.json.mldsa65.sig
curl -fsSLO $KEYS/release-mldsa65.pub
tr -d '\n' < release-mldsa65.pub | xxd -r -p | sha256sum              # fingerprint
# raw key → SubjectPublicKeyInfo (the hex prefix is the fixed ML-DSA-65 header)
{ printf '308207b2300b0609608648016503040312038207a100'; tr -d '\n' < release-mldsa65.pub; } | xxd -r -p > mldsa65.der
openssl pkey -pubin -inform DER -in mldsa65.der -out mldsa65.pem
base64 -d manifest-$NET.json.mldsa65.sig > manifest.mldsa.bin
openssl pkeyutl -verify -pubin -inkey mldsa65.pem -in manifest-$NET.json -sigfile manifest.mldsa.bin
```

or, on any machine with Node.js ≥ 20, both signatures and the binary in one step from a checkout
of the repository:

```bash
cd scripts/release && npm ci
node verify-manifest.mjs --binary /path/to/the/binary --cli /path/to/rougechain ../../releases/manifest-mainnet.json   # exit 0 = VERIFIED
```

## What the installer does

[`scripts/install-validator.sh`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/install-validator.sh)
(Ubuntu 22.04 / 24.04, Debian 12; x86_64; run as root):

1. downloads `manifest-<network>.json`, its `.ed25519.sig` and its `.mldsa65.sig` from **every**
   source (the primary and the mirror);
2. verifies each copy's Ed25519 signature with `openssl` against the release key **embedded in the
   script** — it never downloads a key — and, when a `rougechain` CLI with `release verify` is
   already installed, its ML-DSA-65 signature against the embedded ML-DSA-65 key. It uses the
   **newest** release that verifies (a stale mirror cannot hold a node back) and stops if no source
   provides one;
3. checks the manifest is for the requested network, and is not older than the release already
   installed (`ALLOW_DOWNGRADE=1` overrides);
4. downloads the node binary, the `rougechain` CLI (when the manifest has one), the genesis file
   and the updater script (when the manifest names one) — primary URL, then mirrors, following
   redirects — and requires size and sha256 of each to match the signed manifest;
5. installs, as described below, and keeps the previous binaries as `<file>.prev`. If the
   ML-DSA-65 signature could not be checked in step 2 (no CLI yet), it is checked now with the CLI
   just installed, before the service is started; a release that fails is removed again;
6. sets up [automatic updates](auto-update.md): the updater, `rougechain-update`, a systemd timer
   and `/etc/rougechain/<network>/update.conf` (`AUTO_UPDATE=0` to opt out).

It never overwrites `node-keys.json` or chain data. `--dry-run` performs steps 1–4 and changes
nothing.

| | mainnet | testnet |
|---|---|---|
| Service | `rougechain-validator` | `rougechain-validator-testnet` |
| Node binary | `/usr/local/bin/quantum-vault-daemon` | `/usr/local/bin/quantum-vault-daemon-testnet` |
| CLI | `/usr/local/bin/rougechain` | `/usr/local/bin/rougechain-testnet` |
| Data + `node-keys.json` (`DATA_DIR`) | `/var/lib/rougechain/mainnet` | `/var/lib/rougechain/testnet` |
| Genesis, installed manifest, optional `node.env`, `update.conf` | `/etc/rougechain/mainnet/` | `/etc/rougechain/testnet/` |
| Auto-update timer | `rougechain-update.timer` | `rougechain-update-testnet.timer` |
| API (`HOST`:`API_PORT`) | `127.0.0.1:5100` | `127.0.0.1:5101` |
| gRPC port (`P2P_PORT`) | `4100` | `4101` |
| Peer (`PEERS`) | `https://api.rougechain.io/api` | `https://testnet.rougechain.io/api` |

The service runs as the system user `rougechain` (no login shell). The data directory is `0700`,
`node-keys.json` is `0600`, both owned by that user. The systemd unit lets the node write only to
its data directory (`ProtectSystem=strict`, `ReadWritePaths=<data dir>`) and removes privileges
(`NoNewPrivileges`, empty capability set, `PrivateTmp`, `PrivateDevices`, `ProtectHome`,
`ProtectKernel*`, `RestrictAddressFamilies`, `UMask=0077`). `--mine` is added only with
`VALIDATOR=1`. Extra `QV_*` settings go in `/etc/rougechain/<network>/node.env`; the unit file
itself is rewritten on every run.

**The CLI and the node key.** `node-keys.json` can be read only by the `rougechain` user (and
root), so run the CLI as that user:

```bash
sudo -u rougechain rougechain --node-keys /var/lib/rougechain/mainnet/node-keys.json whoami      # also: stake 10000, validator-status
```

Without `sudo`, as root: `runuser -u rougechain -- rougechain …`. On testnet the commands are
`rougechain-testnet --network testnet --node-keys /var/lib/rougechain/testnet/node-keys.json …`.
The CLI submits to the network's public node (`https://api.rougechain.io`, or
`https://testnet.rougechain.io` with `--network testnet`) through the signed `/api/v2` routes; see
[CLI Wallet](../advanced/cli.md).

Settings: `NETWORK`, `NODE_NAME`, `PUBLIC_URL`, `VALIDATOR`, `DATA_DIR`, `API_PORT`, `P2P_PORT`,
`HOST`, `PEERS`, `AUTO_UPDATE`, `NO_START`, `ALLOW_DOWNGRADE`, `REPLACE_LEGACY_UNIT`,
`RELEASE_BASE_URLS` — see the header of the script.

### Upgrading

**Automatic** — by default the node upgrades itself: see [Automatic updates](auto-update.md)
(what it checks, how to make it notify-only, pin a version or turn it off, and what happens when an
update fails). `rougechain-update status` shows where a node stands.

**By hand** — re-run the installer; this always works, with auto-update on or off. It verifies the
new signed release, replaces the binary and the CLI, and restarts the
service (with `NO_START=1` it installs without restarting, so you can restart at a time you
choose: `systemctl restart rougechain-validator`). Unlike the updater, a manual run does not
health-check the node afterwards or roll back. To go back to the previous binary:

```bash
sudo systemctl stop rougechain-validator
sudo cp -p /usr/local/bin/quantum-vault-daemon.prev /usr/local/bin/quantum-vault-daemon
sudo systemctl start rougechain-validator
```

A node installed with installer 2.0.0 (before auto-update existed) has no updater: re-run the
installer once to get it. Whether that run can install the updater depends on the release —
see [where the updater comes from](auto-update.md#where-the-updater-comes-from-bootstrap).

### Nodes installed from source

A node set up with the earlier source-build installer (repository in `~/rougechain`, data in
`~/.quantum-vault/mainnet`, unit `rougechain-validator` running as your login user) is not changed
silently: the installer stops when it finds a unit it did not write. To move such a node to signed
releases, keep its whole data directory — it holds `node-keys.json` (your validator identity) and
the vote journal:

```bash
sudo systemctl stop rougechain-validator
cp -a ~/.quantum-vault/mainnet ~/mainnet.backup-$(date +%Y%m%d)        # backup, incl. node-keys.json
sudo useradd --system --user-group --home-dir /var/lib/rougechain --no-create-home --shell /usr/sbin/nologin rougechain
sudo mkdir -p /var/lib/rougechain
sudo mv ~/.quantum-vault/mainnet /var/lib/rougechain/mainnet
sudo chown -R rougechain:rougechain /var/lib/rougechain
curl -sSL https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/scripts/install-validator.sh \
  | sudo REPLACE_LEGACY_UNIT=1 VALIDATOR=1 PUBLIC_URL=https://node.example.com bash
```

Use the `VALIDATOR` / `PUBLIC_URL` / `NODE_NAME` values your node ran with (`VALIDATOR=1` only if it
ran with `--mine`). The old unit is kept as `rougechain-validator.service.legacy`. With
`REPLACE_LEGACY_UNIT=1` the installer refuses to continue if there is no `node-keys.json` in the
data directory, so an existing node never ends up with a new identity. Never run two nodes with
the same `node-keys.json`.

## For the release owner

The release procedure (build, `make-manifest`, sign on your own machine, verify, publish, sync) is
in [`scripts/release/README.md`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/release/README.md).
