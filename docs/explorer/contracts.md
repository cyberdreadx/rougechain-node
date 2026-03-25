# Contracts

The Contracts Explorer lets you browse all WASM smart contracts deployed on RougeChain.

## Contracts List (`/contracts`)

The contracts page displays:

- **Total Contracts** — Number of deployed contracts
- **Total WASM Size** — Combined bytecode size
- **Search** — Filter by contract address or deployer
- **Sort** — By newest, oldest, or size

Each contract card shows its address, deployer, WASM size, and deploy block. Click to view details.

## Contract Detail (`/contract/:addr`)

The contract detail page has three sections:

### Contract Information
- Contract address (hex)
- Deployer identity
- Deploy block and transaction
- WASM bytecode size

### State Viewer
Live key-value table showing all data in the contract's persistent storage. Updates after each contract call.

### Execute Contract
Interactive form to call contract methods directly from the browser:

| Field | Description |
|-------|-------------|
| Method | Function name (e.g. `get_count`, `transfer`) |
| Arguments | JSON object with method parameters |
| Caller | Caller identity (optional) |
| Gas Limit | Max fuel units (default: 100,000) |

Results display success/failure status, gas used, and return data.

## Transaction Labels

Contract transactions appear throughout the explorer with distinct labels:

| Label | Description |
|-------|-------------|
| **Contract Deploy** | WASM bytecode deployment |
| **Contract Call** | Method execution |

The transaction detail page shows a **Contract Details** card for these transactions with the contract address, method name, gas used, and WASM size.
