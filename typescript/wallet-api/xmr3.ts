// packed entry, uses inlined wasm and worker code
// this file injects inlined bytes into loaders
// internal code imports from xmr3_common to avoid cycles
import { monero_wallet_api_wasm, frost_dkg_wasm } from "./wasm-processing/wasmFile";
import { setInlineWasm } from "./wasm-processing/wasmLoader";
import { workerMainCode } from "./scanning-syncing/worker-entrypoints/worker";
import { setInlineWorkerCode } from "./scanning-syncing/backgroundWorker";

setInlineWasm(monero_wallet_api_wasm, frost_dkg_wasm);
setInlineWorkerCode(workerMainCode);

export * from "./xmr3_common";
