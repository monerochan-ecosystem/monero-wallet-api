// unpacked entry for chrome store
// no inlined wasm, no inlined worker code
// consumer copies wasm files and worker file to dist
// then calls configureUnpacked before openWallets
export * from "./xmr3_common";

export {
  setWasmUrls,
  getWasmUrls,
  getMoneroWasmBytes,
  getDkgWasmBytes,
  type WasmUrls,
} from "./wasm-processing/wasmLoader";

export { setWorkerUrl, getWorkerUrl } from "./scanning-syncing/backgroundWorker";

import { setWasmUrls } from "./wasm-processing/wasmLoader";
import { setWorkerUrl } from "./scanning-syncing/backgroundWorker";

export type UnpackedConfig = {
  workerUrl: string;
  moneroWasmUrl: string;
  dkgWasmUrl: string;
};

// set worker url and wasm urls in one call
export function configureUnpacked(config: UnpackedConfig) {
  setWorkerUrl(config.workerUrl);
  setWasmUrls({ monero: config.moneroWasmUrl, dkg: config.dkgWasmUrl });
}
