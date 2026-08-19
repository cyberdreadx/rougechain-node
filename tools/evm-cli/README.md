# rougechain-evm — terminal Base wallet

Derives your **Base (EVM) account from the same 24-word mnemonic** as the RougeChain
wallet extension, using the standard Ethereum path `m/44'/60'/0'/0/0` (identical to
`browser-extension/src/lib/evm-wallet.ts`). The address it prints is the same one the
extension's "Base Wallet (EVM)" card shows. Signing uses the audited `micro-eth-signer`
library — no hand-rolled RLP.

## Setup
```bash
cd tools/evm-cli
npm install
# Provide the phrase via env ONLY — never as a CLI argument (args leak into history / ps):
export ROUGECHAIN_MNEMONIC="word1 word2 ... word24"
```

## Usage
```bash
node index.mjs new                             # generate a fresh 24-word wallet + Base address
node index.mjs address                        # your Base address
node index.mjs balance                         # ETH + XRGE on Base mainnet
node index.mjs balance --net sepolia           # on Base Sepolia
node index.mjs balance --token 0xTokenAddr     # any ERC-20

node index.mjs send-eth   <to> <amountEth>              [--net sepolia]
node index.mjs send-token <token> <to> <amount> [--decimals 18] [--net sepolia]
```
`--net` is `mainnet` (default, chainId 8453), `sepolia` (Base Sepolia, 84532), or
`ethsepolia` (Ethereum Sepolia, 11155111). Fees are EIP-1559:
`maxFee = 2·baseFee + 1 gwei tip`, gas estimate +20%, nonce = pending.

## Security
- Mnemonic is read from `ROUGECHAIN_MNEMONIC` only. The private key never leaves the process.
- `send-*` broadcasts a real transaction — double-check the address and `--net`.

## Note: bridge testing
`send-token 0x147120faEC9277ec02d957584CFCD92B56A24317 <VAULT_ADDR> <amount> --net sepolia`
is how you create a real XRGE `Transfer → vault` deposit on Base Sepolia to validate the
hardened `/api/bridge/xrge/claim` path end-to-end.
