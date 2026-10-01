# Release tooling — signed release manifests

A node release is described by one **manifest** per network (`releases/manifest-mainnet.json`,
`releases/manifest-testnet.json`) and authenticated by two **detached signatures** over the exact
bytes of that file:

| File | What |
|---|---|
| `manifest-<network>.json` | the release: version, binary name/URL/sha256/size, genesis, activation heights |
| `manifest-<network>.json.ed25519.sig` | Ed25519 signature (base64 of 64 bytes) — checked by `scripts/install-validator.sh` with stock OpenSSL 3 |
| `manifest-<network>.json.mldsa65.sig` | ML-DSA-65 signature (base64 of 3309 bytes) — checked by `verify-manifest.mjs` (and OpenSSL ≥ 3.5) |

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
| `embed-installer-key.mjs` | owner's machine, once | writes the Ed25519 public key into `scripts/install-validator.sh` |
| `make-manifest.mjs` | build host | builds a manifest from the binary (sha256, size) and release facts; validates it; refuses to overwrite silently |
| `sign-manifest.mjs` | owner's machine | shows the manifest, asks you to type the version, decrypts the key file, writes both `.sig` files. Works offline |
| `verify-manifest.mjs` | anywhere, CI | schema + both signatures + (optionally) binary/genesis hashes + installer key. Exit 0 verified, 1 invalid, 2 unsigned |
| `test-installer.sh` | dev machine with Docker | end-to-end installer tests (see below) |

Every script has `--help`.

## One-time setup (release owner, on your own machine — not the server)

```bash
git clone <this repo> && cd <repo>/scripts/release && npm ci

# 1. Generate the keys. You are asked for a passphrase (min. 12 characters) twice.
node keygen.mjs --out ~/rougechain-release-keys.json --pub-dir ../../releases/keys

# 2. Put the Ed25519 key into the installer.
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

**1. Build** (build host) — the existing reproducible build (two clean builds, byte-identical), then
place the binary in the release directory under a unique name:

```bash
sudo install -m 0644 <built-binary> /srv/rougechain-releases/quantum-vault-daemon-<tag>-<commit>
```

**2. Make the manifests** (build host, on a release branch):

```bash
git rm -q --ignore-unmatch releases/manifest-*.sig          # old signatures do not apply to a new manifest
B=/srv/rougechain-releases/quantum-vault-daemon-<tag>-<commit>

node scripts/release/make-manifest.mjs --force --network mainnet --version 1.7.0 \
  --binary "$B" --source-commit <commit> --public-commit <public commit, if already synced> \
  --genesis core/daemon/genesis-mainnet.json \
  --mandatory --upgrade-before-height <H> \
  --activation <name>=<height> [--activation …] \
  --notes-url https://docs.rougechain.io/running-a-node/<upgrade-note>.html

node scripts/release/make-manifest.mjs --force --network testnet --version 1.7.0 \
  --binary "$B" --source-commit <commit> --no-genesis \
  --activation <name>=<height> [--activation …]

git add releases/ && git commit -m "release: node 1.7.0 manifests (unsigned)" && git push
```

List the network's full activation schedule (`core/daemon/src/upgrades.rs`), not only the new heights.
`--binary-mirror <url>` (repeatable) adds further download locations for the binary, e.g. a GitHub
release asset. The genesis file gets the public repository as its mirror automatically.

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
  node scripts/release/verify-manifest.mjs --network $net --binary "$B" \
    --check-installer scripts/install-validator.sh releases/manifest-$net.json || exit 1
done
node scripts/release/verify-manifest.mjs --genesis core/daemon/genesis-mainnet.json releases/manifest-mainnet.json || exit 1
```

**7. Publish** to `https://api.rougechain.io/releases/` (nginx serves `/srv/rougechain-releases/`).
Signatures first, manifest last, so a manifest is never served without its signature:

```bash
R=/srv/rougechain-releases
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
node scripts/release/verify-manifest.mjs --binary "$B" $T/manifest-mainnet.json     # VERIFIED
bash scripts/install-validator.sh --dry-run        # downloads + verifies exactly as an operator's install would
```

(`--dry-run` needs `curl`, `openssl` and `jq` on the machine it runs on and changes nothing.)

**8. Merge and sync** — merge the release branch to `main`, then run the public sync
(`rougechain-node`). The public repository is the installer's mirror
(`raw.githubusercontent.com/cyberdreadx/rougechain-node/main/releases/`), and it is where
operators download `install-validator.sh` from, so the release is not complete until the sync is.

**9. Announce** — upgrade note under `docs/running-a-node/`, `docs/running-a-node/upgrade-schedule.md`,
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

## If the key file or passphrase is lost, or the key is compromised

Generate new keys (`keygen.mjs` into a new file, remove the old public keys from `releases/keys/`
first), run `embed-installer-key.mjs --rotate`, re-sign the manifests, publish, sync, and announce
the new fingerprints through a channel that does not depend on the old key. Operators must
download the new installer; nothing on their nodes trusts the old key after that.

## Tests

```bash
cd scripts/release
npm test                                    # tooling: round trip + tamper/wrong-key/garbage/schema cases
./test-installer.sh                         # installer in Docker: ubuntu:24.04, debian:12, ubuntu:22.04
REAL_BINARY=/srv/rougechain-releases/<binary> ./test-installer.sh    # + the real node binary
```

The tests generate their own throw-away keys in a temp directory. They never read or write
`releases/keys/`, and the installer accepts a test key only when **both**
`ROUGECHAIN_INSTALLER_TEST=1` and `ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=<pem>` are set (it prints a
warning banner and stamps the unit's description).
