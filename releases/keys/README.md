# RougeChain release signing keys

**Status: provisioned 2026-10-02.** This directory holds the two public keys every release is
signed with:

- `release-ed25519.pub.pem` — checked by `scripts/install-validator.sh` (installer and
  auto-updater; the same key is embedded in the script) with stock OpenSSL,
- `release-mldsa65.pub` — checked on nodes by the installed `rougechain release verify`
  (CLI ≥ 1.2.0) against the copy embedded in the same script, and by
  `scripts/release/verify-manifest.mjs`.

The private keys exist only in a passphrase-encrypted file on the release owner's own machine.
`releases/manifest-*.json` are signed (`.ed25519.sig` + `.mldsa65.sig`); `verify-manifest.mjs` must
report `VERIFIED`.

## What will be here

| File | Content |
|---|---|
| `release-ed25519.pub.pem` | Ed25519 public key, standard SPKI PEM (works with `openssl pkeyutl -verify`) |
| `release-mldsa65.pub` | ML-DSA-65 (FIPS 204) public key: one line, hex of the raw 1952 bytes |

Every release manifest must carry a valid detached signature from **both** keys
(`manifest-<network>.json.ed25519.sig` and `manifest-<network>.json.mldsa65.sig`).

The private keys are generated and kept by the release owner on their own machine, inside a
passphrase-encrypted key file. They are never on a server and never in this repository.

## Fingerprints

A fingerprint is the SHA-256 of the **raw** public key bytes, lowercase hex.

| Key | Fingerprint |
|---|---|
| Ed25519 | `79bf33d554ee6d39e5819d94a04d941da9b0e4aeef42eb1106289c5030d4a040` |
| ML-DSA-65 | `ac4497980205f2ccbd810048bcd5ffd819d82400730cfbead41157cc56781b3c` |

Compute them yourself:

```bash
# Ed25519 (the raw key is the last 32 bytes of the DER encoding)
openssl pkey -pubin -in release-ed25519.pub.pem -outform DER | tail -c 32 | sha256sum
# ML-DSA-65
tr -d '\n' < release-mldsa65.pub | xxd -r -p | sha256sum
```

Compare them with the fingerprints published on <https://docs.rougechain.io/running-a-node/releases.html>
and with the keys embedded in `scripts/install-validator.sh` (`RELEASE_ED25519_PUBKEY_B64`, the raw
Ed25519 key in base64, and `RELEASE_MLDSA65_PUBKEY_HEX`, the content of `release-mldsa65.pub`).
`node scripts/release/verify-manifest.mjs --check-installer scripts/install-validator.sh <manifest>`
checks both.

## Provisioning (release owner, once)

See [`scripts/release/README.md`](../../scripts/release/README.md), "One-time setup". In short:
`keygen.mjs` on your own machine, commit the two public key files here, fill in the fingerprint
table above, run `embed-installer-key.mjs`, then sign the manifests.
