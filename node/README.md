## RougeChain L1 node (devnet scaffold)

This folder adds a **standalone node daemon** (not the browser demo). It currently implements:

- Local disk storage (`chain.jsonl` + `tip.json`)
- TCP P2P (newline-delimited JSON messages)
- PQC signing/verification via **ML-DSA-65** using `@noble/post-quantum`
- Simple “devnet” block production with `--mine` (not production consensus yet)

### Prereqs

Install **Node.js** (which includes `npm`) so `npm` is on your PATH.

### Install deps

From repo root:

```bash
npm install
```

Then add the PQC dependency (required to run the node):

```bash
npm install --save @noble/post-quantum
```

And add the TS runner (required for `l1:node:dev`):

```bash
npm install --save-dev tsx
```

### Run a 2-node local devnet

Terminal A (miner):

```bash
npm run l1:node:dev -- --name a --port 4100 --mine
```

Terminal B (follower):

```bash
npm run l1:node:dev -- --name b --port 4101 --peers 127.0.0.1:4100
```

### Performance Options

**Block Time**: Default is **1 second** (1000ms). To customize:

```bash
# Faster: 500ms blocks
npm run l1:node:dev -- --name a --port 4100 --mine --blockTimeMs 500

# Slower: 2 second blocks
npm run l1:node:dev -- --name a --port 4100 --mine --blockTimeMs 2000
```

**Optimizations enabled:**
- ✅ Parallel transaction signature verification
- ✅ Immediate block production start (no initial delay)
- ✅ Smart timing (waits only remaining time after block production)
- ✅ Fast block validation

### What’s next for “production L1”

This is only a runnable skeleton. The next implementation steps are:

- Replace devnet mining with a real PoS+BFT consensus
- Replace JSON encoding with a canonical binary codec
- Add transaction/state execution (balances, fees, staking, slashing)
- Add peer scoring, rate limiting, and snapshot/state sync

