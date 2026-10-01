# Signed releases

Node releases are published as a prebuilt `quantum-vault-daemon` binary (Linux x86_64) described by
a **signed release manifest**. The installer and anyone verifying by hand check the same thing:
the manifest's signature, then the binary's sha256 and size against the manifest.

> **Status (2026-10-01): release keys are pending provisioning.** The manifests in
> [`releases/`](https://github.com/cyberdreadx/rougechain-node/tree/main/releases) are published
> **unsigned**, and `install-validator.sh` refuses to run until the release key is embedded in it.
> Until then, install the binary by hand and check its sha256 against the upgrade note
> ([current release](mandatory-upgrade-2026-10.md)). This page describes the format and the checks
> so they can be reviewed before the keys exist.

## Where releases are published

| What | Primary | Mirror |
|---|---|---|
| Manifest + signatures | `https://api.rougechain.io/releases/manifest-<network>.json` (+ `.ed25519.sig`, `.mldsa65.sig`) | `https://raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases/` |
| Binary | `binary.url` in the manifest (`https://api.rougechain.io/releases/<name>`) | `binary.mirrors` in the manifest |
| Genesis file | `genesis.url` in the manifest | `core/daemon/` in the public repository |
| Public keys | [`releases/keys/`](https://github.com/cyberdreadx/rougechain-node/tree/main/releases/keys) in the public repository | — |

`<network>` is `mainnet` or `testnet`. A mirror cannot weaken anything: a file from any source is
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
    "mirrors": [],
    "sha256": "673bf7b1a469b7f9937b17228faab1e81ae48fb2a90aa32b2fd1b7fcc9cc2984",
    "size": 28463856
  },
  "genesis": { "name": "genesis-mainnet.json", "url": "…", "mirrors": ["…"], "sha256": "…", "size": 4460 },
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
| `binary` | object | `name`, `url` (primary), `mirrors` (array of URLs), `sha256` (lowercase hex), `size` (bytes). |
| `genesis` | object or null | Same shape as `binary`, for the genesis file the node is started with. `null` when the network runs on default parameters (testnet). |
| `mandatory` | boolean | `true` if every node of the network must install this release. |
| `upgrade_before_height` | integer or null | Install before this block height (the first activation the release introduces). |
| `activations` | array | The network's upgrade schedule carried by this binary: `{ "name", "height" }`. Names are the `upgrade_schedule` fields of `GET /api/stats`. |
| `notes_url` | string or null | Release / upgrade notes. |
| `min_installer_version` | string | Oldest `install-validator.sh` that can install this release. |

All URLs are `https://`. Unknown fields are not allowed in schema 1. The current manifests list the
full schedule in `activations` (mainnet: 49, 90, 100, 150, 150, 160, 170, 190, 235, 235) — see the
[upgrade schedule](upgrade-schedule.md).

## Signatures

The signed object is the **manifest file itself**: both signatures are over its exact bytes
(no canonicalisation — a manifest that is re-formatted no longer verifies).

| File | Algorithm | Encoding |
|---|---|---|
| `manifest-<network>.json.ed25519.sig` | Ed25519 (RFC 8032) | base64 of the raw 64-byte signature |
| `manifest-<network>.json.mldsa65.sig` | ML-DSA-65 (FIPS 204), empty context | base64 of the raw 3309-byte signature |

A release must carry **both**. The installer checks the Ed25519 signature (available in the stock
OpenSSL 3.0 of Ubuntu 22.04/24.04 and Debian 12); the ML-DSA-65 signature is checked by the
release tooling and CI, and by hand with OpenSSL 3.5 or newer.

Public keys: `releases/keys/release-ed25519.pub.pem` (PEM) and `releases/keys/release-mldsa65.pub`
(hex of the raw 1952-byte key). The private keys are held offline by the release owner; they are
not on the release server.

| Key | Fingerprint (SHA-256 of the raw public key) |
|---|---|
| Ed25519 | _pending provisioning_ |
| ML-DSA-65 | _pending provisioning_ |

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

# 3. The binary is the one the manifest describes  →  "OK", and the size matches
curl -fLO "$(jq -r .binary.url manifest-$NET.json)"
echo "$(jq -r .binary.sha256 manifest-$NET.json)  $(jq -r .binary.name manifest-$NET.json)" | sha256sum -c
test "$(stat -c %s "$(jq -r .binary.name manifest-$NET.json)")" = "$(jq -r .binary.size manifest-$NET.json)" && echo "size OK"
```

Get the public key from the Git repository (or from a copy you saved earlier), not from the same
server that serves the manifest.

**ML-DSA-65 signature** — with OpenSSL ≥ 3.5 (e.g. Debian 13):

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
node verify-manifest.mjs --binary /path/to/the/binary ../../releases/manifest-mainnet.json   # exit 0 = VERIFIED
```

## What the installer does

[`scripts/install-validator.sh`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/install-validator.sh)
(Ubuntu 22.04 / 24.04, Debian 12; x86_64; run as root):

1. downloads `manifest-<network>.json` and its `.ed25519.sig` from the primary, then from the
   mirror if the primary is unreachable or serves a manifest that does not verify;
2. verifies the signature with `openssl` against the release key **embedded in the script** — it
   never downloads a key — and stops if no source provides a manifest that verifies;
3. checks the manifest is for the requested network, and is not older than the release already
   installed (`ALLOW_DOWNGRADE=1` overrides);
4. downloads the binary and the genesis file (primary, then mirrors) and requires size and sha256
   to match the signed manifest;
5. installs, as described below, and keeps the previous binary as `<binary>.prev`.

It never overwrites `node-keys.json` or chain data. `--dry-run` performs steps 1–4 and changes
nothing.

| | mainnet | testnet |
|---|---|---|
| Service | `rougechain-validator` | `rougechain-validator-testnet` |
| Binary | `/usr/local/bin/quantum-vault-daemon` | `/usr/local/bin/quantum-vault-daemon-testnet` |
| Data + `node-keys.json` (`DATA_DIR`) | `/var/lib/rougechain/mainnet` | `/var/lib/rougechain/testnet` |
| Genesis, installed manifest, optional `node.env` | `/etc/rougechain/mainnet/` | `/etc/rougechain/testnet/` |
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

Settings: `NETWORK`, `NODE_NAME`, `PUBLIC_URL`, `VALIDATOR`, `DATA_DIR`, `API_PORT`, `P2P_PORT`,
`HOST`, `PEERS`, `NO_START`, `ALLOW_DOWNGRADE`, `REPLACE_LEGACY_UNIT`, `RELEASE_BASE_URLS` — see the
header of the script.

### Upgrading

Re-run the installer. It verifies the new signed release, replaces the binary, and restarts the
service (with `NO_START=1` it installs without restarting, so you can restart at a time you
choose: `systemctl restart rougechain-validator`). To go back to the previous binary:

```bash
sudo systemctl stop rougechain-validator
sudo cp -p /usr/local/bin/quantum-vault-daemon.prev /usr/local/bin/quantum-vault-daemon
sudo systemctl start rougechain-validator
```

There is no automatic updater: upgrades happen when you run the installer.

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
