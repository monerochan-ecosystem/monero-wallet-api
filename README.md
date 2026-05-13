# monero-wallet-api

## quick start

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

// stop scan worker
wallets.stopWorker();
```

See the [acceptance test](typescript/tests/acceptance/dont_rescan.test.ts) for a full working example.

## documentation overview

The Monero Wallet API has a rust part that can be found in the [rust folder](rust). It is compiled to wasm and made accessible to a js runtime (web/bun). The code for that can be found in the [typescript folder](typescript).

A checkout page built with this typescript library is located in [standard-checkout](standard-checkout). It is accessible and dynamic with or without javascript enabled on the client side.
Documentation can be found in the form of comments in the typescript library.
There is also a dedicated [docs folder](docs) that contains guides and more general context.

[nodes-and-wallets](docs/nodes-and-wallets.md): an overview of the different responsibilities of nodes and wallets

[payment-gateway-guide](docs/payment-gateway-guide.md): checklist for building a payment-gateway

[wasm-memory-management](docs/wasm-memory-management.md): context on web assembly, memory management, concurrency, networking

## developers & reproducing builds

The [typescript readme](typescript/README.md) contains detailed build and build reproduction instructions. This also covers the rust part that is compiled to wasm.
