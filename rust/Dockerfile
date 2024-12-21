# Use Rust 1.82.0 as the base image
FROM rust:1.82.0-alpine

RUN apk add --no-cache musl-dev=1.2.5-r0

# Install cargo-wasi 0.1.28
RUN cargo install cargo-wasi --version 0.1.28

RUN rustup target add wasm32-wasip1

# Create a directory for the project
WORKDIR /app

# Set the entrypoint
ENTRYPOINT ["cargo", "wasi", "build", "--target", "wasm32-wasip1", "--release", "--lib"]
