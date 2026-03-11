# ---- Builder stage ----
FROM rust:1.78-bookworm AS builder

RUN apt-get update && apt-get install -y \
    pkg-config libssl-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY core/ core/
WORKDIR /build/core
RUN cargo build --release -p quantum-vault-daemon

# ---- Runtime stage ----
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/core/target/release/quantum-vault-daemon /usr/local/bin/quantum-vault-daemon

RUN useradd -m -s /bin/bash rougechain
USER rougechain

VOLUME /data
EXPOSE 5100

ENV QV_CORS_ORIGINS=""

ENTRYPOINT ["quantum-vault-daemon", "--data-dir", "/data", "--host", "0.0.0.0", "--api-port", "5100"]
CMD ["--mine", "--peers", "https://testnet.rougechain.io/api"]
