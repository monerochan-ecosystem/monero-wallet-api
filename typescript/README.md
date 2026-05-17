# @spirobel/monero-wallet-api

## quick start

```ts
import { openWallets } from "@spirobel/monero-wallet-api";

// scan all non-halted wallets from the settings file:
const wallets = await openWallets();
```

## kitchen sink + transaction sending

```ts
import { openWallets } from "@spirobel/monero-wallet-api";

// add a wallet address to ScanSettings.json first

// convenience script to make a regtest wallet and write to RegtestScanSettings.json + keys to .env.local:
// bun run scripts/regtest_gen.ts

// scan all non-halted wallets from the settings file:
const wallets = await openWallets({
  scan_settings_path: "./ScanSettings.json", // this is the default scan settings file name
  pathPrefix: "./", // default path for wallet scan caches, stats files, connection status file
  notifyMasterChanged: async (params) => {
    // called on each scan result: outputs, new_height, etc.
    console.log("progress", params.newCache.current_height);
  },
});

// change node url mid scan
await wallets.changeNodeUrl("http://127.0.0.1:18081");

// send a transaction
wallets.wallets[0].makeSignSendTransaction();
wallets.wallets[0].makeStandardTransaction(
  escrow_address.mainnet_primary,
  "133700000000",
);
wallets.wallets[0].signTransaction();
wallets.wallets[0].sendTransaction();

// sweep all funds to another wallet
const unsigned_tx_hex = await escrowWallet.sweepToExternalWallet(
  merchant_final_address,
  escrowWallet.spendableInputs(),
);

// stop scan worker
wallets.stopWorker();
```

See the [reorg handling test](tests/acceptance/reorg_handling.test.ts) for a regtest reorg example.

After running this test a local node is available, which
makes it possible to easily run the [escrow test](tests/acceptance/escrow.test.ts) described in detail [here](https://monerochan.news/article/19).

See the [acceptance test](tests/acceptance/dont_rescan.test.ts) for a full working sync example with mainnet data.

## install

To install the package:

```bash
bun add @spirobel/monero-wallet-api
```

## build

#### 1. rust release build

```bash
cd rust || cd ../rust
cargo build  --target wasm32-wasip1 --release --lib
```

```bash
cd frost-dkg || cd ../frost-dkg
cargo build  --target wasm32-wasip1 --release --lib
```

#### 2. build typescript:

```bash
cd typescript || cd ../typescript
bun build
```

### prerequisite: init submodule (frost-dkg uses serai submodule)

```bash
git submodule update --init --recursive
```

### prerequisite: install rust (or use docker image, see below)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

```bash
rustup install 1.89.0
rustup default 1.89.0
rustup target add wasm32-wasip1
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
bun run build
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
