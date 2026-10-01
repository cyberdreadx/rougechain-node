# RougeChain release signing keys

**Status: keys pending provisioning.** No release key has been generated yet, so:

- there are no public key files in this directory,
- `releases/manifest-*.json` are **unsigned** (no `.sig` files) — `verify-manifest.mjs` reports
  `UNSIGNED`,
- `scripts/install-validator.sh` carries a placeholder key and refuses to run.

Until this changes, verify a release by its sha256 from the upgrade notes
(`docs/running-a-node/mandatory-upgrade-*.md`).

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
| Ed25519 | _pending_ |
| ML-DSA-65 | _pending_ |

Compute them yourself:

```bash
# Ed25519 (the raw key is the last 32 bytes of the DER encoding)
openssl pkey -pubin -in release-ed25519.pub.pem -outform DER | tail -c 32 | sha256sum
# ML-DSA-65
tr -d '\n' < release-mldsa65.pub | xxd -r -p | sha256sum
```

Compare them with the fingerprints published on <https://docs.rougechain.io/running-a-node/releases.html>
and with the key embedded in `scripts/install-validator.sh` (`RELEASE_ED25519_PUBKEY_B64`, the raw
Ed25519 key in base64).

## Provisioning (release owner, once)

See [`scripts/release/README.md`](../../scripts/release/README.md), "One-time setup". In short:
`keygen.mjs` on your own machine, commit the two public key files here, fill in the fingerprint
table above, run `embed-installer-key.mjs`, then sign the manifests.
