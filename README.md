# monero-wallet-api

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

Create an empty `checkouts.jsonl` file before the first run.

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

By default, tracking starts 20 blocks below the tip observed before submission, so it also finds a payment that is already in a block or that a reorg moves below that tip. With `created_at`, the invoice time, it uses one block per minute of invoice age, with a minimum of 20 blocks, so a late handover finds an older payment. A tip change triggers a consecutive block read. Before the required confirmation count is reached, a reorg can make the tracker search again. Tracking stops when that count is reached. `openTrackers()` scans one transaction per checkout submission and shares block reads across trackers, so a server can serve many wallets with little CPU time.

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

**Walletless transaction tracking is useful for browser-wallet checkouts with [Tool 001 handover](mids/mid-0003.md#handover) and atomic swap protocols that pass a signed transaction directly to the counterparty.
A small VPS can check the payment on receipt, show its status, and track confirmations without syncing a wallet.
Use `openWallets()` to discover payments without a handover.**

## ScanCache durability

The ScanCache stores scan progress, outputs, and the wallet's transaction log (TxLog). The wallet reserves inputs, saves the signed bytes, and records the broadcast attempt before it sends those bytes to a node or hands them to a checkout. It saves the result when it receives one. The same coordinator writes the cache in Bun and in the browser wallet.

When the wallet process stops or crashes, the scan resumes from saved progress on reopen. An interrupted send keeps any saved input reservations. For a failed send, you can release reserved inputs manually. Rebroadcast uses the saved signed bytes and requires the original inputs to remain available. The scan records the spend when it finds the transaction on chain.

**Transaction API.** Use `makeSignSendTransaction()` or `sweepSignSend()` for a tracked send, or use `makeSignTransaction()` and `sendSignedTransaction()` to separate signing from broadcast. These methods use the active coordinator. The lower-level `ViewPair` builders and the raw wallet build, sign, and broadcast helpers leave TxLog writes and input reservations to the caller. Pass an optional `metadata` object with JSON-compatible values to `makeSignSend()`, `makeSignSendTransaction()`, `makeSignTransaction()`, or `sweepSignSend()`. The wallet saves it on the new TxLog row in the wallet cache.

## transaction sending

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

See the [reorg handling test](typescript/tests/acceptance/reorg_handling.test.ts) for a regtest reorg example.

See the [escrow test](typescript/tests/acceptance/escrow.test.ts) described in detail [here](https://monerochan.news/article/19).

See the [acceptance test](typescript/tests/acceptance/dont_rescan.test.ts) for a full working sync example with mainnet data.

## unpacked build entrypoint

Use the default entrypoint to load the worker and WebAssembly files from the package. With `/unpacked`, copy the worker and `.wasm` files into your build and set their URLs with `configureUnpacked()`.

### build result in dist dir

From the `typescript/` directory, `bun run build` makes these files in `dist` (in addition to the packaged build `xmr3.js` and type definitions):

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

## documentation overview

The Monero Wallet API has a rust part that can be found in the [rust folder](rust). It is compiled to wasm and made accessible to a js runtime (web/bun). The code for that can be found in the [typescript folder](typescript).

A checkout page built with this typescript library is located in [standard-checkout](standard-checkout). It is accessible and dynamic with or without javascript enabled on the client side.

The [walletless checkout](walletless-checkout) verifies signed payments from Tool 001 handover and tracks confirmations with a node.

Documentation can be found in the form of comments in the typescript library.
There is also a dedicated [docs folder](docs) that contains guides and more general context.

[nodes-and-wallets](docs/nodes-and-wallets.md): an overview of the different responsibilities of nodes and wallets

[payment-gateway-guide](docs/payment-gateway-guide.md): checklist for building a payment-gateway

[wasm-memory-management](docs/wasm-memory-management.md): context on web assembly, memory management, concurrency, networking

## developers & reproducing builds

The [typescript readme](typescript/README.md) contains detailed build and build reproduction instructions. This also covers the rust part that is compiled to wasm.
