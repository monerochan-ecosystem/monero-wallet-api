# @spirobel/monero-wallet-api

## install 

```bash
bun add @spirobel/monero-wallet-api
```

## quick start

```ts
import { openWallets } from "@spirobel/monero-wallet-api";

// scan all non-halted wallets from the settings file:
const wallets = await openWallets();
```

## wallet less transaction tracker

Use `ViewPair` to make the checkout address. `trackers.new()` scans the signed transaction, verifies the payment ID and invoice amount, then submits it and tracks its confirmations.

```js
import { appendFile } from "node:fs/promises";
import { openTrackers, ViewPair } from "@spirobel/monero-wallet-api";

const viewPair = await ViewPair.create(primary_address, secret_view_key);
const payment_id = 42;
const address = viewPair.makeIntegratedAddress(payment_id);
// show the address at checkout.

const states = Bun.JSONL.parse(await Bun.file("checkouts.jsonl").bytes());
async function saveStates(changed) {
  const lines = changed.map(({ data }) => JSON.stringify(data));
  await appendFile("checkouts.jsonl", lines.join("\n") + "\n");
}

const trackers = await openTrackers({
  node_url: "http://127.0.0.1:18081",
  notify: saveStates,
  transactionTrackers: states,
});
const result = await trackers.new({
  tx_as_hex,
  view_pair: viewPair,
  payment_id,
  invoice_amount: 100_000_000_000n,
  merchant_confirmations: 3,
});
if ("error" in result) console.error(result.error);
```

`invoice_amount` is the minimum payment in atomic units. If the scan fails, the payment ID is wrong, or the amount is below the invoice, `new()` returns `{ error }` before it starts a tracker.

Tracking starts at the tip observed before submission. A tip change triggers a consecutive block read. If a reorg replaces the payment block, the tracker searches again. `openTrackers()` scans one transaction per checkout submission and shares block reads across trackers, so a server can serve many wallets with little CPU time.

`notify` receives only the trackers that changed. This example uses one wallet and appends one JSON line per changed `tracker.data`. Use `tracker.transaction` for the history row, which shows the received amount in atomic units as a `bigint` and block details when the payment tx was mined. On restart, `openTrackers()` restores the latest state for each wallet and payment ID.

```ts
import { appendFile } from "node:fs/promises";
import { openTrackers, type TransactionTracker, type TransactionTrackerState } from "@spirobel/monero-wallet-api";

const saved = Bun.JSONL.parse(await Bun.file("checkouts.jsonl").bytes()) as TransactionTrackerState[];
const restored = await openTrackers({
  node_url: "http://127.0.0.1:18081",
  transactionTrackers: saved,
  notify: async (changed: readonly TransactionTracker[]) => {
    const lines = changed.map(({ data }) => JSON.stringify(data));
    await appendFile("checkouts.jsonl", lines.join("\n") + "\n");
  },
});

// call this to shutdown.
await restored.stop();
```

**Walletless transaction tracking is useful for browser-wallet checkouts with [Tool 001 handover](../mids/mid-0003.md#handover) and atomic swap protocols that pass a signed transaction directly to the counterparty.
A small VPS can check the payment on receipt, show its status, and track confirmations without syncing a wallet.
Use `openWallets()` to discover payments without a handover.**

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

## unpacked build entrypoint

In most cases you should use the default install / npm build entrypoint. It takes care of distributing the worker + wasm files as part of the package. When using the unpacked entrypoint via adding `/unpacked` to the end of the package import, you need to configure your build system to copy / distribute the wasm and worker urls and notify the package of those urls in your setup code via `configureUnpacked()`. 
``` ts
import { configureUnpacked, openWallets } from "@spirobel/monero-wallet-api/unpacked";

```

### build result in dist dir

`bun run build` makes these files in `dist` (in addition to the packaged build `xmr3.js` and type definitions):

* `xmr3_unpacked.js` (entry without worker + wasm dataurls)
* `worker_unpacked.js` (worker source file that has to be distributed manually)
* `monero_wallet_api.wasm` (wasm file that has to be distributed manually)
* `frost_dkg.wasm` (wasm file that has to be distributed manually)

### checklist for library consumer of unpacked entrypoint

1. Install the lib.
2. Copy the wasm files and the worker file to your dist folder.
3. Import from `/unpacked`.
4. Call `configureUnpacked` before `openWallets`.

Copy step in `package.json`:

```json
"copyunpacked": "cp node_modules/@spirobel/monero-wallet-api/dist/*.wasm dist/chrome/ && cp node_modules/@spirobel/monero-wallet-api/dist/worker_unpacked.js dist/chrome/"
```

Code example:

```ts
import { configureUnpacked, openWallets } from "@spirobel/monero-wallet-api/unpacked";

configureUnpacked({
  workerUrl: "worker_unpacked.js",
  moneroWasmUrl: "monero_wallet_api.wasm",
  dkgWasmUrl: "frost_dkg.wasm",
});

const wallets = await openWallets();
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
cd rust || cd ../rust
docker run -v $(pwd):/app -it monero-wallet-api-build
```
frost-dkg
```bash
cd frost-dkg || cd ../frost-dkg
docker run -v $(pwd):/app -it monero-wallet-api-build
```
typescript
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
