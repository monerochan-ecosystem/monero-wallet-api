# @spirobel/monero-wallet-api

To install dependencies:

```bash
cd typescript || cd ../typescript
bun install
```

To build:

```bash
cd typescript || cd ../typescript
bun build
```

rust release build

```bash
cd rust || cd ../rust
cargo wasi build  --target wasm32-wasip1 --release --lib
```

## reproducible build with pinned cargo + rust + cargo wasi

make the image

```bash
cd rust || cd ../rust
docker build -t monero-wallet-api-build .
```

build the library -> find the result in target/wasm32-wasip1/release

```bash
docker run -v $(pwd):/app -it monero-wallet-api-build
```
