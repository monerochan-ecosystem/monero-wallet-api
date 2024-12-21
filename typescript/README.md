# @spirobel/monero-wallet-api

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.1.29. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

rust release build

```bash
cargo wasi build  --target wasm32-wasip1 --release --lib
```

## reproducible build with pinned cargo + rust + cargo wasi

make the image

```bash
docker build -t your-image-name .
```

build the library -> find the result in target/wasm32-wasip1/release

```bash
docker run -v $(pwd):/app -it your-image-name
```
