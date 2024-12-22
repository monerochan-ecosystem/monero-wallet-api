import { wasmFileToBase64 } from './inlineWasmFileMacro.ts' with { type: 'macro' };
const source = wasmFileToBase64()
export const monero_wallet_api_wasm = new Uint8Array(atob(source).split("").map(function(c) {
    return c.charCodeAt(0); }));