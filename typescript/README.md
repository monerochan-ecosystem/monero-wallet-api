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

```bash
cd typescript || cd ../typescript
bun build
bun run inlinesum
```

if the content of the checksum.txt file stays the same, the build was reproduced.

to verify that the wasm file distributed on npm matches the checksum,
add the npm package as a dependency to a project and compare the sha256sum output with the checksum.txt file in the git repo.

```bash
cd /tmp
bun init
bun add @spirobel/monero-wallet-api
cat node_modules/@spirobel/monero-wallet-api/dist/wasmFile.js | sha256sum
```
