# RougeChain node release — mintable tokens and royalty-aware contracts (2026-10)

**Mandatory upgrade for every mainnet validator and full node.** Block 235 has passed; the current
release is [1.6.3](release-1.6.3.md), which contains these changes and the block-245 rule.
Two consensus changes activate at the same height:

| Change | Constant (`core/daemon/src/node.rs`) | Activation height |
|---|---|---|
| Mintable tokens: creator-only minting with an optional max supply (TOKEN_MINTING) | `TOKEN_MINTING_ACTIVATION_HEIGHT` | **235** |
| Contract royalty reads; royalties above 100% refused at creation (CONTRACT_NFT_ROYALTY) | `CONTRACT_NFT_ROYALTY_ACTIVATION_HEIGHT` | **235** |

A node on an older build stops following mainnet at the first block from 235 that uses either
feature: it rejects that block and stays at the height before it. It does not apply anything wrong,
so installing this build and restarting is enough to continue — no resync.

Both changes have been active on testnet since block 1360 (capped minting, creator-only minting, the
royalty cap and a full marketplace sale paying exact royalty and seller amounts were all verified there).

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `673bf7b1a469b7f9937b17228faab1e81ae48fb2a90aa32b2fd1b7fcc9cc2984` |
| Size | 28,463,856 bytes |
| Source | quantum-vault `4f8676d` (release commit `03613ef`); public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) main `e048bf1` |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), cargo 1.94.0 (85eff7c80 2026-01-15), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-mint-royalty-03613ef` |

This exact binary runs on the operator nodes. It was built twice from clean and the two builds were
byte-identical. The same binary also carries testnet's schedule (both features at 1360).

## What changed

**Mintable tokens (≥ 235).** `create_token` accepts `"mintable": true` and an optional integer
`"max_supply"` (at least the initial supply). The creator can then send signed `mint_tokens`
transactions (1 XRGE fee). The node refuses a mint by any other wallet or past the cap and records the
minted total in the chain state. Tokens created before 235 stay fixed-supply. See
[Token creation](../advanced/token-creation.md).

**Royalty-aware contracts (≥ 235).** Two read-only host functions,
`host_nft_royalty_bps(col)` and `host_nft_royalty_recipient(col, out, cap)`, let a contract read a
collection's royalty and pay it with `host_transfer`. From the same height `nft_create_collection` with
a `royaltyBps` above 10000 (or not an integer) is refused. See
[Smart Contracts](../advanced/smart-contracts.md).

**Also in this build (no activation height):** v2 faucet whitelist and cooldown, `--trust-proxy` and the
`--rate-limit-per-minute` alias, rate-limited `/api/finality/*`, `/api/selection` showing the real
designated proposer, `rouge1` nonce lookups, and token supply fields on the token endpoints.

## Upgrade

Back up `node-keys.json` and the data directory first. Then either install the release binary:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-mint-royalty-03613ef
echo "673bf7b1a469b7f9937b17228faab1e81ae48fb2a90aa32b2fd1b7fcc9cc2984  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-235" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

or build the public repository yourself:

```bash
sudo systemctl stop rougechain-validator
cp -a ~/.quantum-vault/mainnet ~/.quantum-vault/mainnet.backup-$(date +%Y%m%d)
cd ~/rougechain && git pull --ff-only          # public rougechain-node main, e048bf1 or later
source ~/.cargo/env && cd core && cargo build --release --locked -p quantum-vault-daemon
sudo systemctl start rougechain-validator
```

(Your own build's sha256 differs from the release binary because build paths are embedded; the source
commit is what matters.)

**Check** after the restart:

```bash
curl -s localhost:5100/api/stats | python3 -c "import json,sys;d=json.load(sys.stdin);u=d['upgrade_schedule'];print(d['network_height'], u['token_minting'], u['contract_nft_royalty'])"
```

It should print the current height followed by `235 235`, and the node's `state_root` should equal
`https://api.rougechain.io/api/stats` at the same height.
