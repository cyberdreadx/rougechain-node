# Quantum Vault Core (Rust)

This directory contains the Rust-based core node implementation that replaces
the previous JS node/crypto logic. The React UI remains in `/src` and calls
this daemon via HTTP bridge endpoints and gRPC.

- `daemon`: binary that runs the node and exposes gRPC + HTTP bridge
- `types`: shared types + codec helpers
- `crypto`: hashing + PQC signing helpers
- `consensus`: proposer selection utilities
- `storage`: chain, validator, messenger persistence
- `p2p`: TCP gossip scaffolding
