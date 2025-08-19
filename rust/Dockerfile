# Use Rust 1.89.0 as the base image
FROM rust:1.89.0-alpine

RUN apk add --no-cache musl-dev=1.2.5-r8

RUN rustup target add wasm32-wasip1

# Create a directory for the project
WORKDIR /app

# Set the entrypoint
ENTRYPOINT ["cargo", "build", "--target", "wasm32-wasip1", "--release", "--lib"]
