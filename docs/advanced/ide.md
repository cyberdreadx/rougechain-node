# Contract IDE

[rougechain.io/ide](https://rougechain.io/ide) is a browser IDE for RougeChain WASM contracts. It
lets you read and edit a contract's Rust source, run the contract on a **local test chain** inside
the page, and deploy and call it on testnet or mainnet with your wallet.

The IDE doesn't compile Rust. You build the `.wasm` on your own machine with `cargo` and load the
file. Every template also ships a prebuilt `.wasm`, so you can run it right away.

## Templates

| Template | What it shows |
|---|---|
| Counter | The smallest useful contract: storage, JSON arguments, return values, events, the caller |
| NFT marketplace | Escrow listings, buying with attached XRGE, royalties paid by the contract |
| XRGE staking | Staking with a reward pot that streams over time, a 3-day unstake delay |
| Loot roll | A game: pay to commit, settle two blocks later from a block hash |
| Royalty splitter | Receiving XRGE and paying it out to fixed recipients by share |

Sources are in [`contracts/`](https://github.com/cyberdreadx/rougechain-node/tree/main/contracts) of
the node repository. To build one after editing it:

```bash
cd rougechain-node/contracts/counter
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_counter.wasm
```

Then choose **Load your .wasm…** in the IDE.

## The local test chain

The local chain is the node's own contract engine (`core/vm`, the same `wasmi` VM and host functions
mainnet runs) compiled to WebAssembly. It runs in the page: nothing is sent anywhere and nothing
costs XRGE. It starts with three funded test accounts (Alice, Bob, Carol). It applies a call's
results the way a node does: an attached payment moves only if the call succeeds, and XRGE, token
and NFT moves are checked for overdrafts.

It also has tools for testing:

- send XRGE or an NFT to an account or a contract
- create a demo NFT collection (5 % royalty) and mint into it
- create a token
- top up the current account
- move the clock forward, for unstake delays and reward streams

Each call is its own block. Fees, signatures and other people's transactions don't exist there, and
contract addresses differ from the ones a real network assigns.

## Checks before you deploy

When you load a `.wasm`, the IDE lists its methods (its exported functions) and checks it against
what the node accepts:

- it must export its memory as `memory` (the node refuses a contract that doesn't)
- it must be at most 1 MiB
- every function it imports must be a host function the node provides — otherwise it can be
  deployed, but every call fails

## Deploying with your wallet

Switch to **Testnet** or **Mainnet** (the network your wallet is on). Deploying costs **10 XRGE**
and is signed by your wallet (`POST /api/v2/contract/publish`). The contract's address is known
before the transaction is mined. Calls are checked first with a free read
(`POST /api/contract/:addr/query`) and sent only if they would succeed, with a gas limit set from that
check. A deployed contract can't be changed or removed, so test it on the local chain and on
testnet first.
