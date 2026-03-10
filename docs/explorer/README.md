# Block Explorer

RougeChain includes a built-in block explorer at [rougechain.io](https://rougechain.io) for browsing blocks, transactions, addresses, tokens, and NFTs.

## Features

- **Block details** — View block height, hash, timestamp, proposer, and all transactions
- **Transaction details** — View transaction type, sender, recipient, amount, fee, and status
- **Address pages** — View any address's balances, token holdings, and transaction history
- **Token list** — Browse all tokens created on RougeChain
- **NFT Explorer** — Browse NFT collections and individual tokens
- **Global search** — Search by address, transaction hash, or block height

## Navigation

The explorer is integrated into the main RougeChain web app:

| Page | URL | Description |
|------|-----|-------------|
| Blockchain | `/blockchain` | Block list with live updates |
| Block Detail | `/block/:height` | Individual block |
| Transaction | `/tx/:hash` | Individual transaction |
| Address | `/address/:pubkey` | Address details |
| Transactions | `/transactions` | All transactions list |
| NFT Explorer | `/nft-explorer` | NFT collections browser |
| Tokens | `/tokens` | All tokens list |
