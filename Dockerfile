# ── RougeChain Node — Production Multi-Stage Build ──
FROM rust:1.78-bookworm AS builder

RUN apt-get update && apt-get install -y \
    pkg-config libssl-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY core/ core/
WORKDIR /build/core
RUN cargo build --release -p quantum-vault-daemon -p quantum-vault-cli

# ── Runtime ──
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*

# Binaries
COPY --from=builder /build/core/target/release/quantum-vault-daemon /usr/local/bin/rougechain-node
COPY --from=builder /build/core/target/release/rougechain /usr/local/bin/rougechain

# Genesis configs
COPY core/daemon/genesis.json /etc/rougechain/genesis.json
COPY core/daemon/genesis-devnet.json /etc/rougechain/genesis-devnet.json

# Non-root user
RUN useradd -m -s /bin/bash rougechain && \
    mkdir -p /data/rougechain && \
    chown -R rougechain:rougechain /data/rougechain

USER rougechain

VOLUME /data/rougechain
EXPOSE 8900

ENV RUST_LOG=info
ENV QV_CORS_ORIGINS=""

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:8900/api/stats || exit 1

ENTRYPOINT ["rougechain-node"]
CMD ["--data-dir", "/data/rougechain", "--host", "0.0.0.0", "--api-port", "8900", "--mine"]
